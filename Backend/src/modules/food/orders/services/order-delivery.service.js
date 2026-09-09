import mongoose from 'mongoose';
import { FoodOrder } from '../models/order.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodTransaction } from '../models/foodTransaction.model.js';
import { FoodDeliveryPartner } from '../../delivery/models/deliveryPartner.model.js';
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from '../../../../core/auth/errors.js';
import { buildPaginatedResult, buildPaginationOptions } from '../../../../utils/helpers.js';
import { logger } from '../../../../utils/logger.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { getFirebaseDB } from '../../../../config/firebase.js';
import { fetchDrivingRoute } from '../utils/googleMaps.js';
import {
  FEATURE_KEYS,
  isFeatureEnabled,
} from '../../admin/services/featureSettings.service.js';

import * as foodTransactionService from './foodTransaction.service.js';
import * as dispatchService from './order-dispatch.service.js';
import * as paymentService from './order-payment.service.js';

import {
  buildOrderIdentityFilter,
  emitDeliveryDropOtpToUser,
  enqueueOrderEvent,
  generateFourDigitDeliveryOtp,
  haversineKm,
  notifyOwnerSafely,
  notifyOwnersSafely,
  partnerHasActiveDelivery,
  pushStatusHistory,
  sanitizeOrderForDeliveryPartner,
  TERMINAL_ORDER_STATUSES,
  isStatusAdvance,
} from './order.helpers.js';
const DELIVERY_ORDER_BASE_SELECT = [
  '_id',
  'order_id',
  'orderId',
  'userId',
  'restaurantId',
  'deliveryAddress',
  'customerName',
  'customerPhone',
  'items',
  'pricing',
  'payment',
  'orderStatus',
  'dispatch',
  'deliveryState',
  'note',
  'deliveryInstructions',
  'createdAt',
  'updatedAt',
  'riderEarning',
  'tripDistanceKm',
  'tripDurationMins',
  'lastRiderLocation',
  'deliveryFleet',
  'ratings'
].join(' ');

const DELIVERY_USER_POPULATE = {
  path: 'userId',
  select: 'name phone email',
};

const DELIVERY_RESTAURANT_POPULATE = {
  path: 'restaurantId',
  select: 'restaurantName name phone ownerPhone location addressLine1 area city state profileImage',
};

const DELIVERY_TRANSACTION_SELECT = 'orderId payment paymentMethod pricing amounts status';

function mergeTransactionIntoOrder(orderDoc, txDoc) {
  if (!txDoc) return orderDoc;
  return {
    ...orderDoc,
    paymentMethod: txDoc.payment?.method || txDoc.paymentMethod || orderDoc.paymentMethod,
    payment: txDoc.payment || orderDoc.payment,
    pricing: txDoc.pricing || orderDoc.pricing,
    amounts: txDoc.amounts || orderDoc.amounts,
    transactionStatus: txDoc.status || orderDoc.transactionStatus,
  };
}

function emitOrderUpdate(order, deliveryPartnerId) {
  try {
    const io = getIO();
    if (io) {
      const dv =
        order.deliveryVerification?.toObject?.() || order.deliveryVerification;
      const payload = {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        orderStatus: order.orderStatus,
        deliveryState: order.deliveryState,
        deliveryVerification: dv,
      };
      io.to(rooms.delivery(deliveryPartnerId)).emit(
        'order_status_update',
        payload,
      );
      io.to(rooms.restaurant(order.restaurantId)).emit(
        'order_status_update',
        payload,
      );
      io.to(rooms.user(order.userId)).emit('order_status_update', payload);
      const adminRoom = rooms.admin ? rooms.admin() : 'admin:orders';
      io.to(adminRoom).emit('order_status_update', payload);
      if (order._id) io.to(rooms.tracking(order._id)).emit('order_status_update', payload);
    }

    // Only send push notifications for key delivery milestones
    const status = order.orderStatus;
    if (!['picked_up', 'reached_drop', 'delivered'].includes(status)) return;

    let userTitle = '';
    let userBody = '';
    let riderTitle = '';
    let riderBody = '';

    const orderId = order._id.toString();

    if (status === 'picked_up') {
      userTitle = 'Order on the way!';
      userBody = `Partner has picked up your order #${orderId} and is heading your way.`;
      riderTitle = 'Order picked up!';
      riderBody = `You have picked up order #${orderId}. Proceed to the customer location.`;
    } else if (status === 'reached_drop') {
      userTitle = 'Partner nearby!';
      userBody = `Your delivery partner has reached your location for order #${orderId}.`;
      riderTitle = 'Arrived at drop!';
      riderBody = `You have reached the customer location for order #${orderId}.`;
    } else if (status === 'delivered') {
      userTitle = `Order #${orderId} delivered!`;
      userBody = 'Hope you enjoyed your meal! Don\'t forget to rate your experience.';
      riderTitle = 'Delivery successful!';
      riderBody = `Order #${orderId} has been successfully delivered.`;

      if (order.payment?.method === 'cash' || order.paymentMethod === 'cash') {
        riderTitle = 'Payment collected!';
        const amt = order.pricing?.total || order.amounts?.totalCustomerPaid || 0;
        riderBody = `You have collected Rs ${amt} cash for Order #${orderId}.`;
      }
    }

    if (userTitle) {
      void notifyOwnersSafely(
        [
          { ownerType: 'RESTAURANT', ownerId: order.restaurantId },
          { ownerType: 'USER', ownerId: order.userId },
        ],
        {
          title: userTitle,
          body: userBody,
          dataOnly: true,
          data: {
            type: 'order_status_update',
            orderId,
            orderMongoId: order._id?.toString?.() || '',
            orderStatus: status,
          },
        },
      );
    }

    if (riderTitle) {
      void notifyOwnerSafely(
        { ownerType: 'DELIVERY_PARTNER', ownerId: deliveryPartnerId },
        {
          title: riderTitle,
          body: riderBody,
          dataOnly: true,
          data: {
            type: status === 'delivered' ? 'order_completed' : 'order_status_update',
            orderId,
            orderMongoId: order._id?.toString?.() || '',
            paymentMethod: order.payment?.method || order.paymentMethod,
            amountCollected: String(order.pricing?.total || order.amounts?.totalCustomerPaid || 0),
          },
        },
      );
    }
  } catch (error) {
    logger.error(`Error emitting delivery order update: ${error?.message || error}`);
  }
}



// Lazy wrapper to avoid circular ESM init race condition
async function syncRazorpayQrPayment(orderDoc) {
  return paymentService.syncRazorpayQrPayment(orderDoc);
}




export async function getCurrentTripDelivery(deliveryPartnerId) {
  if (!deliveryPartnerId) {
    throw new ValidationError('Delivery partner ID required');
  }

  const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
  const order = await FoodOrder.findOne({
    'dispatch.deliveryPartnerId': partnerId,
    'dispatch.status': 'accepted',
    orderStatus: {
      $in: ['confirmed', 'preparing', 'ready_for_pickup', 'picked_up'],
    },
  })
    .select(DELIVERY_ORDER_BASE_SELECT)
    .populate(DELIVERY_RESTAURANT_POPULATE)
    .populate({ path: 'userId', select: 'name phone' })
    .sort({ updatedAt: -1 })
    .lean();

  if (!order) return null;

  const tx = await FoodTransaction.findOne({ orderId: order._id })
    .select(DELIVERY_TRANSACTION_SELECT)
    .lean();

  return sanitizeOrderForDeliveryPartner(mergeTransactionIntoOrder(order, tx));
}

export async function listOrdersAvailableDelivery(deliveryPartnerId, query) {
  const { page, limit, skip } = buildPaginationOptions(query);
  const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
  const hasActiveDelivery = await partnerHasActiveDelivery(deliveryPartnerId);

  const filter = hasActiveDelivery
    ? {
        'dispatch.deliveryPartnerId': partnerId,
        'dispatch.status': 'accepted',
        orderStatus: { $nin: TERMINAL_ORDER_STATUSES },
      }
    : {
        $or: [
          {
            'dispatch.status': 'unassigned',
            'dispatch.offeredTo': {
              $not: {
                $elemMatch: {
                  partnerId,
                  action: 'deassigned',
                },
              },
            },
            orderStatus: { $in: ['confirmed', 'preparing', 'ready_for_pickup'] },
          },
          {
            'dispatch.deliveryPartnerId': partnerId,
            'dispatch.status': { $in: ['assigned', 'accepted'] },
            orderStatus: { $nin: TERMINAL_ORDER_STATUSES },
          },
        ],
      };

  // For idle partners, pull a wider candidate set then proximity-filter in memory.
  // Avoids returning another city's orders that the poll hydrate could lock into the modal.
  const queryLimit = hasActiveDelivery ? limit : Math.max(limit * 5, 50);

  const docs = await FoodOrder.find(filter)
    .select(DELIVERY_ORDER_BASE_SELECT)
    .sort({ createdAt: -1 })
    .limit(queryLimit)
    .populate(DELIVERY_USER_POPULATE)
    .populate(DELIVERY_RESTAURANT_POPULATE)
    .lean();

  const orderIds = docs.map((doc) => doc?._id).filter(Boolean);
  const txRows = orderIds.length
    ? await FoodTransaction.find({ orderId: { $in: orderIds } })
        .select(DELIVERY_TRANSACTION_SELECT)
        .lean()
    : [];
  const txByOrderId = new Map(txRows.map((tx) => [String(tx.orderId), tx]));

  let enriched = docs.map((doc) =>
    sanitizeOrderForDeliveryPartner(
      mergeTransactionIntoOrder(doc, txByOrderId.get(String(doc._id)) || null),
    ),
  );

  if (!hasActiveDelivery) {
    const partner = await FoodDeliveryPartner.findById(partnerId)
      .select('lastLat lastLng lastLocationAt')
      .lean();

    const MAX_OFFER_KM = 20; // slightly wider than dispatch radius (15km)
    const partnerLat = partner?.lastLat;
    const partnerLng = partner?.lastLng;
    const hasPartnerGps =
      partnerLat != null &&
      partnerLng != null &&
      Number.isFinite(Number(partnerLat)) &&
      Number.isFinite(Number(partnerLng));

    const withMeta = enriched.map((order) => {
      const assignedToMe = Boolean(
        order?.dispatch?.deliveryPartnerId &&
          String(order.dispatch.deliveryPartnerId) === String(partnerId),
      );

      const offeredToMe = Array.isArray(order?.dispatch?.offeredTo)
        ? order.dispatch.offeredTo.some(
            (entry) => String(entry?.partnerId) === String(partnerId),
          )
        : false;

      let distanceKm = null;
      const coords = order?.restaurantId?.location?.coordinates;
      if (hasPartnerGps && Array.isArray(coords) && coords.length >= 2) {
        const [rLng, rLat] = coords;
        const d = haversineKm(
          Number(partnerLat),
          Number(partnerLng),
          Number(rLat),
          Number(rLng),
        );
        if (Number.isFinite(d)) distanceKm = d;
      }

      return { order, assignedToMe, offeredToMe, distanceKm };
    });

    const kept = withMeta.filter(({ assignedToMe, offeredToMe, distanceKm }) => {
      if (assignedToMe) return true;

      // No partner GPS: only show orders already offered to this rider (safe vs global leak).
      if (!hasPartnerGps) return offeredToMe;

      // Missing/unresolvable restaurant coords: same offered-only rule.
      if (distanceKm == null) return offeredToMe;

      if (distanceKm <= MAX_OFFER_KM) return true;

      // Already offered to this rider: allow a small GPS-drift buffer, else drop.
      return offeredToMe && distanceKm <= MAX_OFFER_KM * 1.5;
    });

    // Rank the list so consumers that take its head (reconnect recovery, poll
    // hydrate in the rider app) surface the order this rider was actually
    // offered — not just the newest order in range, which could sit at a
    // different location than the offer the rider is expecting.
    kept.sort((a, b) => {
      if (a.assignedToMe !== b.assignedToMe) return a.assignedToMe ? -1 : 1;
      if (a.offeredToMe !== b.offeredToMe) return a.offeredToMe ? -1 : 1;
      const da = a.distanceKm == null ? Infinity : a.distanceKm;
      const db = b.distanceKm == null ? Infinity : b.distanceKm;
      return da - db;
    });

    enriched = kept.map(({ order }) => order);
  }

  const total = enriched.length;
  const paged = hasActiveDelivery
    ? enriched.slice(0, limit)
    : enriched.slice(skip, skip + limit);

  return buildPaginatedResult({ docs: paged, total, page, limit });
}

export async function acceptOrderDelivery(orderId, deliveryPartnerId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');

  const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
  const now = new Date();
  const acceptedStatuses = ['created', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up'];
  const cancellableStatuses = [
    'cancelled_by_user',
    'cancelled_by_restaurant',
    'cancelled_by_admin',
  ];

  const alreadyOnTrip = await partnerHasActiveDelivery(deliveryPartnerId);
  if (alreadyOnTrip) {
    const existingActive = await FoodOrder.findOne({
      'dispatch.deliveryPartnerId': partnerId,
      'dispatch.status': 'accepted',
      orderStatus: { $nin: TERMINAL_ORDER_STATUSES },
    })
      .select('_id order_id orderId')
      .lean();

    const activeOrderKey = String(existingActive?._id || '');
    const requestedOrder = await FoodOrder.findOne(identity).select('_id').lean();
    const requestedOrderKey = String(requestedOrder?._id || '');

    if (activeOrderKey && requestedOrderKey && activeOrderKey === requestedOrderKey) {
      const acceptedOrder = await FoodOrder.findOne(identity).populate('restaurantId userId');
      return acceptedOrder ? sanitizeOrderForDeliveryPartner(acceptedOrder) : null;
    }

    throw new ValidationError(
      'You already have an active delivery. Complete it before accepting another order.',
    );
  }

  // Block COD accept when remaining cash capacity is below order amount.
  const orderForCodCheck = await FoodOrder.findOne(identity)
    .select('payment pricing')
    .lean();
  const payMethod = String(orderForCodCheck?.payment?.method || '').toLowerCase();
  if (payMethod === 'cash' || payMethod === 'cod') {
    const orderAmount =
      Number(orderForCodCheck?.pricing?.total) ||
      Number(orderForCodCheck?.payment?.amountDue) ||
      0;
    const { assertPartnerCanAcceptCodOrder } = await import(
      '../../delivery/services/deliveryFinance.service.js'
    );
    await assertPartnerCanAcceptCodOrder(deliveryPartnerId, orderAmount);
  }

  const statusHistoryEntry = {
    byRole: 'DELIVERY_PARTNER',
    byId: partnerId,
    from: 'dispatchable',
    to: 'accepted',
    note: 'Delivery partner accepted order',
    at: now,
  };

  const order = await FoodOrder.findOneAndUpdate(
    {
      ...identity,
      orderStatus: { $in: acceptedStatuses },
      $or: [
        {
          'dispatch.status': 'unassigned',
          'dispatch.offeredTo': {
            $not: {
              $elemMatch: {
                partnerId,
                action: 'deassigned',
              },
            },
          },
        },
        {
          'dispatch.status': 'assigned',
          'dispatch.deliveryPartnerId': partnerId,
        },
      ],
    },
    {
      $set: {
        'dispatch.deliveryPartnerId': partnerId,
        'dispatch.status': 'accepted',
        'dispatch.assignedAt': now,
        'dispatch.acceptedAt': now,
      },
      $push: {
        statusHistory: statusHistoryEntry,
      },
    },
    { new: true },
  ).populate('restaurantId userId');

  if (!order) {
    const existing = await FoodOrder.findOne(identity)
      .select('orderStatus dispatch')
      .lean();

    if (!existing) throw new NotFoundError('Order not found');
    if (cancellableStatuses.includes(existing.orderStatus)) {
      throw new ValidationError('Order was cancelled');
    }
    if (existing.orderStatus === 'delivered') {
      throw new ValidationError('Order already delivered');
    }
    if (!acceptedStatuses.includes(existing.orderStatus)) {
      throw new ValidationError('Order not ready for delivery assignment');
    }
    if (
      existing.dispatch?.status === 'accepted' &&
      String(existing.dispatch?.deliveryPartnerId || '') === String(deliveryPartnerId)
    ) {
      const acceptedOrder = await FoodOrder.findOne(identity)
        .populate('restaurantId userId');
      return acceptedOrder
        ? sanitizeOrderForDeliveryPartner(acceptedOrder)
        : null;
    }
    if (
      existing.dispatch?.status === 'accepted' &&
      String(existing.dispatch?.deliveryPartnerId || '') !== String(deliveryPartnerId)
    ) {
      throw new ForbiddenError('Order already accepted by another partner');
    }

    throw new ValidationError('Order is no longer available to accept');
  }

  const responseOrder = sanitizeOrderForDeliveryPartner(order);

  void (async () => {
    try {
      const rest = order.restaurantId;
      const userLoc = order.deliveryAddress?.location?.coordinates;
      const restLoc = rest?.location?.coordinates;

      if (restLoc?.[0] && userLoc?.[0]) {
        const googleOrderRoadEnabled = await isFeatureEnabled(
          FEATURE_KEYS.GOOGLE_ORDER_ROAD_DISTANCE,
          true,
        );

        let polyline = '';
        if (googleOrderRoadEnabled) {
          const route = await fetchDrivingRoute(
            { lat: restLoc[1], lng: restLoc[0] },
            { lat: userLoc[1], lng: userLoc[0] },
          );
          polyline = route.polyline || '';

          if (route.distanceKm != null) {
            const tripDurationMins =
              route.durationSeconds != null
                ? Math.ceil(route.durationSeconds / 60)
                : null;
            FoodOrder.updateOne(
              { _id: order._id },
              {
                $set: {
                  tripDistanceKm: route.distanceKm,
                  tripDurationMins,
                  'pricing.roadDistanceKm': route.distanceKm,
                  'pricing.roadDurationMins': tripDurationMins,
                },
              },
            ).catch(() => {});
          }
        }

        const db = getFirebaseDB();
        if (db) {
          const orderRef = db.ref(`active_orders/${order._id.toString()}`);
          await orderRef
            .set({
              polyline,
              lat: restLoc[1],
              lng: restLoc[0],
              boy_lat: restLoc[1],
              boy_lng: restLoc[0],
              restaurant_lat: restLoc[1],
              restaurant_lng: restLoc[0],
              customer_lat: userLoc[1],
              customer_lng: userLoc[0],
              status: 'accepted',
              last_updated: Date.now(),
            })
            .catch((error) =>
              logger.error(`Firebase orderRef set error: ${error.message}`),
            );
        }
      }
    } catch (error) {
      logger.error(
        `Error initializing Firebase order tracking: ${error?.message || error}`,
      );
    }

    try {
      await foodTransactionService.updateTransactionRider(order._id, deliveryPartnerId);
    } catch (error) {
      logger.error(
        `Error updating delivery rider transaction for ${order._id}: ${
          error?.message || error
        }`,
      );
    }

    try {
      const io = getIO();
      if (io) {
        const payload = {
          orderMongoId: order._id?.toString?.(),
          orderId: order._id.toString(),
          orderStatus: order.orderStatus,
          dispatchStatus: order.dispatch?.status,
        };
        io.to(rooms.delivery(deliveryPartnerId)).emit('order_status_update', payload);
        io.to(rooms.restaurant(order.restaurantId)).emit('order_status_update', payload);
        io.to(rooms.user(order.userId)).emit('order_status_update', payload);
        const adminRoom = rooms.admin ? rooms.admin() : 'admin:orders';
        io.to(adminRoom).emit('order_status_update', payload);
        if (order._id) io.to(rooms.tracking(order._id)).emit('order_status_update', payload);

        // Notify ALL other delivery partners who were offered this order to dismiss it
        const offeredPartners = order.dispatch?.offeredTo || [];
        const claimedPayload = {
          orderId: order._id.toString(),
          orderMongoId: order._id?.toString?.(),
          claimedBy: deliveryPartnerId.toString(),
        };
        for (const offer of offeredPartners) {
          const pid = offer.partnerId?.toString?.();
          if (pid && pid !== deliveryPartnerId.toString()) {
            io.to(rooms.delivery(pid)).emit('order_claimed', claimedPayload);
          }
        }
        logger.info(`[DeliveryDispatch] Broadcasted order_claimed to ${offeredPartners.length - 1} other partners for order ${order._id.toString()}`);
      }

      await notifyOwnersSafely(
        [
          { ownerType: 'USER', ownerId: order.userId },
          { ownerType: 'RESTAURANT', ownerId: order.restaurantId },
          { ownerType: 'DELIVERY_PARTNER', ownerId: deliveryPartnerId },
        ],
        {
          title: `Order ${order._id.toString()} accepted`,
          body: 'A delivery partner has accepted your order.',
          data: {
            type: 'delivery_accepted',
            orderId: order._id.toString(),
            orderMongoId: order._id?.toString?.() || '',
            dispatchStatus: order.dispatch?.status,
            link: '/food/user/orders',
          },
        },
      );
    } catch (error) {
      logger.error(
        `Error notifying delivery acceptance for ${order._id}: ${
          error?.message || error
        }`,
      );
    }
  })();

  enqueueOrderEvent('delivery_accepted', {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    deliveryPartnerId,
    dispatchStatus: order.dispatch?.status,
    orderStatus: order.orderStatus,
  });

  return responseOrder;
}

export async function rejectOrderDelivery(orderId, deliveryPartnerId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');

  const order = await FoodOrder.findOne(identity).select('+deliveryOtp');
  if (!order) throw new NotFoundError('Order not found');
  if (order.dispatch.deliveryPartnerId?.toString() !== deliveryPartnerId.toString()) {
    throw new ForbiddenError('Not your order');
  }

  const offer = order.dispatch.offeredTo.find(
    (item) =>
      String(item.partnerId) === String(deliveryPartnerId) &&
      item.action === 'offered',
  );
  if (offer) offer.action = 'rejected';

  order.dispatch.status = 'unassigned';
  order.dispatch.deliveryPartnerId = undefined;
  order.dispatch.assignedAt = undefined;
  order.dispatch.acceptedAt = undefined;
  pushStatusHistory(order, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from: 'assigned',
    to: 'unassigned',
    note: 'Rejected',
  });
  await order.save();

  enqueueOrderEvent('delivery_rejected', {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    deliveryPartnerId,
  });

  void dispatchService
    .tryAutoAssign(order._id)
    .catch((error) =>
      logger.error(`SmartDispatch: Auto-assign after reject failed: ${error.message}`),
    );

  return order.toObject();
}

export async function confirmReachedPickupDelivery(orderId, deliveryPartnerId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');

  const order = await FoodOrder.findOne(identity).select('+deliveryOtp');
  if (!order) throw new NotFoundError('Order not found');
  if (
    order.dispatch?.deliveryPartnerId?.toString() !== deliveryPartnerId.toString()
  ) {
    throw new ForbiddenError('Not your order');
  }
  if (order.orderStatus === 'delivered') {
    throw new ValidationError('Order already delivered');
  }

  const currentPhase = order.deliveryState?.currentPhase || '';
  const currentStatus = order.deliveryState?.status || '';
  if (currentPhase === 'at_pickup' || currentStatus === 'reached_pickup') {
    return order.toObject();
  }

  const from = currentStatus || currentPhase || order.orderStatus;
  order.deliveryState = {
    ...(order.deliveryState?.toObject?.() || order.deliveryState || {}),
    currentPhase: 'at_pickup',
    status: 'reached_pickup',
    reachedPickupAt: order.deliveryState?.reachedPickupAt || new Date(),
  };
  pushStatusHistory(order, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from,
    to: 'reached_pickup',
    note: 'Reached pickup location',
  });
  await order.save();

  emitOrderUpdate(order, deliveryPartnerId);

  try {
    const restaurant = await FoodRestaurant.findById(order.restaurantId)
      .select('restaurantName')
      .lean();
    const partner = await FoodDeliveryPartner.findById(deliveryPartnerId)
      .select('name')
      .lean();

    await notifyOwnersSafely(
      [{ ownerType: 'RESTAURANT', ownerId: order.restaurantId }],
      {
        title: 'Rider arrived!',
        body: `${partner?.name || 'The delivery partner'} has arrived at ${
          restaurant?.restaurantName || 'your restaurant'
        } to pick up Order .`,
        // #${order._id.toString()}
        data: {
          type: 'rider_arrived',
          // orderId: String(order._id.toString()),
          orderMongoId: String(order._id),
          partnerName: partner?.name || '',
        },
      },
    );
  } catch (error) {
    logger.error(
      `Error notifying restaurant about rider arrival for ${order._id}: ${
        error?.message || error
      }`,
    );
  }

  enqueueOrderEvent('reached_pickup', {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    deliveryPartnerId,
    orderStatus: order.orderStatus,
    deliveryPhase: order.deliveryState?.currentPhase,
    deliveryStatus: order.deliveryState?.status,
  });
  return order.toObject();
}

export async function confirmPickupDelivery(orderId, deliveryPartnerId, billImageUrl) {
  const identity = buildOrderIdentityFilter(orderId);
  const order = await FoodOrder.findOne(identity).select('+deliveryOtp');
  if (!order) throw new NotFoundError('Order not found');
  if (
    order.dispatch?.deliveryPartnerId?.toString() !== deliveryPartnerId.toString()
  ) {
    throw new ForbiddenError('Not your order');
  }

  const from = order.orderStatus;
  const nextStatus = 'picked_up';
  if (!isStatusAdvance(from, nextStatus)) {
      throw new ValidationError(`Order is already at status '${from}'. Cannot re-mark as '${nextStatus}'.`);
  }
  order.orderStatus = nextStatus;
  order.deliveryState = {
    ...(order.deliveryState?.toObject?.() || order.deliveryState || {}),
    currentPhase: 'en_route_to_delivery',
    status: 'picked_up',
    pickedUpAt: new Date(),
    billImageUrl,
  };

  // Pre-generate handover OTP so user can see it as soon as food is on the way
  const existingOtp = String(order.deliveryOtp || '').trim();
  if (!existingOtp) {
    order.deliveryOtp = generateFourDigitDeliveryOtp();
    order.deliveryVerification = {
      ...(order.deliveryVerification?.toObject?.() ||
        order.deliveryVerification ||
        {}),
      dropOtp: { required: true, verified: false },
    };
  }

  emitDeliveryDropOtpToUser(order, String(order.deliveryOtp || "").trim());

  pushStatusHistory(order, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from,
    to: 'picked_up',
    note: 'Order picked up',
  });
  await order.save();

  emitOrderUpdate(order, deliveryPartnerId);
  enqueueOrderEvent('picked_up', {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    deliveryPartnerId,
    billImageUrl: billImageUrl || null,
  });
  return order.toObject();
}

export async function confirmReachedDropDelivery(orderId, deliveryPartnerId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');

  const order = await FoodOrder.findOne(identity).select('+deliveryOtp');
  if (!order) throw new NotFoundError('Order not found');
  if (
    order.dispatch?.deliveryPartnerId?.toString() !== deliveryPartnerId.toString()
  ) {
    throw new ForbiddenError('Not your order');
  }

  if (order.deliveryVerification?.dropOtp?.verified) {
    emitOrderUpdate(order, deliveryPartnerId);
    return sanitizeOrderForDeliveryPartner(order);
  }

  const alreadyAtDrop =
    order.deliveryState?.currentPhase === 'at_drop' ||
    order.deliveryState?.status === 'reached_drop';
  const fromPhase =
    order.deliveryState?.status ||
    order.deliveryState?.currentPhase ||
    order.orderStatus ||
    '';

  const existingOtp = String(order.deliveryOtp || '').trim();
  if (!alreadyAtDrop || !existingOtp) {
    order.deliveryOtp = generateFourDigitDeliveryOtp();
    order.deliveryVerification = {
      ...(order.deliveryVerification?.toObject?.() ||
        order.deliveryVerification ||
        {}),
      dropOtp: { required: true, verified: false },
    };
  }

  order.deliveryState = {
    ...(order.deliveryState?.toObject?.() || order.deliveryState || {}),
    currentPhase: 'at_drop',
    status: 'reached_drop',
    reachedDropAt: order.deliveryState?.reachedDropAt || new Date(),
  };

  if (!alreadyAtDrop) {
    pushStatusHistory(order, {
      byRole: 'DELIVERY_PARTNER',
      byId: deliveryPartnerId,
      from: fromPhase,
      to: 'reached_drop',
      note: 'Reached drop location',
    });
  }

  await order.save();

  emitDeliveryDropOtpToUser(order, String(order.deliveryOtp || '').trim());
  emitOrderUpdate(order, deliveryPartnerId);
  enqueueOrderEvent('reached_drop', {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    deliveryPartnerId,
    dropOtpRequired: order.deliveryVerification?.dropOtp?.required ?? true,
    dropOtpVerified: order.deliveryVerification?.dropOtp?.verified ?? false,
  });
  return sanitizeOrderForDeliveryPartner(order);
}

export async function verifyDropOtpDelivery(orderId, deliveryPartnerId, otp) {
  const identity = buildOrderIdentityFilter(orderId);
  const order = await FoodOrder.findOne(identity).select('+deliveryOtp');
  if (!order) throw new NotFoundError('Order not found');
  if (
    order.dispatch?.deliveryPartnerId?.toString() !== deliveryPartnerId.toString()
  ) {
    throw new ForbiddenError('Not your order');
  }

  if (order.deliveryVerification?.dropOtp?.verified) {
    return { order: sanitizeOrderForDeliveryPartner(order) };
  }

  const otpStr = String(otp || '').trim();
  if (!otpStr) throw new ValidationError('OTP is required');

  if (!order.deliveryVerification?.dropOtp?.required) {
    throw new ValidationError(
      'OTP verification is not active for this order. Confirm reached drop first.',
    );
  }

  const expected = String(order.deliveryOtp || '').trim();
  if (!expected || expected !== otpStr) {
    throw new ValidationError(
      'Invalid OTP. Ask the customer for the code shown in their app.',
    );
  }

  if (!order.deliveryVerification) order.deliveryVerification = { dropOtp: {} };
  order.deliveryVerification.dropOtp.verified = true;
  order.markModified('deliveryVerification.dropOtp.verified');
  await order.save();

  emitOrderUpdate(order, deliveryPartnerId);
  enqueueOrderEvent('drop_otp_verified', {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    deliveryPartnerId,
  });
  return { order: sanitizeOrderForDeliveryPartner(order) };
}

export async function completeDelivery(orderId, deliveryPartnerId, body = {}) {
  const identity = buildOrderIdentityFilter(orderId);
  const order = await FoodOrder.findOne(identity).select('+deliveryOtp');
  if (!order) throw new NotFoundError('Order not found');
  if (
    order.dispatch?.deliveryPartnerId?.toString() !== deliveryPartnerId.toString()
  ) {
    throw new ForbiddenError('Not your order');
  }

  const { otp, ratings } = body;
  logger.info(`[DeliveryComplete] Attempting to complete order ${order._id} for partner ${deliveryPartnerId}. Status: ${order.orderStatus}`);

  if (
    otp &&
    order.deliveryVerification?.dropOtp?.required &&
    !order.deliveryVerification?.dropOtp?.verified
  ) {
    const orderWithSecret = await FoodOrder.findById(order._id).select('+deliveryOtp');
    const expected = String(orderWithSecret?.deliveryOtp || '').trim();
    if (expected && expected === String(otp).trim()) {
      order.deliveryVerification.dropOtp.verified = true;
      order.markModified('deliveryVerification.dropOtp.verified');
      logger.info(`[DeliveryComplete] OTP verified during completion call for ${order._id}`);
    } else {
      throw new ValidationError('Invalid handover OTP provided.');
    }
  }

  if (
    order.deliveryVerification?.dropOtp?.required &&
    !order.deliveryVerification?.dropOtp?.verified &&
    !otp
  ) {
    throw new ValidationError(
      'Customer handover OTP is required. Verify the OTP from the customer before completing delivery.',
    );
  }

  const from = order.orderStatus;
  const nextStatus = 'delivered';
  if (!isStatusAdvance(from, nextStatus)) {
      logger.warn(`[DeliveryComplete] Status advance check failed for ${order._id}. Current: ${from}`);
      throw new ValidationError(`Order is already at status '${from}'. Cannot re-mark as '${nextStatus}'.`);
  }
  
  const tx = await FoodTransaction.findOne({ orderId: order._id }).lean();
  const prevPayStatus = String(tx?.payment?.status || order?.payment?.status || 'unpaid').toLowerCase();
  const payMethod = String(tx?.payment?.method || order?.payment?.method || order?.paymentMethod || 'cash').toLowerCase();

  logger.info(`[DeliveryComplete] Order ${order._id} payment: ${payMethod}, status: ${prevPayStatus}`);

  if (payMethod === 'razorpay_qr') {
    const syncedPayment = await syncRazorpayQrPayment(order);
    if (String(syncedPayment?.status || '').toLowerCase() !== 'paid') {
      throw new ValidationError('QR payment not verified yet');
    }
  }

  order.orderStatus = 'delivered';
  order.deliveryState = {
    ...(order.deliveryState?.toObject?.() || order.deliveryState || {}),
    currentPhase: 'delivered',
    status: 'delivered',
    deliveredAt: new Date(),
  };

  if (ratings) {
    order.ratings = {
      ...(order.ratings?.toObject?.() || order.ratings || {}),
      ...ratings,
    };
  }

  pushStatusHistory(order, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from,
    to: 'delivered',
    note: 'Delivery completed successfully',
  });

  // Mark payment as paid for COD orders upon delivery
  if (payMethod === 'cash' && order.payment && order.payment.status === 'cod_pending') {
    order.payment.status = 'paid';
    logger.info(`[DeliveryComplete] COD order ${order._id} marked as paid upon delivery.`);
  }

  await order.save();

  const ledgerKind =
    payMethod === 'cash' && prevPayStatus === 'cod_pending'
      ? 'cod_marked_paid_on_delivery'
      : 'payment_snapshot_sync';

  await foodTransactionService.updateTransactionStatus(order._id, ledgerKind, {
    status: 'captured',
    recordedByRole: 'DELIVERY_PARTNER',
    recordedById: deliveryPartnerId,
    note: `Delivery completed. Prev status: ${prevPayStatus}`,
  });

  // Credit rider earning; for COD also raise cash-in-hand (lowers remaining cash limit).
  const riderEarning = Number(order.riderEarning) || 0;
  const orderTotal = Number(order.pricing?.total) || Number(order.payment?.amountDue) || 0;
  const isCod = payMethod === 'cash' || payMethod === 'cod';
  try {
    const { applyDeliveryCompletionWalletUpdates } = await import(
      '../../delivery/services/deliveryFinance.service.js'
    );
    await applyDeliveryCompletionWalletUpdates({
      deliveryPartnerId,
      riderEarning,
      orderTotal,
      isCod,
    });
  } catch (walletErr) {
    logger.warn(
      `[DeliveryComplete] Wallet update failed for ${order._id}: ${walletErr?.message || walletErr}`,
    );
  }

  emitOrderUpdate(order, deliveryPartnerId);
  enqueueOrderEvent('delivery_completed', {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    deliveryPartnerId,
    restaurantId: order.restaurantId?.toString?.() || order.restaurantId,
    riderEarning,
    total: orderTotal,
    paymentMethod: payMethod,
    payMethod,
    prevPayStatus,
    paymentStatus: order.payment?.status,
  });
  return sanitizeOrderForDeliveryPartner(order);
}

export async function updateOrderStatusDelivery(orderId, deliveryPartnerId, orderStatus) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError('Order id required');

  const order = await FoodOrder.findOne(identity).select('+deliveryOtp');
  if (!order) throw new NotFoundError('Order not found');
  if (order.dispatch.deliveryPartnerId?.toString() !== deliveryPartnerId.toString()) {
    throw new ForbiddenError('Not your order');
  }

  const from = order.orderStatus;
  if (!isStatusAdvance(from, orderStatus)) {
      throw new ValidationError(`Current order status '${from}' is further ahead than '${orderStatus}'. Order cannot be moved backwards.`);
  }
  order.orderStatus = orderStatus;
  pushStatusHistory(order, {
    byRole: 'DELIVERY_PARTNER',
    byId: deliveryPartnerId,
    from,
    to: orderStatus,
  });
  await order.save();

  enqueueOrderEvent('delivery_status_updated', {
    orderMongoId: order._id?.toString?.(),
    orderId: order._id.toString(),
    deliveryPartnerId,
    from,
    to: orderStatus,
  });
  return order.toObject();
}

