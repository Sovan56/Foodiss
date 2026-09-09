import mongoose from 'mongoose';
import { FoodOrder, FoodSettings } from '../models/order.model.js';
// import { paymentSnapshotFromOrder } from './foodOrderPayment.service.js';
import { logger } from '../../../../utils/logger.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../../delivery/models/deliveryPartner.model.js';
import { FoodZone } from '../../admin/models/zone.model.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../../../../core/auth/errors.js';
import { buildPaginationOptions, buildPaginatedResult } from '../../../../utils/helpers.js';
import { FoodOffer } from '../../admin/models/offer.model.js';
import { FoodOfferUsage } from '../../admin/models/offerUsage.model.js';
import { FoodDeliveryCommissionRule } from '../../admin/models/deliveryCommissionRule.model.js';
import { FoodRestaurantCommission } from '../../admin/models/restaurantCommission.model.js';
import { FoodBusinessSettings } from '../../admin/models/businessSettings.model.js';
import { FoodTransaction } from '../models/foodTransaction.model.js';
import { FoodSupportTicket } from '../../user/models/supportTicket.model.js';
import { config } from '../../../../config/env.js';
import {
    createRazorpayOrder,
    verifyPaymentSignature,
    getRazorpayKeyId,
    isRazorpayConfigured,
    initiateRazorpayRefund,
    fetchRazorpayPayment
} from '../helpers/razorpay.helper.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';
import { fetchPolyline } from '../utils/googleMaps.js';
import { getFirebaseDB } from '../../../../config/firebase.js';
import * as foodTransactionService from './foodTransaction.service.js';
import * as userWalletService from '../../user/services/userWallet.service.js';
import { isFeatureEnabled, FEATURE_KEYS } from '../../admin/services/featureSettings.service.js';
import {
  calculateOrderPricing,
  calculateRiderEarning,
  getDeliveryDistanceKm,
  loadActiveFeeSettings,
  loadRestaurantForOrdering,
  assertRestaurantOpenForOrdering,
} from './order-pricing.service.js';
import { normalizeDeliveryAddress } from '../../shared/geo.utils.js';
import * as dispatchService from './order-dispatch.service.js';
import * as deliveryService from './order-delivery.service.js';
import * as paymentService from './order-payment.service.js';
import {
  enqueueOrderEvent,
  haversineKm,
  generateFourDigitDeliveryOtp,
  sanitizeOrderForExternal,
  sanitizeOrderForDeliveryPartner,
  emitDeliveryDropOtpToUser,
  notifyOwnersSafely,
  notifyOwnerSafely,
  buildOrderIdentityFilter,
  toGeoPoint,
  pushStatusHistory,
  normalizeOrderForClient,
  applyAggregateRating,
  buildDeliverySocketPayload,
  notifyRestaurantNewOrder,
  isStatusAdvance,
  STATUS_PRIORITY,
} from './order.helpers.js';




const COMMISSION_CACHE_MS = 10 * 1000;
let commissionRulesCache = null;
let commissionRulesLoadedAt = 0;
const ORDER_ACCEPTANCE_WINDOW_SECONDS = 240;

function normalizeAcceptanceWindowSeconds(minutes) {
  const numeric = Number(minutes);
  if (!Number.isFinite(numeric)) return ORDER_ACCEPTANCE_WINDOW_SECONDS;
  const roundedMinutes = Math.round(numeric);
  if (roundedMinutes < 1 || roundedMinutes > 20) return ORDER_ACCEPTANCE_WINDOW_SECONDS;
  return roundedMinutes * 60;
}

async function getOrderAcceptanceWindowSeconds() {
  try {
    const settings = await FoodBusinessSettings.findOne()
      .select('orderAcceptanceTimeMinutes')
      .lean();
    return normalizeAcceptanceWindowSeconds(settings?.orderAcceptanceTimeMinutes);
  } catch (err) {
    logger.warn(`Failed to load order acceptance setting: ${err?.message || err}`);
    return ORDER_ACCEPTANCE_WINDOW_SECONDS;
  }
}

const PENDING_PAYMENT_TTL_MS = 30 * 60 * 1000;

function isAwaitingOnlinePaymentMethod(paymentMethod) {
  const method = String(paymentMethod || "").toLowerCase();
  return method === "razorpay" || method === "card";
}

async function incrementCouponUsageForOrder(order, userId) {
  const couponCode = order?.pricing?.couponCode
    ? String(order.pricing.couponCode).trim().toUpperCase()
    : "";
  if (!couponCode) return;
  // A stored code with no applied discount means the coupon was rejected at
  // pricing time — don't consume the user's/offer's usage allowance for it.
  if (!(Number(order?.pricing?.discount) > 0)) return;

  try {
    const offer = await FoodOffer.findOne({ couponCode }).lean();
    if (offer) {
      // Conditional increment so concurrent orders cannot push usedCount past usageLimit.
      const incrementResult = await FoodOffer.updateOne(
        {
          _id: offer._id,
          $or: [
            { usageLimit: { $in: [0, null] } },
            { usageLimit: { $exists: false } },
            { $expr: { $lt: [{ $ifNull: ["$usedCount", 0] }, "$usageLimit"] } },
          ],
        },
        { $inc: { usedCount: 1 } },
      );
      if (incrementResult.modifiedCount === 0 && Number(offer.usageLimit) > 0) {
        // Payment is already processed at this point, so honor the discount but flag the overflow.
        logger.warn(
          `Coupon ${couponCode} reached usage limit before increment for order ${order?._id}; discount honored.`,
        );
      }
      await FoodOfferUsage.updateOne(
        { offerId: offer._id, userId: toObjectId(userId, "User ID") },
        { $inc: { count: 1 }, $set: { lastUsedAt: new Date() } },
        { upsert: true },
      );
    }
  } catch (err) {
    logger.error(`Coupon usage update failed: ${err.message}`);
  }
}

async function deletePendingPaymentOrder(orderLike) {
  if (!orderLike?._id) return false;
  if (String(orderLike.orderStatus || "").toLowerCase() !== "pending_payment") return false;

  const payStatus = String(orderLike.payment?.status || "").toLowerCase();
  if (payStatus === "paid" || payStatus === "refunded") return false;

  await Promise.all([
    FoodSupportTicket.updateMany(
      { orderId: orderLike._id },
      { $set: { orderId: null } },
    ),
    FoodTransaction.deleteOne({
      $or: [
        { orderId: orderLike._id },
        { orderReadableId: String(orderLike._id.toString()) },
      ],
    }),
    FoodOrder.deleteOne({ _id: orderLike._id }),
  ]);
  return true;
}

let lastExpiredCleanupAt = 0;
const EXPIRE_CLEANUP_INTERVAL_MS = 60_000;

async function expireStalePendingPaymentOrders() {
  const now = Date.now();
  if (now - lastExpiredCleanupAt < EXPIRE_CLEANUP_INTERVAL_MS) return;
  lastExpiredCleanupAt = now;

  const cutoff = new Date(Date.now() - PENDING_PAYMENT_TTL_MS);
  const stale = await FoodOrder.find({
    orderStatus: "pending_payment",
    // 'failed' covers orders rejected by payment amount verification.
    "payment.status": { $in: ["created", "pending", "failed"] },
    createdAt: { $lte: cutoff },
  })
    .select("_id orderStatus payment")
    .lean();

  for (const doc of stale) {
    try {
      await deletePendingPaymentOrder(doc);
    } catch (err) {
      logger.warn(
        `expireStalePendingPaymentOrders cleanup failed for ${doc._id}: ${err?.message || err}`,
      );
    }
  }
}

function buildAcceptanceDeadline(date = new Date(), windowSeconds = ORDER_ACCEPTANCE_WINDOW_SECONDS) {
  const seconds = Number(windowSeconds);
  return new Date(date.getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : ORDER_ACCEPTANCE_WINDOW_SECONDS) * 1000);
}

function buildCancellationRefundDescription(order, cancelledBy = 'system') {
  const orderReadableId = order?.order_id || order?._id;
  switch (String(cancelledBy || '').toLowerCase()) {
    case 'user':
      return `Refund for cancelled order #${orderReadableId}`;
    case 'restaurant':
      return `Refund for order #${orderReadableId} cancelled by restaurant`;
    case 'admin':
      return `Refund for order #${orderReadableId} cancelled by admin`;
    case 'auto_cancel':
    case 'timeout':
    case 'system':
      return `Refund for order #${orderReadableId} auto-cancelled by system`;
    default:
      return `Refund for cancelled order #${orderReadableId}`;
  }
}

async function applyCancellationRefund(order, { cancelledBy = 'system', refundAmount } = {}) {
  if (!order?.payment) {
    return { attempted: false, processed: false, reason: 'missing_payment' };
  }

  const paymentMethod = String(order.payment?.method || 'cash').toLowerCase();
  const paymentStatus = String(order.payment?.status || 'cod_pending').toLowerCase();
  const refundStatus = String(order.payment?.refund?.status || 'none').toLowerCase();
  const amount = Number(refundAmount ?? order?.pricing?.total ?? order?.payment?.amountDue ?? 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { attempted: false, processed: false, reason: 'invalid_amount' };
  }

  if (paymentMethod === 'cash' || paymentMethod === 'cod') {
    return { attempted: false, processed: false, reason: 'cash_payment' };
  }

  if (paymentStatus === 'refunded' || refundStatus === 'processed') {
    return { attempted: false, processed: true, reason: 'already_refunded', method: paymentMethod };
  }

  if (paymentStatus !== 'paid') {
    return { attempted: false, processed: false, reason: `payment_status_${paymentStatus || 'unknown'}`, method: paymentMethod };
  }

  if (paymentMethod === 'razorpay') {
    const paymentId = String(order.payment?.razorpay?.paymentId || '').trim();
    if (!paymentId) {
      order.payment.refund = {
        status: 'failed',
        amount,
      };
      return { attempted: true, processed: false, reason: 'missing_razorpay_payment_id', method: paymentMethod };
    }

    const refundResult = await initiateRazorpayRefund(paymentId, amount);
    if (refundResult.success) {
      order.payment.status = 'refunded';
      order.payment.refund = {
        status: 'processed',
        amount,
        refundId: refundResult.refundId,
        processedAt: new Date(),
      };
      return { attempted: true, processed: true, method: paymentMethod, refundId: refundResult.refundId };
    }

    order.payment.refund = {
      status: 'failed',
      amount,
    };
    return {
      attempted: true,
      processed: false,
      reason: refundResult.error || 'razorpay_refund_failed',
      method: paymentMethod,
    };
  }

  if (paymentMethod === 'wallet') {
    await userWalletService.refundWalletBalance(
      order.userId,
      amount,
      buildCancellationRefundDescription(order, cancelledBy),
      { orderId: order._id, cancelledBy }
    );
    order.payment.status = 'refunded';
    order.payment.refund = {
      status: 'processed',
      amount,
      processedAt: new Date(),
    };
    return { attempted: true, processed: true, method: paymentMethod };
  }

  return { attempted: false, processed: false, reason: `unsupported_method_${paymentMethod}`, method: paymentMethod };
}

async function expireUnacceptedOrders(filter = {}) {
  const now = new Date();
  const baseFilter = {
    orderStatus: { $in: ["created", "confirmed"] },
    acceptanceDeadlineAt: { $ne: null, $lte: now },
    ...filter,
  };

  const docs = await FoodOrder.find(baseFilter).select("_id orderStatus").lean();
  if (!docs.length) return 0;

  for (const doc of docs) {
    const from = String(doc.orderStatus || "created");
    const updated = await FoodOrder.findOneAndUpdate(
      {
        _id: doc._id,
        orderStatus: { $in: ["created", "confirmed"] },
        acceptanceDeadlineAt: { $ne: null, $lte: now },
      },
      {
        $set: {
          orderStatus: "cancelled_by_restaurant",
          note: "Not accepted by restaurant",
        },
        $push: {
          statusHistory: {
            at: now,
            byRole: "SYSTEM",
            from,
            to: "cancelled_by_restaurant",
            note: "Not accepted by restaurant",
          },
        },
      },
      { new: true },
    );

    if (!updated) continue;

    try {
      await applyCancellationRefund(updated, { cancelledBy: 'auto_cancel' });
      await updated.save();
    } catch (err) {
      logger.warn(`expireUnacceptedOrders refund failed for ${updated._id}: ${err?.message || err}`);
    }

    try {
      const io = getIO();
      if (io) {
        const payload = {
          orderMongoId: updated._id?.toString?.(),
          orderId: updated._id.toString(),
          orderStatus: updated.orderStatus,
          note: "Not accepted by restaurant",
          message: "Order was not accepted by restaurant in time.",
        };
        io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
        io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", payload);
      }
    } catch (err) {
      logger.warn(`expireUnacceptedOrders socket emit failed: ${err?.message || err}`);
    }
  }

  return docs.length;
}

export async function expireUnacceptedOrderById(orderMongoId) {
  if (!orderMongoId || !mongoose.Types.ObjectId.isValid(String(orderMongoId))) {
    return 0;
  }
  return expireUnacceptedOrders({ _id: new mongoose.Types.ObjectId(String(orderMongoId)) });
}

async function getActiveCommissionRules() {
  const now = Date.now();
  if (
    commissionRulesCache &&
    now - commissionRulesLoadedAt < COMMISSION_CACHE_MS
  ) {
    return commissionRulesCache;
  }
  const list = await FoodDeliveryCommissionRule.find({
    status: { $ne: false },
  }).lean();
  commissionRulesCache = list || [];
  commissionRulesLoadedAt = now;
  return commissionRulesCache;
}

// 🗑️ Moved to foodTransaction.service.js to centralize finance logic.


// Rider earnings use deliveryBoyBasePay / deliveryBoyPerKm from admin fee ranges (see order-pricing.service.js).

/** Append-only food_order_payments row; never blocks main flow on failure */
// 🗑️ Deprecated in favor of FoodTransaction system.

// ----- Settings -----
export async function getDispatchSettings() {
  return dispatchService.getDispatchSettings();
}

export async function updateDispatchSettings(dispatchMode, adminId) {
  return dispatchService.updateDispatchSettings(dispatchMode, adminId);
}

// ----- Calculate (validation + return pricing from payload) -----
export async function calculateOrder(userId, dto) {
  const at = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
  return calculateOrderPricing(userId, dto, {
    at: Number.isNaN(at.getTime()) ? new Date() : at,
  });
}

// Helper to safely convert string to ObjectId or throw ValidationError (400)
function toObjectId(id, fieldName = 'ID') {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
    throw new ValidationError(`Invalid ${fieldName} format`);
  }
  return new mongoose.Types.ObjectId(id);
}

// ----- Create order -----
export async function createOrder(userId, dto) {
  try {
    const restaurantId = toObjectId(dto.restaurantId, 'Restaurant ID');
    const restaurant = await loadRestaurantForOrdering(restaurantId);

    const orderAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    if (dto.scheduledAt && Number.isNaN(orderAt.getTime())) {
      throw new ValidationError('Invalid scheduled time');
    }
    assertRestaurantOpenForOrdering(restaurant, orderAt);

    const settings = await getDispatchSettings();
    const dispatchMode = settings.dispatchMode;

    const deliveryAddress = normalizeDeliveryAddress({
      label: dto.address?.label || "Home",
      name: dto.address?.name || dto.address?.fullName || dto.customerName || "",
      fullName: dto.address?.fullName || dto.address?.name || dto.customerName || "",
      street: dto.address?.street || "",
      additionalDetails: dto.address?.additionalDetails || "",
      city: dto.address?.city || "",
      state: dto.address?.state || "",
      zipCode: dto.address?.zipCode || "",
      phone: dto.address?.phone || "",
      ...(dto.address || {}),
    });

    const paymentMethod =
      dto.paymentMethod === "card" ? "razorpay" : dto.paymentMethod;
    const isCash = paymentMethod === "cash";
    const isWallet = paymentMethod === "wallet";

    if (isCash) {
      const codEnabled = await isFeatureEnabled(FEATURE_KEYS.COD_CONTROL, true);
      if (!codEnabled) {
        throw new ValidationError("Cash on Delivery is currently unavailable. Please pay online.");
      }
    }

    const pricingResult = await calculateOrderPricing(
      userId,
      {
        restaurantId: String(restaurantId),
        items: dto.items || [],
        deliveryAddress,
        couponCode: dto.pricing?.couponCode || undefined,
        deliveryMode: dto.deliveryMode || "basic",
        zoneId: dto.zoneId ? String(dto.zoneId) : (restaurant.zoneId ? String(restaurant.zoneId) : undefined),
      },
      { at: orderAt, restaurant, skipAvailabilityCheck: true },
    );

    const resolvedItems = pricingResult.items || [];
    const normalizedPricing = {
      subtotal: Number(pricingResult.pricing?.subtotal) || 0,
      tax: Number(pricingResult.pricing?.tax) || 0,
      packagingFee: Number(pricingResult.pricing?.packagingFee) || 0,
      deliveryFee: Number(pricingResult.pricing?.deliveryFee) || 0,
      deliverySurge: Number(pricingResult.pricing?.deliverySurge) || 0,
      deliverySurgeType: pricingResult.pricing?.deliverySurgeType || 'none',
      deliverySurgeValue: Number(pricingResult.pricing?.deliverySurgeValue) || 0,
      deliveryFeeGst: Number(pricingResult.pricing?.deliveryFeeGst) || 0,
      platformFee: Number(pricingResult.pricing?.platformFee) || 0,
      quickDeliveryFee: Number(pricingResult.pricing?.quickDeliveryFee) || 0,
      deliveryMode:
        pricingResult.pricing?.deliveryMode === "quick" || dto.deliveryMode === "quick"
          ? "quick"
          : "basic",
      discount: Number(pricingResult.pricing?.discount) || 0,
      couponCode: pricingResult.pricing?.couponCode
        ? String(pricingResult.pricing.couponCode).trim().toUpperCase()
        : null,
      total: Number(pricingResult.pricing?.total) || 0,
      currency: String(pricingResult.pricing?.currency || "INR"),
      // Same road distance source as cart preview / delivery Rest→User.
      distanceKm: Number.isFinite(Number(pricingResult.pricing?.distanceKm))
        ? Number(pricingResult.pricing.distanceKm)
        : null,
      roadDistanceKm: Number.isFinite(Number(pricingResult.pricing?.roadDistanceKm))
        ? Number(pricingResult.pricing.roadDistanceKm)
        : null,
      straightLineDistanceKm: Number.isFinite(
        Number(pricingResult.pricing?.straightLineDistanceKm),
      )
        ? Number(pricingResult.pricing.straightLineDistanceKm)
        : null,
    };

    if (!Number.isFinite(normalizedPricing.total) || normalizedPricing.total <= 0) {
      throw new ValidationError("Order total must be greater than zero");
    }

    normalizedPricing.total = Math.round(normalizedPricing.total * 100) / 100;

    const payment = {
      method: paymentMethod,
      status: isCash ? "cod_pending" : isWallet ? "paid" : "created",
      amountDue: normalizedPricing.total || 0,
      razorpay: {},
      qr: {},
    };

    // Reuse pricing distance (already road-preferred) — do not call Directions again.
    let distanceKm = Number.isFinite(Number(normalizedPricing.distanceKm))
      ? Number(normalizedPricing.distanceKm)
      : await getDeliveryDistanceKm(restaurant, deliveryAddress);
    if (Number.isFinite(distanceKm)) {
      distanceKm = Number(distanceKm.toFixed(2));
    } else {
      distanceKm = null;
    }
    if (Number.isFinite(distanceKm)) {
      normalizedPricing.distanceKm = distanceKm;
      normalizedPricing.roadDistanceKm = distanceKm;
    }

    const feeSettings = await loadActiveFeeSettings();
    const deliverySurge = Number(normalizedPricing.deliverySurge) || 0;
    let riderEarning = calculateRiderEarning(feeSettings, distanceKm, deliverySurge) || 0;
    
    // Non-blocking Rain Incentive check
    let rainIncentiveResult = null;
    try {
      const { calculateRainIncentive } = await import('./order-pricing.service.js');
      const lat = deliveryAddress?.latitude ?? deliveryAddress?.lat;
      const lng = deliveryAddress?.longitude ?? deliveryAddress?.lng;
      rainIncentiveResult = await calculateRainIncentive(riderEarning, lat, lng);
      if (rainIncentiveResult && rainIncentiveResult.rainIncentiveAmount > 0) {
        riderEarning += rainIncentiveResult.rainIncentiveAmount;
      }
    } catch (e) {
      logger.warn(`Failed to apply rain incentive for order creation: ${e.message}`);
    }

    // Calculate restaurant commission from subtotal
    let restaurantCommission = 0;
    try {
      const snapshot = await foodTransactionService.getRestaurantCommissionSnapshot({
        pricing: normalizedPricing,
        restaurantId: restaurantId
      });
      restaurantCommission = Number(snapshot?.commissionAmount) || 0;
    } catch (err) {
      logger.error(`Commission calculation failed for order: ${err.message}`);
    }

    normalizedPricing.restaurantCommission = restaurantCommission;

    // Provisional value; synced to the transaction's platformNetProfit (which also
    // accounts for the admin discount share) once the initial transaction is created.
    const platformProfit =
      (Number.isFinite(normalizedPricing.deliveryFee) ? normalizedPricing.deliveryFee : 0) +
      (Number.isFinite(normalizedPricing.deliverySurge) ? normalizedPricing.deliverySurge : 0) +
      (Number.isFinite(normalizedPricing.deliveryFeeGst) ? normalizedPricing.deliveryFeeGst : 0) +
      (Number.isFinite(normalizedPricing.platformFee) ? normalizedPricing.platformFee : 0) +
      restaurantCommission -
      riderEarning;

    const isAwaitingOnlinePayment = isAwaitingOnlinePaymentMethod(paymentMethod);
    const initialStatus = isAwaitingOnlinePayment ? "pending_payment" : "created";
    const acceptanceWindowSeconds = await getOrderAcceptanceWindowSeconds();

    const order = new FoodOrder({
      userId: toObjectId(userId, 'User ID'),
      restaurantId: restaurantId,
      zoneId: dto.zoneId ? toObjectId(dto.zoneId, 'Zone ID') : toObjectId(restaurant.zoneId, 'Restaurant Zone ID'),
      items: resolvedItems.map(item => ({
        ...item,
        itemId: toObjectId(item.itemId, 'Item ID')
      })),
      deliveryAddress,
      customerName: String(dto.customerName || deliveryAddress.fullName || ""),
      customerPhone: String(dto.customerPhone || deliveryAddress.phone || ""),
      pricing: normalizedPricing,
      payment,
      orderStatus: initialStatus,
      acceptanceWindowSeconds,
      acceptanceDeadlineAt:
        initialStatus === "created" ? buildAcceptanceDeadline(new Date(), acceptanceWindowSeconds) : null,
      dispatch: { modeAtCreation: dispatchMode, status: "unassigned" },
      statusHistory: [
        {
          at: new Date(),
          byRole: "SYSTEM",
          from: "",
          to: initialStatus,
          note: initialStatus === "pending_payment" ? "Order created, awaiting payment" : "Order placed",
        },
      ],
      note: String(dto.note || ""),
      deliveryInstructions: String(dto.deliveryInstructions || ""),
      sendCutlery: dto.sendCutlery !== false,
      deliveryFleet: String(dto.deliveryFleet || "standard"),
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      initialDeliverySurge: deliverySurge,
      riderEarning: Number(riderEarning) || 0,
      rainIncentiveApplied: rainIncentiveResult?.rainIncentiveApplied || false,
      rainIncentiveType: rainIncentiveResult?.rainIncentiveType || null,
      rainIncentiveValue: rainIncentiveResult?.rainIncentiveValue || 0,
      rainIncentiveAmount: rainIncentiveResult?.rainIncentiveAmount || 0,
      platformProfit: Number(platformProfit) || 0,
      cancellationReason: "",
    });

    let razorpayPayload = null;

    if (paymentMethod === "razorpay" && isRazorpayConfigured()) {
      const amountPaise = Math.round((normalizedPricing.total || 0) * 100);
      if (amountPaise < 100)
        throw new ValidationError("Amount too low for online payment");
      try {
        const rzOrder = await createRazorpayOrder(amountPaise, "INR", order._id.toString());
        razorpayPayload = {
          key: getRazorpayKeyId(),
          orderId: rzOrder.id,
          amount: rzOrder.amount,
          currency: rzOrder.currency || "INR",
        };
        payment.razorpay = { orderId: rzOrder.id, paymentId: "", signature: "" };
        payment.status = "created";
        // Update order payment state before saving
        order.payment = payment;
      } catch (err) {
        logger.error(`Razorpay order creation failed: ${err.message}`);
        throw new ValidationError(err?.message || "Payment gateway error");
      }
    }

    await order.save();

    if (!isAwaitingOnlinePayment) {
      void addOrderJob(
        {
          action: "ORDER_ACCEPTANCE_TIMEOUT_CHECK",
          orderMongoId: order._id?.toString?.(),
          orderId: order._id.toString(),
        },
        {
          delay: acceptanceWindowSeconds * 1000,
          removeOnComplete: true,
          removeOnFail: true,
          jobId: `order-accept-timeout-${order._id?.toString?.()}`,
        },
      ).catch((err) => {
        logger.warn(`Failed to enqueue acceptance timeout check: ${err?.message || err}`);
      });
    }

    if (isWallet) {
      try {
        await userWalletService.deductWalletBalance(userId, order.pricing.total, `Payment for order #${order.order_id || order._id}`, { orderId: order._id });
      } catch (err) {
        await FoodOrder.deleteOne({ _id: order._id });
        throw err;
      }
    }

    // Phase 2: Create initial transaction after payment is confirmed (online) or immediately (cash/wallet).
    if (!isAwaitingOnlinePayment) {
      try {
        const transaction = await foodTransactionService.createInitialTransaction(order);
        if (transaction && Number.isFinite(Number(transaction.amounts?.platformNetProfit))) {
          order.platformProfit = Number(transaction.amounts.platformNetProfit);
          await FoodOrder.updateOne(
            { _id: order._id },
            { $set: { platformProfit: order.platformProfit } },
          );
        }
      } catch (err) {
        logger.error(`[CRITICAL] Initial transaction failed for order ${order._id}: ${err.message}`);
      }
    }

    // Realtime + push notifications.
    try {
      await notifyOwnersSafely([{ ownerType: "USER", ownerId: userId }], {
        title: isAwaitingOnlinePayment
          ? "Complete Payment to Confirm Order"
          : "Order Confirmed! 🍔",
        body: isAwaitingOnlinePayment
          ? `Order #${order.order_id || order._id} is created. Please complete payment to send it to ${restaurant.restaurantName || "the restaurant"}.`
          : `Your order #${order.order_id || order._id} from ${restaurant.restaurantName || "the restaurant"} has been placed successfully.`,
        image: "https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png",
        data: {
          type: isAwaitingOnlinePayment ? "order_created_pending_payment" : "order_created",
          orderId: String(order._id),
          orderMongoId: order._id.toString(),
          link: `/food/user/orders/${order._id.toString()}`,
        },
      });

      if (!isAwaitingOnlinePayment) {
        await notifyRestaurantNewOrder(order);
      }
    } catch (err) {
      logger.warn(`Notifications failed for order ${order._id}: ${err.message}`);
    }

    if (!isAwaitingOnlinePayment) {
      await incrementCouponUsageForOrder(order, userId);
    }

    const saved = normalizeOrderForClient(order);
    return { order: saved, razorpay: razorpayPayload };
  } catch (err) {
    logger.error(`Order placement error: ${err.message}`, { stack: err.stack, userId, dto });
    if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError) {
      throw err;
    }
    // Transform system errors to Generic validation error with 500 logging
    throw new ValidationError(err.message || "Something went wrong while placing your order. Please try again.");
  }
}

// ----- Verify payment -----
export async function verifyPayment(userId, dto) {
  const identity = buildOrderIdentityFilter(dto.orderId);
  if (!identity) throw new ValidationError("Order id required");

  const order = await FoodOrder.findOne({
    ...identity,
    userId: new mongoose.Types.ObjectId(userId),
  });
  if (!order) throw new NotFoundError("Order not found");
  if (order.payment.status === "paid")
    return { order: normalizeOrderForClient(order), payment: order.payment };

  if (String(dto.razorpayOrderId) !== String(order.payment?.razorpay?.orderId || "")) {
    throw new ValidationError("Payment verification failed");
  }

  const valid = verifyPaymentSignature(
    dto.razorpayOrderId,
    dto.razorpayPaymentId,
    dto.razorpaySignature,
  );
  if (!valid) throw new ValidationError("Payment verification failed");

  // Cross-check the actual captured payment against the order: correct Razorpay
  // order linkage, an acceptable status, and the exact amount in paise.
  // Fail closed — the webhook remains the recovery path for transient errors.
  let rzPayment;
  try {
    rzPayment = await fetchRazorpayPayment(dto.razorpayPaymentId);
  } catch (err) {
    logger.error(`Razorpay payment fetch failed for order ${order._id}: ${err?.message || err}`);
    throw new ValidationError("Payment verification failed. Please retry in a moment.");
  }
  const expectedPaise = Math.round((Number(order.pricing?.total) || 0) * 100);
  const paidPaise = Number(rzPayment?.amount);
  const rzStatus = String(rzPayment?.status || "").toLowerCase();
  if (
    String(rzPayment?.order_id || "") !== String(order.payment.razorpay.orderId) ||
    !["captured", "authorized"].includes(rzStatus) ||
    !Number.isFinite(paidPaise) ||
    paidPaise !== expectedPaise
  ) {
    order.payment.status = "failed";
    pushStatusHistory(order, {
      byRole: "SYSTEM",
      byId: null,
      from: order.orderStatus,
      to: order.orderStatus,
      note: `Payment rejected: amount/order mismatch (paid ${paidPaise} paise, expected ${expectedPaise} paise, status ${rzStatus})`,
    });
    await order.save();
    logger.error(
      `Payment amount mismatch for order ${order._id}: paid ${paidPaise} paise, expected ${expectedPaise} paise, rz order ${rzPayment?.order_id}, status ${rzStatus}`,
    );
    throw new ValidationError("Payment verification failed");
  }

  order.payment.status = "paid";
  order.payment.razorpay.paymentId = dto.razorpayPaymentId;
  order.payment.razorpay.signature = dto.razorpaySignature;
  
  const from = order.orderStatus;
  const acceptanceWindowSeconds = await getOrderAcceptanceWindowSeconds();
  order.orderStatus = "created";
  order.acceptanceWindowSeconds = acceptanceWindowSeconds;
  order.acceptanceDeadlineAt = buildAcceptanceDeadline(new Date(), acceptanceWindowSeconds);

  pushStatusHistory(order, {
    byRole: "USER",
    byId: userId,
    from: from,
    to: "created",
    note: "Payment verified, order confirmed",
  });
  await order.save();
  void addOrderJob(
    {
      action: "ORDER_ACCEPTANCE_TIMEOUT_CHECK",
      orderMongoId: order._id?.toString?.(),
      orderId: order._id.toString(),
    },
    {
      delay: acceptanceWindowSeconds * 1000,
      removeOnComplete: true,
      removeOnFail: true,
      jobId: `order-accept-timeout-${order._id?.toString?.()}`,
    },
  ).catch((err) => {
    logger.warn(`Failed to enqueue acceptance timeout check: ${err?.message || err}`);
  });

  try {
    const transaction = await foodTransactionService.createInitialTransaction(order);
    if (transaction && Number.isFinite(Number(transaction.amounts?.platformNetProfit))) {
      order.platformProfit = Number(transaction.amounts.platformNetProfit);
      await FoodOrder.updateOne(
        { _id: order._id },
        { $set: { platformProfit: order.platformProfit } },
      );
    }
  } catch (err) {
    logger.error(`[CRITICAL] Initial transaction failed for order ${order._id}: ${err.message}`);
  }

  await incrementCouponUsageForOrder(order, userId);

  await foodTransactionService.updateTransactionStatus(order._id, 'captured', {
    status: 'captured',
    razorpayPaymentId: dto.razorpayPaymentId,
    razorpaySignature: dto.razorpaySignature,
    recordedByRole: "USER",
    recordedById: new mongoose.Types.ObjectId(userId)
  });

  // After online payment is verified, now notify restaurant about the new order.
  await notifyRestaurantNewOrder(order);

  // Notify Customer about payment success
  await notifyOwnersSafely([{ ownerType: "USER", ownerId: userId }], {
    title: "Payment Successful! ✅",
    body: `We have received your payment of ₹${order.payment.amountDue} for Order #${order._id.toString()}.`,
    image: "https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png",
    data: {
      type: "payment_success",
      orderId: String(order._id.toString()),
      orderMongoId: String(order._id),
    },
  });


  return { order: normalizeOrderForClient(order), payment: order.payment };
}

export async function abandonOnlinePaymentOrder(userId, orderId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const order = await FoodOrder.findOne({
    ...identity,
    userId: new mongoose.Types.ObjectId(userId),
  });
  if (!order) throw new NotFoundError("Order not found");
  if (String(order.orderStatus || "").toLowerCase() !== "pending_payment") {
    throw new ValidationError("Order is not awaiting payment");
  }

  const deleted = await deletePendingPaymentOrder(order);
  if (!deleted) throw new ValidationError("Could not abandon payment");

  return { deleted: true, orderId: order._id.toString() };
}

// ----- Auto-assign -----

/**
 * Start or continue a smart cascading dispatch.
 * @param {string} orderId - Mongo ID of the order.
 * @param {object} options - Options (retry count, etc)
 */
export async function tryAutoAssign(orderId, options = {}) {
    return dispatchService.tryAutoAssign(orderId, options);
}

/**
 * Triggered by worker after 60 seconds of zero response.
 */
export async function processDispatchTimeout(orderId, partnerId, options = {}) {
    return dispatchService.processDispatchTimeout(orderId, partnerId, options);
}

// ----- User: list, get, cancel -----
export async function listOrdersUser(userId, query) {
  await expireStalePendingPaymentOrders();
  await expireUnacceptedOrders();
  const { page, limit, skip } = buildPaginationOptions(query);
  const filter = { 
    userId: new mongoose.Types.ObjectId(userId),
    orderStatus: { $ne: 'pending_payment' }
  };
  const [docs, total] = await Promise.all([
    FoodOrder.find(filter)
      .populate(
        "restaurantId",
        "restaurantName profileImage area city location rating totalRatings",
      )
      .populate("dispatch.deliveryPartnerId", "name phone rating totalRatings")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    FoodOrder.countDocuments(filter),
  ]);
  return buildPaginatedResult({
    docs: docs.map((doc) => normalizeOrderForClient(doc)),
    total,
    page,
    limit,
  });
}

/**
 * Full money split + audit history for the admin order detail view.
 * Sourced from FoodTransaction (queried by orderId — the order backlink is best-effort).
 */
async function buildAdminTransactionView(orderMongoId) {
  try {
    const tx = await FoodTransaction.findOne({ orderId: orderMongoId }).lean();
    if (!tx) return null;
    return {
      status: tx.status || null,
      paymentMethod: tx.paymentMethod || tx.payment?.method || null,
      amounts: tx.amounts || null,
      settlement: tx.settlement || null,
      history: Array.isArray(tx.history)
        ? tx.history.map((entry) => ({
            kind: entry.kind,
            amount: entry.amount ?? null,
            at: entry.at || null,
            note: entry.note || "",
            byRole: entry.recordedBy?.role || null,
          }))
        : [],
    };
  } catch (err) {
    logger.warn(`buildAdminTransactionView failed for order ${orderMongoId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Restaurant-safe earnings breakdown for the restaurant order detail view.
 * Never includes platform economics (platformNetProfit, riderShare, adminDiscountShare).
 */
function buildRestaurantFinanceViewSync(order, tx = null) {
  const pricing = order?.pricing || {};
  const subtotal = Number(pricing.subtotal) || 0;
  const packagingFee = Number(pricing.packagingFee) || 0;

  if (tx?.amounts) {
    return {
      itemTotal: subtotal,
      packagingFee,
      commission: Number(tx.amounts.restaurantCommission) || 0,
      restaurantDiscountShare: Number(tx.amounts.restaurantDiscountShare) || 0,
      discount: Number(pricing.discount) || 0,
      taxAmount: Number(tx.amounts.taxAmount ?? pricing.tax) || 0,
      totalCustomerPaid: Number(tx.amounts.totalCustomerPaid ?? pricing.total) || 0,
      netPayout: Number(tx.amounts.restaurantShare) || 0,
      isSettled: Boolean(tx.settlement?.isRestaurantSettled),
      settledAt: tx.settlement?.restaurantSettledAt || null,
    };
  }

  const commission = Number(pricing.restaurantCommission) || 0;
  const netPayout = Math.max(0, Math.round((subtotal + packagingFee - commission) * 100) / 100);
  return {
    itemTotal: subtotal,
    packagingFee,
    commission,
    restaurantDiscountShare: 0,
    discount: Number(pricing.discount) || 0,
    taxAmount: Number(pricing.tax) || 0,
    totalCustomerPaid: Number(pricing.total) || 0,
    netPayout,
    isSettled: false,
    settledAt: null,
  };
}

async function buildRestaurantFinanceView(order) {
  try {
    const tx = await FoodTransaction.findOne({ orderId: order._id }).lean();
    return buildRestaurantFinanceViewSync(order, tx);
  } catch (err) {
    logger.warn(`buildRestaurantFinanceView failed for order ${order?._id}: ${err?.message || err}`);
    return buildRestaurantFinanceViewSync(order, null);
  }
}

export async function getOrderById(
  orderId,
  { userId, restaurantId, deliveryPartnerId, admin } = {},
) {
  await expireUnacceptedOrders();
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");
  const order = await FoodOrder.findOne(identity)
    .populate(
      "restaurantId",
      "restaurantName ownerPhone profileImage area city location rating totalRatings primaryContactNumber",
    )
    .populate("dispatch.deliveryPartnerId", "name fullName phone phoneNumber rating totalRatings profileImage avatar")
    .populate("userId", "name fullName phone email")
    .select("+deliveryOtp")
    .lean();
  if (!order) throw new NotFoundError("Order not found");

  if (admin) {
    const out = normalizeOrderForClient(order);
    out.transaction = await buildAdminTransactionView(order._id);
    return out;
  }

  const orderUserId = order.userId?._id?.toString() || order.userId?.toString();
  const orderRestaurantId = order.restaurantId?._id?.toString() || order.restaurantId?.toString();
  const orderPartnerId = order.dispatch?.deliveryPartnerId?._id?.toString() || order.dispatch?.deliveryPartnerId?.toString();

  if (userId && orderUserId !== userId.toString())
    throw new ForbiddenError("Not your order");
  if (restaurantId && orderRestaurantId !== restaurantId.toString())
    throw new ForbiddenError("Not your restaurant order");
  if (deliveryPartnerId && orderPartnerId !== deliveryPartnerId.toString())
    throw new ForbiddenError("Not assigned to you");

  if (restaurantId) {
    const out = sanitizeOrderForExternal(order);
    out.finance = await buildRestaurantFinanceView(order);
    return out;
  }

  if (deliveryPartnerId) {
    return sanitizeOrderForDeliveryPartner(order);
  }

  if (userId) {
    const drop = order.deliveryVerification?.dropOtp || {};
    const secret = String(order.deliveryOtp || "").trim();
    const out = normalizeOrderForClient(order);
    delete out.deliveryOtp;
    out.deliveryVerification = {
      ...(order.deliveryVerification || {}),
      dropOtp: {
        required: Boolean(drop.required),
        verified: Boolean(drop.verified),
      },
    };
    if (!drop.verified && secret) {
      out.handoverOtp = secret;
    }
    return out;
  }

  return sanitizeOrderForExternal(order);
}

export async function getDropOtpUser(orderId, userId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");
  const order = await FoodOrder.findOne({
    ...identity,
    userId: new mongoose.Types.ObjectId(userId),
  }).select("+deliveryOtp");
  if (!order) throw new NotFoundError("Order not found");

  const phase = order.deliveryState?.currentPhase;
  const status = order.orderStatus;
  const eligiblePhases = ["at_drop", "en_route_to_delivery"];
  const isEligible = eligiblePhases.includes(phase) || status === "picked_up";

  if (!isEligible) {
    throw new ValidationError(
      "Rider is still at the restaurant. Wait for them to pick up your order to see the OTP."
    );
  }

  return { otp: order.deliveryOtp };
}

/**
 * Watchdog: Recovers orders stuck in 'assigned' or 'preparing' status for too long.
 * Should be called on server startup.
 */
export async function recoverStuckOrders() {
  const now = new Date();
  const FIVE_MIN = 5 * 60 * 1000;
  const TWO_MIN = 2 * 60 * 1000;

  try {
    // 1. Stuck in 'assigned' (partner never accepted) for > 2m
    const stuckAssigned = await FoodOrder.find({
      'dispatch.status': 'assigned',
      'dispatch.acceptedAt': { $exists: false },
      'dispatch.assignedAt': { $lt: new Date(now - TWO_MIN) },
      orderStatus: { $nin: ['delivered', 'cancelled_by_user', 'cancelled_by_restaurant'] }
    });

    if (stuckAssigned.length > 0) {
      logger.info(`Watchdog: Healing ${stuckAssigned.length} stuck assigned orders.`);
      for (const order of stuckAssigned) {
        // Reset status to unassigned and re-trigger auto-assign
        order.dispatch.status = 'unassigned';
        order.dispatch.deliveryPartnerId = null;
        await order.save();
        await tryAutoAssign(order._id);
      }
    }

    // 2. Clear old dispatching locks (cleanup in case of crash)
    await FoodOrder.updateMany(
      { 'dispatch.dispatchingAt': { $lt: new Date(now - FIVE_MIN) } },
      { $unset: { 'dispatch.dispatchingAt': '' } }
    );

  } catch (err) {
    logger.error(`Watchdog recovery error: ${err.message}`);
  }
}

export async function resyncState(userId, role) {
  if (role === "USER") {
    const order = await FoodOrder.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      orderStatus: {
        $nin: [
          "delivered",
          "cancelled_by_user",
          "cancelled_by_restaurant",
          "cancelled_by_admin",
        ],
      },
    })
      .select("+deliveryOtp")
      .sort({ createdAt: -1 })
      .lean();

    if (order) {
      const out = normalizeOrderForClient(order);
      // Re-add handover OTP if order is picked up
      if (
        (order.deliveryState?.currentPhase === "at_drop" || order.orderStatus === "picked_up") &&
        !order.deliveryVerification?.dropOtp?.verified &&
        order.deliveryOtp
      ) {
        out.handoverOtp = order.deliveryOtp;
      }
      return { activeOrder: out };
    }
    return { activeOrder: null };
  }

  if (role === "DELIVERY_PARTNER") {
    const order = await FoodOrder.findOne({
      "dispatch.deliveryPartnerId": new mongoose.Types.ObjectId(userId),
      "dispatch.status": { $in: ["assigned", "accepted"] },
      orderStatus: {
        $nin: ["delivered", "cancelled_by_user", "cancelled_by_restaurant"],
      },
    })
      .populate("restaurantId")
      .lean();
    return { activeOrder: order ? sanitizeOrderForDeliveryPartner(order) : null };
  }

  return {};
}

export async function cancelOrder(orderId, userId, reason) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const order = await FoodOrder.findOne({
    ...identity,
    userId: new mongoose.Types.ObjectId(userId),
  });
  if (!order) throw new NotFoundError("Order not found");

  const allowed = ["created"];
  if (!allowed.includes(order.orderStatus))
    throw new ValidationError("Order cannot be cancelled");

  const from = order.orderStatus;
  order.orderStatus = "cancelled_by_user";
  pushStatusHistory(order, {
    byRole: "USER",
    byId: userId,
    from,
    to: "cancelled_by_user",
    note: reason || "",
  });

  const paymentMethod = String(order.payment?.method || "cash").toLowerCase();
  const paymentStatus = String(order.payment?.status || "cod_pending").toLowerCase();
  try {
    await applyCancellationRefund(order, { cancelledBy: 'user' });
  } catch (err) {
    console.error(`Refund processing error for Order ${orderId}:`, err);
    order.payment.refund = { status: "failed", amount: order.pricing.total };
  }

  await order.save();

  enqueueOrderEvent("order_cancelled_by_user", {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    userId,
    reason: reason || "",
  });

  // Sync transaction status
  try {
    const finalPaymentMethod = String(order.payment?.method || paymentMethod || "cash").toLowerCase();
    const finalPaymentStatus = String(order.payment?.status || paymentStatus || "cod_pending").toLowerCase();
    const isOnlinePaid =
      finalPaymentMethod === "razorpay" &&
      (finalPaymentStatus === "paid" || finalPaymentStatus === "refunded");
    await foodTransactionService.updateTransactionStatus(order._id, 'cancelled_by_user', {
        status: isOnlinePaid ? 'refunded' : 'failed',
        note: `Order cancelled by user: ${reason || "No reason"}`,
        recordedByRole: 'USER',
        recordedById: userId
    });
  } catch (err) {
    logger.warn(`cancelOrder transaction sync failed: ${err?.message || err}`);
  }

  // Notify User and Restaurant about the cancellation
  const finalPaymentMethod = String(order.payment?.method || paymentMethod || "cash").toLowerCase();
  const finalPaymentStatus = String(order.payment?.status || paymentStatus || "cod_pending").toLowerCase();
  const isOnlinePaid =
    finalPaymentMethod === "razorpay" &&
    (finalPaymentStatus === "paid" || finalPaymentStatus === "refunded");
  const refundDetail = isOnlinePaid ? ` Your refund of ₹${order.pricing.total} is being processed and will be credited to your original payment method within 5-7 working days.` : "";
  
  await notifyOwnersSafely(
    [
      { ownerType: "USER", ownerId: userId },
      { ownerType: "RESTAURANT", ownerId: order.restaurantId },
    ],
    {
      title: "Order Cancelled ❌",
      body: `Order #${order.order_id || order._id} has been cancelled successfully.${refundDetail}`,
      image: "https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png",
      data: {
        type: "order_cancelled",
        orderId: String(order._id.toString()),
        orderMongoId: String(order._id),
      },
    },
  );

  // Real-time: status update via socket
  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        orderStatus: order.orderStatus,
        message: `Order #${order.order_id || order._id} has been cancelled successfully.${refundDetail}`
      };
      io.to(rooms.user(userId)).emit("order_status_update", payload);
      io.to(rooms.restaurant(order.restaurantId)).emit("order_status_update", payload);
      const adminRoom = rooms.admin ? rooms.admin() : 'admin:orders';
      io.to(adminRoom).emit("order_status_update", payload);
    }
  } catch (err) {
    logger.warn(`cancelOrder socket emit failed: ${err?.message || err}`);
  }

  return normalizeOrderForClient(order);
}

export async function submitOrderRatings(orderId, userId, dto) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const order = await FoodOrder.findOne({
    ...identity,
    userId: new mongoose.Types.ObjectId(userId),
  });
  if (!order) throw new NotFoundError("Order not found");
  if (String(order.orderStatus) !== "delivered") {
    throw new ValidationError("You can rate only delivered orders");
  }

  const hasDeliveryPartner = !!order.dispatch?.deliveryPartnerId;
  if (hasDeliveryPartner && !dto.deliveryPartnerRating) {
    throw new ValidationError("Delivery partner rating is required");
  }

  const restaurantAlreadyRated = Number.isFinite(
    Number(order?.ratings?.restaurant?.rating),
  );
  const deliveryAlreadyRated = Number.isFinite(
    Number(order?.ratings?.deliveryPartner?.rating),
  );
  if (restaurantAlreadyRated || (hasDeliveryPartner && deliveryAlreadyRated)) {
    throw new ValidationError("Ratings already submitted for this order");
  }

  const now = new Date();
  order.ratings = order.ratings || {};
  order.ratings.restaurant = {
    rating: dto.restaurantRating,
    comment: dto.restaurantComment || "",
    ratedAt: now,
  };

  if (hasDeliveryPartner) {
    order.ratings.deliveryPartner = {
      rating: dto.deliveryPartnerRating,
      comment: dto.deliveryPartnerComment || "",
      ratedAt: now,
    };
  }

  await Promise.all([
    applyAggregateRating(
      FoodRestaurant,
      order.restaurantId,
      dto.restaurantRating,
    ),
    hasDeliveryPartner
      ? applyAggregateRating(
          FoodDeliveryPartner,
          order.dispatch.deliveryPartnerId,
          dto.deliveryPartnerRating,
        )
      : Promise.resolve(),
  ]);

    await order.save();
    enqueueOrderEvent('order_ratings_submitted', {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        userId,
        restaurantRating: dto.restaurantRating,
        deliveryPartnerRating: hasDeliveryPartner ? dto.deliveryPartnerRating : null
    });
}

export async function updateOrderInstructions(orderId, userId, instructions) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const order = await FoodOrder.findOne({
    ...identity,
    userId: new mongoose.Types.ObjectId(userId),
  });
  if (!order) throw new NotFoundError("Order not found");
  
  const allowedStatuses = ['created', 'confirmed', 'preparing'];
  if (!allowedStatuses.includes(order.orderStatus)) {
    throw new ValidationError("Instructions can no longer be updated for this order");
  }

  order.deliveryInstructions = String(instructions || "").trim();
  await order.save();
  return order;
}

// ----- Restaurant -----
export async function listOrdersRestaurant(restaurantId, query) {
  await expireUnacceptedOrders({
    restaurantId: new mongoose.Types.ObjectId(restaurantId),
  });
  const { page, limit, skip } = buildPaginationOptions(query);
  const filter = {
    restaurantId: new mongoose.Types.ObjectId(restaurantId),
    $or: [
      { "payment.method": { $in: ["cash", "wallet"] } },
      { "payment.status": { $in: ["paid", "authorized", "captured", "settled", "refunded"] } },
    ],
  };

  const startDateRaw = query?.startDate || query?.from;
  const endDateRaw = query?.endDate || query?.to;
  if (startDateRaw || endDateRaw) {
    const createdAt = {};
    const start = startDateRaw ? new Date(startDateRaw) : null;
    const end = endDateRaw ? new Date(endDateRaw) : null;
    if (start && !Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      createdAt.$gte = start;
    }
    if (end && !Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      createdAt.$lte = end;
    }
    if (Object.keys(createdAt).length > 0) {
      filter.createdAt = createdAt;
    }
  }

  const statusRaw = query?.orderStatus || query?.status;
  if (statusRaw) {
    const statuses = String(statusRaw)
      .split(",")
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    if (statuses.length > 0) {
      filter.orderStatus = { $in: statuses };
    }
  }

  const searchRaw = String(query?.search || query?.orderId || "").trim();
  if (searchRaw) {
    const escaped = searchRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$and = [
      ...(Array.isArray(filter.$and) ? filter.$and : []),
      {
        $or: [
          { orderId: { $regex: escaped, $options: "i" } },
          { order_id: { $regex: escaped, $options: "i" } },
        ],
      },
    ];
  }

  const [docs, total] = await Promise.all([
    FoodOrder.find(filter)
      .populate("userId", "name phone email profileImage")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    FoodOrder.countDocuments(filter),
  ]);

  const orderIds = docs.map((doc) => doc._id);
  const transactions = orderIds.length > 0
    ? await FoodTransaction.find({ orderId: { $in: orderIds } })
        .select("orderId amounts settlement")
        .lean()
    : [];
  const txByOrderId = new Map(
    transactions.map((tx) => [String(tx.orderId), tx]),
  );

  const normalizedOrders = docs.map((doc) => {
    const out = normalizeOrderForClient(doc);
    out.finance = buildRestaurantFinanceViewSync(doc, txByOrderId.get(String(doc._id)) || null);
    return out;
  });

  const paginated = buildPaginatedResult({ docs: normalizedOrders, total, page, limit });
  return {
    ...paginated,
    orders: paginated.data,
    pagination: {
      page: paginated.meta.page,
      limit: paginated.meta.limit,
      total: paginated.meta.total,
      totalPages: paginated.meta.totalPages,
      pages: paginated.meta.totalPages,
    },
  };
}

export async function updateOrderStatusRestaurant(
  orderId,
  restaurantId,
  orderStatus,
  note = "",
) {
  await expireUnacceptedOrders({
    restaurantId: new mongoose.Types.ObjectId(restaurantId),
  });
  const identity = buildOrderIdentityFilter(orderId);
  let order = await FoodOrder.findOne({
    ...identity,
    restaurantId: new mongoose.Types.ObjectId(restaurantId),
  });
  if (!order) throw new NotFoundError("Order not found");

  const targetStatus = String(orderStatus || "").toLowerCase();
  if (targetStatus === "preparing" || targetStatus === "confirmed") {
    const now = new Date();
    const deadline = order.acceptanceDeadlineAt ? new Date(order.acceptanceDeadlineAt) : null;
    if (deadline && deadline.getTime() <= now.getTime()) {
      await expireUnacceptedOrders({ _id: order._id });
      throw new ValidationError("Order acceptance window has expired");
    }
  }
  const from = order.orderStatus;
  if (!isStatusAdvance(from, orderStatus)) {
    throw new ValidationError(
      `Current order status '${from}' is further ahead than '${orderStatus}'. Order cannot be moved backwards.`
    );
  }

  order.orderStatus = orderStatus;

  const normalizedPaymentMethod = String(order.payment?.method || "cash").toLowerCase();
  const prevPaymentStatus = String(order.payment?.status || "cod_pending").toLowerCase();
  if (String(orderStatus) === "delivered" && normalizedPaymentMethod === "cash" && prevPaymentStatus === "cod_pending") {
    // COD should become paid once delivery is completed, even in restaurant-managed status updates.
    order.payment.status = "paid";
  }

  pushStatusHistory(order, {
    byRole: "RESTAURANT",
    byId: restaurantId,
    from,
    to: orderStatus,
    note: note || "",
  });
  await order.save();

  if (String(orderStatus) === "delivered") {
    try {
      const ledgerKind =
        normalizedPaymentMethod === "cash" && prevPaymentStatus === "cod_pending"
          ? "cod_marked_paid_on_delivery"
          : "payment_snapshot_sync";
      await foodTransactionService.updateTransactionStatus(order._id, ledgerKind, {
        status: "captured",
        recordedByRole: "RESTAURANT",
        recordedById: restaurantId,
        note: `Delivery completed from restaurant flow. Prev payment status: ${prevPaymentStatus}`,
      });
    } catch (err) {
      logger.warn(`updateOrderStatusRestaurant delivered transaction sync failed: ${err?.message || err}`);
    }
  }

  // Custom messages / titles for status updates
  let title = `Order ${order._id.toString()} updated`;
  let body = `Status changed to ${String(orderStatus).replace(/_/g, " ")}`;

  if (orderStatus === "confirmed") {
    title = "Order Accepted! 🧑‍🍳";
    body = "The restaurant has accepted your order and is starting to prepare it.";
  } else if (orderStatus === "preparing") {
    title = "Food is being prepared! 🍳";
    body = "Your food is currently being prepared by the restaurant.";
  } else if (orderStatus === "ready_for_pickup") {
    title = "Food is ready! 🛍️";
    body = "Your order is ready and waiting to be picked up.";
  } else if (String(orderStatus).includes("cancel")) {
    const isOnlinePaid = order.payment.method === "razorpay" && (order.payment.status === "paid" || order.payment.status === "refunded");
    const refundDetail = isOnlinePaid ? ` Your refund of ₹${order.pricing.total} is being processed and will be credited to your original payment method within 5-7 working days.` : "";
    
    title = "Order Cancelled ❌";
    body = (note && String(note).trim()) ? note : `Unfortunately, your order has been cancelled by the restaurant.${refundDetail}`;
  }

  // Real-time: status update to restaurant room.
  try {
    const io = getIO();
    if (io) {
      console.log(
        `[DEBUG] Emitting status update to restaurant ${restaurantId} and user ${order.userId}: ${orderStatus}`,
      );
      const payload = {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        orderStatus: order.orderStatus,
        note: order.note || "",
        statusNote: note || "",
        title,
        message: body,
      };
      
      const restRoom = rooms.restaurant(restaurantId);
      const userRoom = rooms.user(order.userId);
      
      console.log(`[DEBUG] Emitting order_status_update to rooms: ${restRoom}, ${userRoom}`);
      io.to(restRoom).emit("order_status_update", payload);
      io.to(userRoom).emit("order_status_update", payload);
      
      // Notify assigned rider via socket if they exist
      const assignedRiderId = order.dispatch?.deliveryPartnerId;
      if (assignedRiderId) {
          const riderRoom = rooms.delivery(assignedRiderId);
          console.log(`[DEBUG] Emitting order_status_update to rider room: ${riderRoom}`);
          io.to(riderRoom).emit("order_status_update", payload);
      }
    }

    const notifyList = [
      { ownerType: "USER", ownerId: order.userId },
      { ownerType: "RESTAURANT", ownerId: restaurantId },
    ];

    const assignedRiderId = order.dispatch?.deliveryPartnerId;
    if (assignedRiderId) {
      notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: assignedRiderId });
    }

    let riderTitle = `Order #${order.order_id || order._id} updated`;
    let riderBody = `The order status is now ${String(orderStatus).replace(/_/g, " ")}.`;

    if (String(orderStatus).includes("cancel")) {
      riderTitle = "Order Cancelled ❌";
      riderBody = `Order #${order.order_id || order._id} has been cancelled. Please stop your current task.`;
      
      // Sync transaction status
      try {
        const isOnlinePaid = order.payment.method === "razorpay" && (order.payment.status === "paid" || order.payment.status === "refunded");
        await foodTransactionService.updateTransactionStatus(order._id, 'cancelled_by_restaurant', {
            status: isOnlinePaid ? 'refunded' : 'failed',
            note: `Order cancelled by restaurant/admin`,
            recordedByRole: 'RESTAURANT',
            recordedById: restaurantId
        });
      } catch (err) {
        logger.warn(`updateOrderStatusRestaurant transaction sync failed: ${err?.message || err}`);
      }
    }

    await notifyOwnersSafely(
      notifyList,
      {
        title: title,
        body: body,
        image: "https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png",
        data: {
          type: "order_status_update",
          orderId: order._id.toString(),
          orderMongoId: order._id?.toString?.() || "",
          orderStatus: String(orderStatus || ""),
          link: `/food/user/orders/${order._id?.toString?.() || ""}`,
        },
      },
    );
  } catch (err) {
    console.error("[DEBUG] Error emitting status update to restaurant:", err);
  }

  // Real-time: delivery request / ready notifications.
  try {
    const io = getIO();
    if (io) {
      // On accept (confirmed or preparing) -> request delivery partners via central logic
      if (
        (String(orderStatus) === "preparing" || String(orderStatus) === "confirmed") && 
        (String(from) !== "preparing" && String(from) !== "confirmed")
      ) {
        console.log(
          `[DEBUG] Order ${order._id.toString()} status changed to '${orderStatus}'. Triggering central delivery dispatch.`,
        );
        
        try {
            await tryAutoAssign(order._id);
            // Refresh local order state after assignment search
            order = await FoodOrder.findById(order._id); 
        } catch (err) {
            console.error(`[DEBUG] Auto-assign in updateOrderStatusRestaurant failed:`, err);
        }
      }

            // When ready for pickup -> ping assigned delivery partner.
            if (String(orderStatus) === 'ready_for_pickup' && String(from) !== 'ready_for_pickup') {
                console.log(`[DEBUG] Order ${order._id.toString()} changed to 'ready_for_pickup'.`);
                const assignedId = order.dispatch?.deliveryPartnerId?.toString?.() || order.dispatch?.deliveryPartnerId;
                if (assignedId) {
                    console.log(`[DEBUG] Notifying assigned partner ${assignedId} that order is ready.`);
                    const restaurant = await FoodRestaurant.findById(order.restaurantId).select('restaurantName location addressLine1 area city state').lean();
                    const payload = buildDeliverySocketPayload(order, restaurant);
                    logger.info(
                      `[DeliveryDispatch] Emitting order_ready to ${rooms.delivery(assignedId)} for order ${order._id.toString()}`,
                    );
                    io.to(rooms.delivery(assignedId)).emit('order_ready', payload);
                } else {
                    // No partner assigned yet - re-hunt for a delivery partner for this ready order.
                    console.log(`[DEBUG] Order ${order._id.toString()} is ready but no partner assigned. Re-triggering dispatch.`);
                    try {
                        await tryAutoAssign(order._id);
                        order = await FoodOrder.findById(order._id);
                    } catch (dispatchErr) {
                        console.error(`[DEBUG] Re-dispatch on ready_for_pickup failed:`, dispatchErr);
                    }
                }
            }
        }
    } catch (err) {
        console.error('[DEBUG] Error in delivery notification logic:', err);
    }

    enqueueOrderEvent('restaurant_order_status_updated', {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        restaurantId,
        from,
        to: orderStatus
    });

    if (String(orderStatus).includes("cancel")) {
      try {
        await applyCancellationRefund(order, { cancelledBy: 'restaurant' });
      } catch (err) {
        console.error(`Automated refund failed for Order ${order._id.toString()} (Restaurant Cancel):`, err);
        order.payment.refund = { status: "failed", amount: order.pricing.total };
      }
      await order.save();
    }

    return normalizeOrderForClient(order);
}

/**
 * Manually re-trigger delivery partner search for a restaurant order.
 * Only allowed if status is preparing/ready and no partner has accepted yet.
 */
export async function resendDeliveryNotificationRestaurant(orderId, restaurantId) {
    return dispatchService.resendDeliveryNotificationRestaurant(orderId, restaurantId);
}

export async function resendDeliveryNotificationAdmin(orderId) {
    return dispatchService.resendDeliveryNotificationAdmin(orderId);
}

export async function getCurrentTripDelivery(deliveryPartnerId) {
  return deliveryService.getCurrentTripDelivery(deliveryPartnerId);
}

// ----- Delivery: available, accept, reject, status -----
export async function listOrdersAvailableDelivery(deliveryPartnerId, query) {
  return deliveryService.listOrdersAvailableDelivery(deliveryPartnerId, query);
}

export async function acceptOrderDelivery(orderId, deliveryPartnerId) {
  return deliveryService.acceptOrderDelivery(orderId, deliveryPartnerId);
}

export async function rejectOrderDelivery(orderId, deliveryPartnerId) {
  return deliveryService.rejectOrderDelivery(orderId, deliveryPartnerId);
}

export async function confirmReachedPickupDelivery(orderId, deliveryPartnerId) {
  return deliveryService.confirmReachedPickupDelivery(orderId, deliveryPartnerId);
}

/**
 * Slide to confirm pickup (Bill uploaded)
 */
export async function confirmPickupDelivery(
  orderId,
  deliveryPartnerId,
  billImageUrl,
) {
  return deliveryService.confirmPickupDelivery(
    orderId,
    deliveryPartnerId,
    billImageUrl,
  );
}

export async function confirmReachedDropDelivery(orderId, deliveryPartnerId) {
  return deliveryService.confirmReachedDropDelivery(orderId, deliveryPartnerId);
}

export async function verifyDropOtpDelivery(orderId, deliveryPartnerId, otp) {
  return deliveryService.verifyDropOtpDelivery(orderId, deliveryPartnerId, otp);
}

export async function completeDelivery(orderId, deliveryPartnerId, body = {}) {
  return deliveryService.completeDelivery(orderId, deliveryPartnerId, body);
}



export async function updateOrderStatusDelivery(orderId, deliveryPartnerId, orderStatus) {
  return deliveryService.updateOrderStatusDelivery(orderId, deliveryPartnerId, orderStatus);
}

// ----- COD QR collection -----
export async function createCollectQr(
  orderId,
  deliveryPartnerId,
  customerInfo = {},
) {
  return paymentService.createCollectQr(orderId, deliveryPartnerId, customerInfo);
}


export async function getPaymentStatus(orderId, deliveryPartnerId) {
  return paymentService.getPaymentStatus(orderId, deliveryPartnerId);
}

export async function switchToCash(orderId, deliveryPartnerId) {
  return paymentService.switchToCash(orderId, deliveryPartnerId);
}


// ----- Admin -----

function escapeAdminSearchRegex(value) {
  return String(value || '').slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendAdminAndCondition(filter, condition) {
  if (!condition || Object.keys(condition).length === 0) return;
  if (!filter.$and) filter.$and = [];
  filter.$and.push(condition);
}

async function applyAdminOrderSearchFilter(filter, searchRaw) {
  const search = String(searchRaw || '').trim();
  if (!search) return;

  const escaped = escapeAdminSearchRegex(search);
  const phoneDigits = search.replace(/\D/g, '');
  const orConditions = [
    { orderId: { $regex: escaped, $options: 'i' } },
    { order_id: { $regex: escaped, $options: 'i' } },
    { customerName: { $regex: escaped, $options: 'i' } },
    { customerPhone: { $regex: escaped, $options: 'i' } },
  ];

  if (phoneDigits.length >= 4) {
    orConditions.push({ customerPhone: { $regex: phoneDigits } });
  }

  const matchingRestaurants = await FoodRestaurant.find({
    restaurantName: { $regex: escaped, $options: 'i' },
  })
    .select('_id')
    .lean();

  if (matchingRestaurants.length > 0) {
    orConditions.push({
      restaurantId: { $in: matchingRestaurants.map((row) => row._id) },
    });
  }

  appendAdminAndCondition(filter, { $or: orConditions });
}

function applyAdminPaymentStatusFilter(filter, paymentStatusRaw) {
  const paymentStatus = String(paymentStatusRaw || '').trim().toLowerCase();
  if (!paymentStatus) return;

  if (paymentStatus === 'paid') {
    appendAdminAndCondition(filter, {
      $or: [
        { 'payment.status': { $in: ['paid', 'authorized'] } },
        {
          $and: [
            { 'payment.method': 'cash' },
            { orderStatus: 'delivered' },
          ],
        },
        {
          $and: [
            { 'payment.method': 'wallet' },
            { 'payment.status': { $nin: ['failed', 'refunded', 'created', 'cod_pending', 'pending_qr'] } },
          ],
        },
      ],
    });
    return;
  }

  if (paymentStatus === 'pending') {
    appendAdminAndCondition(filter, {
      $or: [
        { 'payment.status': { $in: ['created', 'cod_pending', 'pending_qr'] } },
        {
          $and: [
            { 'payment.method': 'cash' },
            { orderStatus: { $ne: 'delivered' } },
          ],
        },
      ],
    });
    return;
  }

  if (paymentStatus === 'failed') {
    filter['payment.status'] = 'failed';
    return;
  }

  if (paymentStatus === 'refunded') {
    filter['payment.status'] = 'refunded';
  }
}

function applyAdminAmountFilter(filter, minAmountRaw, maxAmountRaw) {
  const minAmount = Number(minAmountRaw);
  const maxAmount = Number(maxAmountRaw);
  const totalFilter = {};

  if (Number.isFinite(minAmount) && minAmount >= 0) {
    totalFilter.$gte = minAmount;
  }
  if (Number.isFinite(maxAmount) && maxAmount >= 0) {
    totalFilter.$lte = maxAmount;
  }
  if (Object.keys(totalFilter).length > 0) {
    filter['pricing.total'] = totalFilter;
  }
}

export async function listOrdersAdmin(query) {
  await expireStalePendingPaymentOrders();

  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 2000);
  const skip = (page - 1) * limit;
  const filter = {};

  const rawStatus =
    typeof query.status === "string" ? query.status.trim().toLowerCase() : "";
  const cancelledBy =
    typeof query.cancelledBy === "string"
      ? query.cancelledBy.trim().toLowerCase()
      : "";
  const restaurantIdRaw =
    typeof query.restaurantId === "string" ? query.restaurantId.trim() : "";
  const zoneIdRaw =
    typeof query.zoneId === "string" ? query.zoneId.trim() : "";
  const startDateRaw =
    typeof query.startDate === "string" ? query.startDate.trim() : "";
  const endDateRaw =
    typeof query.endDate === "string" ? query.endDate.trim() : "";
  const searchRaw =
    typeof query.search === "string" ? query.search.trim() : "";
  const paymentStatusRaw =
    typeof query.paymentStatus === "string" ? query.paymentStatus.trim() : "";
  const minAmountRaw = query.minAmount;
  const maxAmountRaw = query.maxAmount;

  if (!rawStatus || rawStatus === "all") {
    filter.orderStatus = { $ne: "pending_payment" };
  }

  if (rawStatus && rawStatus !== "all") {
    const terminalCancelledStatuses = [
      "cancelled_by_user",
      "cancelled_by_restaurant",
      "cancelled_by_admin",
    ];

    switch (rawStatus) {
      case "pending":
        // Placed by customer; restaurant has not accepted yet.
        filter.orderStatus = "created";
        break;
      case "processing":
        // Active orders not delivered/cancelled, delivery partner not accepted yet.
        filter.orderStatus = {
          $nin: [
            "created",
            "delivered",
            "pending_payment",
            ...terminalCancelledStatuses,
          ],
        };
        filter.$or = [
          { "dispatch.status": { $ne: "accepted" } },
          { "dispatch.status": { $exists: false } },
          { dispatch: { $exists: false } },
        ];
        break;
      case "food-on-the-way":
        // Delivery partner accepted; not yet delivered.
        filter["dispatch.status"] = "accepted";
        filter.orderStatus = {
          $nin: ["delivered", ...terminalCancelledStatuses],
        };
        break;
      case "delivered":
        filter.orderStatus = "delivered";
        break;
      case "canceled":
      case "cancelled":
        filter.orderStatus = {
          $in: [
            "cancelled_by_user",
            "cancelled_by_restaurant",
            "cancelled_by_admin",
          ],
        };
        break;
      case "restaurant-cancelled":
        filter.orderStatus = "cancelled_by_restaurant";
        break;
      case "payment-failed":
        filter["payment.status"] = "failed";
        break;
      case "refunded":
        filter["payment.status"] = "refunded";
        break;
      case "offline-payments":
        filter["payment.method"] = "cash";
        filter.orderStatus = { $in: ["created", "confirmed", "delivered"] };
        break;
      default:
        break;
    }
  }

  if (cancelledBy) {
    if (cancelledBy === "restaurant") {
      filter.orderStatus = "cancelled_by_restaurant";
    } else if (cancelledBy === "user" || cancelledBy === "customer") {
      filter.orderStatus = "cancelled_by_user";
    }
  }

  if (restaurantIdRaw && mongoose.Types.ObjectId.isValid(restaurantIdRaw)) {
    filter.restaurantId = new mongoose.Types.ObjectId(restaurantIdRaw);
  }

  if (zoneIdRaw && mongoose.Types.ObjectId.isValid(zoneIdRaw)) {
    const zoneRestaurantIds = await FoodRestaurant.find({
      zoneId: new mongoose.Types.ObjectId(zoneIdRaw),
    }).distinct("_id");
    if (filter.restaurantId instanceof mongoose.Types.ObjectId) {
      filter.restaurantId = {
        $in: zoneRestaurantIds.filter(
          (id) => String(id) === String(filter.restaurantId),
        ),
      };
    } else {
      filter.restaurantId = { $in: zoneRestaurantIds };
    }
  }

  if (startDateRaw || endDateRaw) {
    const createdAt = {};
    const start = startDateRaw ? new Date(startDateRaw) : null;
    const end = endDateRaw ? new Date(endDateRaw) : null;
    if (start && !Number.isNaN(start.getTime())) {
      createdAt.$gte = start;
    }
    if (end && !Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      createdAt.$lte = end;
    }
    if (Object.keys(createdAt).length > 0) {
      filter.createdAt = createdAt;
    }
  }

  await applyAdminOrderSearchFilter(filter, searchRaw);
  applyAdminPaymentStatusFilter(filter, paymentStatusRaw);
  applyAdminAmountFilter(filter, minAmountRaw, maxAmountRaw);

  const [docs, total] = await Promise.all([
    FoodOrder.find(filter)
      .select("+deliveryOtp")
      .populate("userId", "name phone email")
      .populate("restaurantId", "restaurantName area city ownerPhone zoneId")
      .populate("dispatch.deliveryPartnerId", "name phone")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    FoodOrder.countDocuments(filter),
  ]);
  const paginated = buildPaginatedResult({ docs: docs.map(d => normalizeOrderForClient(d)), total, page, limit });
  return { ...paginated, orders: paginated.data };
}

export async function assignDeliveryPartnerAdmin(
  orderId,
  deliveryPartnerId,
  adminId,
) {
  const order = await FoodOrder.findById(orderId);
  if (!order) throw new NotFoundError("Order not found");
  if (order.dispatch.status === "accepted")
    throw new ValidationError("Order already accepted by partner");

  const partner = await FoodDeliveryPartner.findById(deliveryPartnerId)
    .select("status")
    .lean();
  if (!partner || partner.status !== "approved")
    throw new ValidationError("Delivery partner not available");

    order.dispatch.status = 'assigned';
    order.dispatch.deliveryPartnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
    order.dispatch.assignedAt = new Date();
    pushStatusHistory(order, {
        byRole: 'ADMIN',
        byId: adminId,
        from: order.orderStatus,
        to: order.orderStatus,
        note: 'Delivery partner assigned by admin',
    });
    await order.save();
    enqueueOrderEvent('delivery_partner_assigned', {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        deliveryPartnerId,
        adminId
    });
    return normalizeOrderForClient(order);
}

export async function deleteOrderAdmin(orderId, adminId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const order = await FoodOrder.findOne(identity).lean();
  if (!order) throw new NotFoundError("Order not found");

  // Keep support tickets but detach deleted order reference.
  await Promise.all([
    FoodSupportTicket.updateMany(
      { orderId: order._id },
      { $set: { orderId: null } },
    ),
    FoodTransaction.deleteOne({
      $or: [{ orderId: order._id }, { orderReadableId: String(order._id.toString()) }],
    }),
    FoodOrder.deleteOne({ _id: order._id }),
  ]);

  // Remove realtime tracking node if present.
  try {
    const db = getFirebaseDB();
    if (db && order?.orderId) {
      await db.ref(`active_orders/${order._id.toString()}`).remove();
    }
  } catch (err) {
    logger.warn(`Delete order firebase cleanup failed: ${err?.message || err}`);
  }

  // Notify connected apps so stale UI entries can disappear without refresh.
  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: String(order._id),
        orderId: String(order._id.toString() || ""),
        deletedBy: "ADMIN",
        adminId: adminId ? String(adminId) : null,
      };

      if (order.userId) io.to(rooms.user(order.userId)).emit("order_deleted", payload);
      if (order.restaurantId) io.to(rooms.restaurant(order.restaurantId)).emit("order_deleted", payload);
      if (order.dispatch?.deliveryPartnerId) {
        io.to(rooms.delivery(order.dispatch.deliveryPartnerId)).emit("order_deleted", payload);
      }
    }
  } catch (err) {
    logger.warn(`Delete order socket emit failed: ${err?.message || err}`);
  }

  enqueueOrderEvent("order_deleted_by_admin", {
    orderMongoId: String(order._id),
    orderId: String(order._id.toString() || ""),
    adminId: adminId ? String(adminId) : null,
  });

  return {
    deleted: true,
    orderId: String(order._id.toString() || ""),
    orderMongoId: String(order._id),
  };
}

export async function updateOrderStatusAdmin(orderId, orderStatus, note = "", adminId) {
    const identity = buildOrderIdentityFilter(orderId);
    let order = await FoodOrder.findOne(identity);
    if (!order) throw new NotFoundError("Order not found");

    if (!Object.prototype.hasOwnProperty.call(STATUS_PRIORITY, String(orderStatus))) {
        throw new ValidationError(`Invalid order status: ${orderStatus}`);
    }
    if (!isStatusAdvance(order.orderStatus, orderStatus)) {
        throw new ValidationError(
            `Cannot change order status from '${order.orderStatus}' to '${orderStatus}'`,
        );
    }

    const from = order.orderStatus;
    order.orderStatus = orderStatus;

    const normalizedPaymentMethod = String(order.payment?.method || "cash").toLowerCase();
    const prevPaymentStatus = String(order.payment?.status || "cod_pending").toLowerCase();
    if (String(orderStatus) === "delivered" && normalizedPaymentMethod === "cash" && prevPaymentStatus === "cod_pending") {
        // Keep payment state consistent for COD if delivery is completed by admin override.
        order.payment.status = "paid";
    }

    pushStatusHistory(order, {
        byRole: "ADMIN",
        byId: adminId,
        from,
        to: orderStatus,
        note: note || "Status updated by admin",
    });

    if (String(orderStatus).includes("cancel")) {
        try {
            await applyCancellationRefund(order, { cancelledBy: 'admin' });
        } catch (err) {
            logger.warn(`Admin cancellation refund failed for order ${order._id}: ${err?.message || err}`);
            order.payment.refund = { status: "failed", amount: order.pricing?.total || 0 };
        }
    }

    await order.save();

    if (String(orderStatus) === "delivered") {
        try {
            const ledgerKind =
                normalizedPaymentMethod === "cash" && prevPaymentStatus === "cod_pending"
                    ? "cod_marked_paid_on_delivery"
                    : "payment_snapshot_sync";
            await foodTransactionService.updateTransactionStatus(order._id, ledgerKind, {
                status: "captured",
                recordedByRole: "ADMIN",
                recordedById: adminId,
                note: `Delivery completed from admin flow. Prev payment status: ${prevPaymentStatus}`,
            });
        } catch (err) {
            logger.warn(`updateOrderStatusAdmin delivered transaction sync failed: ${err?.message || err}`);
        }
    }

    // Notify all relevant parties
    const notifyList = [
        { ownerType: "USER", ownerId: order.userId },
        { ownerType: "RESTAURANT", ownerId: order.restaurantId },
    ];
    if (order.dispatch?.deliveryPartnerId) {
        notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: order.dispatch.deliveryPartnerId });
    }

    let title = `Order Status Updated 📋`;
    let body = `Order #${order.order_id || order._id} status changed to ${String(orderStatus).replace(/_/g, " ")} by support.`;

    if (orderStatus === "confirmed") {
        title = "Order Accepted! 🧑‍🍳";
        body = "The order has been accepted and is starting to be prepared.";
    } else if (orderStatus === "preparing") {
        title = "Food is being prepared! 🍳";
        body = "Your food is currently being prepared by the restaurant.";
    } else if (orderStatus === "ready_for_pickup") {
        title = "Food is ready! 🛍️";
        body = "Your order is ready and waiting to be picked up.";
    } else if (String(orderStatus).includes("cancel")) {
        title = "Order Cancelled ❌";
        body = (note && String(note).trim()) ? note : `Unfortunately, your order has been cancelled by support.`;
    }

    await notifyOwnersSafely(notifyList, {
        title,
        body,
        data: {
            type: "order_status_update",
            orderId: order._id.toString(),
            orderStatus: String(orderStatus || ""),
        }
    });

    // Real-time update
    try {
        const io = getIO();
        if (io) {
            const payload = {
                orderMongoId: order._id.toString(),
                orderId: order._id.toString(),
                orderStatus: order.orderStatus,
                message: body,
                title: title,
                note: order.note || "",
        statusNote: note || "",
            };
            io.to(rooms.user(order.userId)).emit("order_status_update", payload);
            io.to(rooms.restaurant(order.restaurantId)).emit("order_status_update", payload);
            if (order.dispatch?.deliveryPartnerId) {
                io.to(rooms.delivery(order.dispatch.deliveryPartnerId)).emit("order_status_update", payload);
            }

            // On accept (confirmed or preparing) -> request delivery partners via central logic
            if (
                (String(orderStatus) === "preparing" || String(orderStatus) === "confirmed") && 
                (String(from) !== "preparing" && String(from) !== "confirmed")
            ) {
                console.log(
                    `[DEBUG] Order ${order._id.toString()} status changed to '${orderStatus}' by Admin. Triggering central delivery dispatch.`,
                );
                
                try {
                    await tryAutoAssign(order._id);
                    // Refresh local order state after assignment search
                    order = await FoodOrder.findById(order._id); 
                } catch (err) {
                    console.error(`[DEBUG] Auto-assign in updateOrderStatusAdmin failed:`, err);
                }
            }
        }
    } catch (err) {
        logger.warn(`Admin status update socket emit failed: ${err?.message || err}`);
    }

    return normalizeOrderForClient(order);
}

export async function markOrderDeliveredAdmin(orderId, adminId, note = "") {
    const identity = buildOrderIdentityFilter(orderId);
    const order = await FoodOrder.findOne(identity);
    if (!order) throw new NotFoundError("Order not found");

    const from = String(order.orderStatus || "");
    if (from === "delivered") {
        throw new ValidationError("Order is already delivered");
    }
    if (from.includes("cancel") || from === "pending_payment") {
        throw new ValidationError(`Cannot mark order as delivered from status '${from}'`);
    }

    const normalizedPaymentMethod = String(order.payment?.method || "cash").toLowerCase();
    const prevPaymentStatus = String(order.payment?.status || "cod_pending").toLowerCase();

    order.orderStatus = "delivered";
    order.deliveryState = {
        ...(order.deliveryState?.toObject?.() || order.deliveryState || {}),
        currentPhase: "delivered",
        status: "delivered",
        deliveredAt: order.deliveryState?.deliveredAt || new Date(),
    };

    if (normalizedPaymentMethod === "cash" && prevPaymentStatus === "cod_pending") {
        order.payment.status = "paid";
    }

    pushStatusHistory(order, {
        byRole: "ADMIN",
        byId: adminId,
        from,
        to: "delivered",
        note: note || "Order marked as delivered by admin",
    });

    await order.save();

    try {
        const ledgerKind =
            normalizedPaymentMethod === "cash" && prevPaymentStatus === "cod_pending"
                ? "cod_marked_paid_on_delivery"
                : "payment_snapshot_sync";
        await foodTransactionService.updateTransactionStatus(order._id, ledgerKind, {
            status: "captured",
            recordedByRole: "ADMIN",
            recordedById: adminId,
            note: `Delivery completed by admin override. Prev payment status: ${prevPaymentStatus}`,
        });
    } catch (err) {
        logger.warn(`markOrderDeliveredAdmin transaction sync failed: ${err?.message || err}`);
    }

    const orderLabel = order.order_id || order._id?.toString?.() || "";
    const notifyList = [
        { ownerType: "USER", ownerId: order.userId },
        { ownerType: "RESTAURANT", ownerId: order.restaurantId },
    ];
    if (order.dispatch?.deliveryPartnerId) {
        notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: order.dispatch.deliveryPartnerId });
    }

    await notifyOwnersSafely(notifyList, {
        title: "Order Delivered! 🎉",
        body: `Order #${orderLabel} has been marked as delivered by support.`,
        data: {
            type: "order_status_update",
            orderId: order._id.toString(),
            orderStatus: "delivered",
        },
    });

    try {
        const io = getIO();
        if (io) {
            const payload = {
                orderMongoId: order._id.toString(),
                orderId: order._id.toString(),
                orderStatus: "delivered",
                deliveryState: order.deliveryState,
                message: `Order #${orderLabel} marked as delivered by admin.`,
                title: "Order Delivered! 🎉",
            };
            io.to(rooms.user(order.userId)).emit("order_status_update", payload);
            io.to(rooms.restaurant(order.restaurantId)).emit("order_status_update", payload);
            if (order.dispatch?.deliveryPartnerId) {
                io.to(rooms.delivery(order.dispatch.deliveryPartnerId)).emit("order_status_update", payload);
                io.to(rooms.delivery(order.dispatch.deliveryPartnerId)).emit("order_completed", payload);
            }
        }
    } catch (err) {
        logger.warn(`markOrderDeliveredAdmin socket emit failed: ${err?.message || err}`);
    }

    enqueueOrderEvent("delivery_completed", {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        adminId: adminId ? String(adminId) : null,
        payMethod: normalizedPaymentMethod,
        prevPayStatus: prevPaymentStatus,
        paymentStatus: order.payment?.status,
        source: "admin_override",
    });

    return normalizeOrderForClient(order);
}

export async function processRefundAdmin(orderId, amount, adminId) {
    const identity = buildOrderIdentityFilter(orderId);
    let order = await FoodOrder.findOne(identity);
    if (!order) throw new NotFoundError("Order not found");

    const currentPaymentStatus = String(order.payment?.status || "").toLowerCase();

    if (currentPaymentStatus === "refunded") {
        throw new ValidationError("Order is already refunded");
    }

    const refundAmount = Number(amount) || order.pricing?.total || 0;
    if (refundAmount <= 0) throw new ValidationError("Invalid refund amount");

    const refundResult = await applyCancellationRefund(order, {
        cancelledBy: 'admin',
        refundAmount,
    });

    if (!refundResult.processed) {
        if (order.isModified()) {
            await order.save();
        }
        if (refundResult.reason === 'cash_payment') {
            throw new ValidationError('Cash on Delivery orders do not require a refund');
        }
        throw new Error('Refund processing failed');
    }

    await order.save();

    try {
        await foodTransactionService.updateTransactionStatus(order._id, order.orderStatus, {
            status: 'refunded',
            note: `Refund of ₹${refundAmount} processed by admin`,
            recordedByRole: 'ADMIN',
            recordedById: adminId
        });
    } catch (err) {
        logger.warn(`Admin refund transaction sync failed: ${err?.message || err}`);
    }

    return { success: true, order: normalizeOrderForClient(order) };
}
