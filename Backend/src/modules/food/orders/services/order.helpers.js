import mongoose from 'mongoose';
import { FoodOrder } from '../models/order.model.js';
import { logger } from '../../../../utils/logger.js';
import { haversineKm as geoHaversineKm, parseGeoPoint } from '../../shared/geo.utils.js';
import {
  sendNotificationToOwner,
  sendNotificationToOwners,
} from "../../../../core/notifications/firebase.service.js";
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';

export function enqueueOrderEvent(action, payload = {}) {
  try {
    void addOrderJob({ action, ...payload }).catch((err) => {
      logger.warn(`BullMQ enqueue order event failed: ${action} - ${err?.message || err}`);
    });
  } catch (err) {
    logger.warn(`BullMQ enqueue order event failed (sync): ${action} - ${err?.message || err}`);
  }
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  return geoHaversineKm(lat1, lon1, lat2, lon2);
}

export function generateFourDigitDeliveryOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function sanitizeOrderForExternal(orderDoc) {
  const o = orderDoc?.toObject ? orderDoc.toObject() : { ...(orderDoc || {}) };
  delete o.deliveryOtp;
  const dv = o.deliveryVerification;
  if (dv && dv.dropOtp != null) {
    const d = dv.dropOtp;
    o.deliveryVerification = {
      ...dv,
      dropOtp: {
        required: Boolean(d.required),
        verified: Boolean(d.verified),
      },
    };
  }
  o.orderMongoId = (o._id || orderDoc?._id || "").toString();
  // Ensure orderId field for UI always contains the pretty ID
  o.orderId = o.order_id || o.orderMongoId; 
  return o;
}

export function sanitizeOrderForDeliveryPartner(orderDoc) {
  const o = sanitizeOrderForExternal(orderDoc);
  const cookingNote = String(o.note || "").trim();
  const deliveryInstructions = String(o.deliveryInstructions || "").trim();
  return {
    ...o,
    cookingNote,
    deliveryInstructions,
    note: deliveryInstructions,
  };
}

export function emitDeliveryDropOtpToUser(order, plainOtp) {
  try {
    const io = getIO();
    if (!io || !plainOtp || !order?.userId) return;
    io.to(rooms.user(order.userId)).emit("delivery_drop_otp", {
      orderMongoId: order._id?.toString?.(),
      orderId: order.order_id || order._id?.toString?.(),
      otp: plainOtp,
      message:
        "Share this OTP with your delivery partner to hand over the order.",
    });
  } catch (e) {
    logger.warn(`emitDeliveryDropOtpToUser failed: ${e?.message || e}`);
  }
}

export async function notifyOwnersSafely(targets, payload) {
  try {
    await sendNotificationToOwners(targets, payload);
  } catch (error) {
    logger.warn(`FCM notification failed: ${error?.message || error}`);
  }
}

export async function notifyOwnerSafely(target, payload) {
  try {
    await sendNotificationToOwner({ ...target, payload });
  } catch (error) {
    logger.warn(`FCM notification failed: ${error?.message || error}`);
  }
}

export const TERMINAL_ORDER_STATUSES = [
  'delivered',
  'cancelled_by_user',
  'cancelled_by_restaurant',
  'cancelled_by_admin',
];

export async function partnerHasActiveDelivery(deliveryPartnerId) {
  if (!deliveryPartnerId) return false;

  const partnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
  const active = await FoodOrder.exists({
    'dispatch.deliveryPartnerId': partnerId,
    'dispatch.status': 'accepted',
    orderStatus: { $nin: TERMINAL_ORDER_STATUSES },
  });

  return Boolean(active);
}

export async function getBusyDeliveryPartnerIds() {
  const rows = await FoodOrder.find({
    'dispatch.status': 'accepted',
    'dispatch.deliveryPartnerId': { $exists: true, $ne: null },
    orderStatus: { $nin: TERMINAL_ORDER_STATUSES },
  })
    .select('dispatch.deliveryPartnerId')
    .lean();

  return new Set(rows.map((row) => String(row.dispatch.deliveryPartnerId)));
}

export function buildOrderIdentityFilter(orderIdOrMongoId) {
  const raw = String(orderIdOrMongoId || "").trim();
  if (!raw) return null;
  if (mongoose.isValidObjectId(raw))
    return { _id: new mongoose.Types.ObjectId(raw) };
  
  // Search BOTH underscore and camelCase variants for robust lookup
  return { 
    $or: [
        { order_id: raw },
        { orderId: raw }
    ]
  };
}

export function toGeoPoint(lat, lng) {
  if (lat == null || lng == null) return undefined;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { type: "Point", coordinates: [b, a] };
}

export function pushStatusHistory(order, { byRole, byId, from, to, note = "" }) {
  order.statusHistory.push({
    at: new Date(),
    byRole,
    byId: byId || undefined,
    from,
    to,
    note,
  });
}

export function normalizeOrderForClient(orderDoc) {
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc || {};
  const mongoId = (order._id || orderDoc?._id || "").toString();
  const displayId = order.order_id || mongoId;
  const statusHistory = Array.isArray(order?.statusHistory)
    ? order.statusHistory
    : [];
  const cancellationEntry = [...statusHistory]
    .reverse()
    .find((entry) => String(entry?.to || "").toLowerCase().includes("cancel"));
  const cancellationReason =
    String(order?.cancellationReason || "").trim() ||
    String(cancellationEntry?.note || "").trim();
  const cancellationStatus = String(cancellationEntry?.to || "").toLowerCase();
  let cancelledBy = "";
  if (cancellationStatus === "cancelled_by_user") cancelledBy = "customer";
  else if (cancellationStatus === "cancelled_by_restaurant")
    cancelledBy = "restaurant";
  else if (cancellationStatus === "cancelled_by_admin") cancelledBy = "admin";
  else if (String(cancellationEntry?.byRole || "").toUpperCase() === "USER")
    cancelledBy = "customer";
  else if (
    String(cancellationEntry?.byRole || "").toUpperCase() === "RESTAURANT"
  )
    cancelledBy = "restaurant";
  else if (String(cancellationEntry?.byRole || "").toUpperCase() === "ADMIN")
    cancelledBy = "admin";

  return {
    ...order,
    orderMongoId: mongoId,
    orderId: displayId,
    status: order?.orderStatus || order?.status || "",
    cancellationReason,
    cancelledBy,
    cancelledAt: cancellationEntry?.at || null,
    deliveredAt:
      order?.deliveryState?.deliveredAt || order?.deliveredAt || null,
    deliveryPartnerId:
      order?.dispatch?.deliveryPartnerId || order?.deliveryPartnerId || null,
    rating: order?.ratings?.restaurant?.rating ?? order?.rating ?? null,
    deliveryState: {
      ...(order?.deliveryState || {}),
      currentLocation: order?.lastRiderLocation?.coordinates?.length >= 2 ? {
        lat: order.lastRiderLocation.coordinates[1],
        lng: order.lastRiderLocation.coordinates[0]
      } : (order?.deliveryState?.currentLocation || null)
    }
  };
}

export async function applyAggregateRating(model, entityId, newRating) {
  if (!entityId) return;
  const doc = await model.findById(entityId).select("rating totalRatings");
  if (!doc) return;

  const totalRatings = Number(doc.totalRatings || 0);
  const currentAverage = Number(doc.rating || 0);
  const nextTotal = totalRatings + 1;
  const nextAverage = Number(
    ((currentAverage * totalRatings + Number(newRating)) / nextTotal).toFixed(1),
  );

  doc.totalRatings = nextTotal;
  doc.rating = nextAverage;
  await doc.save();
}

export function buildDeliverySocketPayload(orderDoc, restaurantDoc = null) {
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc || {};
  const restaurant = restaurantDoc || order?.restaurantId || null;
  const restaurantLocation = restaurant?.location || {};
  const deliveryAddress = order?.deliveryAddress || {};
  const customerAddressParts = [
    deliveryAddress.street,
    deliveryAddress.additionalDetails,
    deliveryAddress.city,
    deliveryAddress.state,
    deliveryAddress.zipCode,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  // Prefer robust geo parse (GeoJSON [lng,lat], lat/lng, nested location)
  const restaurantPoint =
    parseGeoPoint(restaurant) ||
    parseGeoPoint(restaurantLocation) ||
    parseGeoPoint({
      lat: restaurantLocation?.latitude ?? restaurantLocation?.lat,
      lng: restaurantLocation?.longitude ?? restaurantLocation?.lng,
    });
  const customerPoint =
    parseGeoPoint(deliveryAddress) ||
    parseGeoPoint(order?.customerLocation) ||
    parseGeoPoint({
      lat: deliveryAddress?.latitude ?? deliveryAddress?.lat,
      lng: deliveryAddress?.longitude ?? deliveryAddress?.lng,
    });

  const restaurantLat = restaurantPoint?.lat;
  const restaurantLng = restaurantPoint?.lng;
  const customerLat = customerPoint?.lat;
  const customerLng = customerPoint?.lng;

  // Prefer road distance when already computed; fall back to pricing Haversine.
  // Never use pickupDistanceKm (rider → restaurant) here — this is restaurant ↔ customer.
  const tripDistanceKmRaw =
    order?.tripDistanceKm ??
    order?.pricing?.roadDistanceKm ??
    order?.pricing?.distanceKm;
  let tripDistanceKm = Number.isFinite(Number(tripDistanceKmRaw))
    ? Number(Number(tripDistanceKmRaw).toFixed(2))
    : null;

  // If still missing, compute Haversine restaurant → customer so UI never shows blank/wrong.
  if (
    tripDistanceKm == null &&
    Number.isFinite(restaurantLat) &&
    Number.isFinite(restaurantLng) &&
    Number.isFinite(customerLat) &&
    Number.isFinite(customerLng)
  ) {
    const hv = haversineKm(restaurantLat, restaurantLng, customerLat, customerLng);
    if (Number.isFinite(hv)) {
      tripDistanceKm = Number(Number(hv).toFixed(2));
    }
  }

  const tripDurationMinsRaw =
    order?.tripDurationMins ?? order?.pricing?.roadDurationMins;
  let tripDurationMins = Number.isFinite(Number(tripDurationMinsRaw))
    ? Math.ceil(Number(tripDurationMinsRaw))
    : null;
  if (tripDurationMins == null && tripDistanceKm != null) {
    // ~25 km/h urban delivery average → minutes
    tripDurationMins = Math.max(1, Math.ceil((tripDistanceKm * 60) / 25));
  }

  console.log(`[DEBUG] buildDeliverySocketPayload - Order: ${order?.orderId || order?._id}`);
  console.log(`[DEBUG] buildDeliverySocketPayload - riderEarning in doc: ${order?.riderEarning}`);
  console.log(`[DEBUG] buildDeliverySocketPayload - deliveryFee in doc: ${order?.pricing?.deliveryFee}`);

  return {
    orderMongoId:
      orderDoc?._id?.toString?.() || order?._id?.toString?.() || order?._id,
    orderId: order?.order_id || order?._id?.toString?.(),
    status: orderDoc?.orderStatus || order?.orderStatus,
    items: order?.items || [],
    pricing: order?.pricing,
    total: order?.pricing?.total,
    payment: order?.payment,
    paymentMethod: order?.payment?.method,
    restaurantId:
      order?.restaurantId?._id?.toString?.() ||
      order?.restaurantId?.toString?.() ||
      order?.restaurantId,
    restaurantName: restaurant?.restaurantName || order?.restaurantName,
    restaurantAddress:
      restaurantLocation?.address ||
      restaurantLocation?.formattedAddress ||
      restaurant?.addressLine1 ||
      "",
    restaurantPhone: restaurant?.phone || "",
    restaurantLocation: {
      latitude: Number.isFinite(restaurantLat) ? restaurantLat : undefined,
      longitude: Number.isFinite(restaurantLng) ? restaurantLng : undefined,
      lat: Number.isFinite(restaurantLat) ? restaurantLat : undefined,
      lng: Number.isFinite(restaurantLng) ? restaurantLng : undefined,
      coordinates:
        Number.isFinite(restaurantLat) && Number.isFinite(restaurantLng)
          ? [restaurantLng, restaurantLat]
          : undefined,
      address:
        restaurantLocation?.address ||
        restaurantLocation?.formattedAddress ||
        restaurant?.addressLine1 ||
        "",
      area: restaurantLocation?.area || restaurant?.area || "",
      city: restaurantLocation?.city || restaurant?.city || "",
      state: restaurantLocation?.state || restaurant?.state || "",
    },
    deliveryAddress: order?.deliveryAddress,
    customerLocation: {
      latitude: Number.isFinite(customerLat) ? customerLat : undefined,
      longitude: Number.isFinite(customerLng) ? customerLng : undefined,
      lat: Number.isFinite(customerLat) ? customerLat : undefined,
      lng: Number.isFinite(customerLng) ? customerLng : undefined,
      coordinates:
        Number.isFinite(customerLat) && Number.isFinite(customerLng)
          ? [customerLng, customerLat]
          : undefined,
    },
    // Restaurant ↔ customer trip distance (NOT rider pickup distance)
    tripDistanceKm,
    tripDurationMins,
    distanceKm: tripDistanceKm,
    customerAddress: customerAddressParts.length ? customerAddressParts.join(', ') : "",
    customerName: order?.customerName || order?.deliveryAddress?.fullName || order?.deliveryAddress?.name || order?.userId?.name || "",
    customerPhone: order?.customerPhone || order?.deliveryAddress?.phone || order?.userId?.phone || "",
    userName: order?.customerName || order?.deliveryAddress?.fullName || order?.deliveryAddress?.name || order?.userId?.name || "",
    userPhone: order?.customerPhone || order?.deliveryAddress?.phone || order?.userId?.phone || "",
    note: order?.deliveryInstructions || "",
    cookingNote: order?.note || "",
    deliveryInstructions: order?.deliveryInstructions || "",
    riderEarning: order?.riderEarning || 0,
    earnings: order?.riderEarning || order?.pricing?.deliveryFee || 0,
    deliveryFee: order?.pricing?.deliveryFee || 0,
    deliverySurge: order?.pricing?.deliverySurge || 0,
    deliveryFleet: order?.deliveryFleet,
    dispatch: order?.dispatch,
    createdAt: order?.createdAt,
    updatedAt: order?.updatedAt,
  };
}

export function canExposeOrderToRestaurant(orderLike) {
  if (String(orderLike?.orderStatus || "").toLowerCase() === "pending_payment") return false;
  const method = String(orderLike?.payment?.method || "").toLowerCase();
  const status = String(orderLike?.payment?.status || "").toLowerCase();
  if (["cash", "wallet"].includes(method)) return true;
  return ["paid", "authorized", "captured", "settled"].includes(status);
}

export async function notifyRestaurantNewOrder(orderDoc) {
  try {
    if (!orderDoc || !canExposeOrderToRestaurant(orderDoc)) return;

    const io = getIO();
    if (io) {
      const payload = {
        ...orderDoc.toObject(),
        orderMongoId: orderDoc._id?.toString?.() || undefined,
        orderId: orderDoc.order_id || orderDoc._id?.toString?.(),
      };
      logger.info(
        `[RestaurantOrders] Emitting new_order to ${rooms.restaurant(orderDoc.restaurantId)} for order ${orderDoc._id?.toString?.() || ''}`,
      );
      io.to(rooms.restaurant(orderDoc.restaurantId)).emit("new_order", payload);
      // Real-time broadcast to Admin Dashboard
      const adminRoom = rooms.admin ? rooms.admin() : 'admin:orders';
      io.to(adminRoom).emit("admin_new_order", payload);
    }

    await notifyOwnersSafely(
      [{ ownerType: "RESTAURANT", ownerId: orderDoc.restaurantId }],
      {
        title: "New order received",
        body: `Order #${orderDoc.order_id || orderDoc._id} is waiting for review.`,
        data: {
          type: "new_order",
          orderId: orderDoc._id.toString(),
          orderMongoId: orderDoc._id?.toString?.() || "",
          link: `/restaurant/orders/${orderDoc._id?.toString?.() || ""}`,
        },
      },
    );
  } catch {
    // Do not block order/payment flow if notification fails.
  }
}

export const CANCELLED_ORDER_STATUSES = [
  "cancelled_by_user",
  "cancelled_by_restaurant",
  "cancelled_by_admin",
];

export const normalizeOrderStatusValue = (value) => {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return "";
  return status.replace(/^canceled/, "cancelled");
};

export const isCancelledOrderStatus = (value) => {
  const status = normalizeOrderStatusValue(value);
  if (!status) return false;
  if (CANCELLED_ORDER_STATUSES.includes(status)) return true;
  if (status === "cancelled" || status === "canceled") return true;
  return status.startsWith("cancelled_by_") || status.startsWith("canceled_by_");
};

export const isCancelledOrder = (order) => {
  if (
    isCancelledOrderStatus(order?.orderStatus) ||
    isCancelledOrderStatus(order?.status)
  ) {
    return true;
  }

  const history = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
  const cancellationEntry = [...history]
    .reverse()
    .find((entry) => String(entry?.to || "").toLowerCase().includes("cancel"));

  return Boolean(
    cancellationEntry && isCancelledOrderStatus(cancellationEntry.to),
  );
};

export const STATUS_PRIORITY = {
  created: 10,
  confirmed: 20,
  preparing: 30,
  ready_for_pickup: 40,
  reached_pickup: 50,
  picked_up: 60,
  reached_drop: 70,
  delivered: 80,
  cancelled_by_user: 100,
  cancelled_by_restaurant: 100,
  cancelled_by_admin: 100,
};

/**
 * Returns true if the next status is a valid forward progression from the current status.
 * Prevents "reversing" order status (e.g. from Preparing back to Created).
 */
export function isStatusAdvance(current, next) {
  // If current status is missing, it's effectively 'created' or start of flow
  if (!current) return true;
  
  const currentPrio = STATUS_PRIORITY[current] || 0;
  const nextPrio = STATUS_PRIORITY[next] || 0;

  // Terminal states (100) cannot transition to anything else
  if (currentPrio >= 100) return false;
  
  // Delivered (80) cannot transition to anything (except maybe cancellation if allowed, but here we say no)
  if (currentPrio === 80) return false;

  // Special case: Cancellation is almost always an advance unless already delivered
  if (nextPrio === 100 && currentPrio < 80) return true;

  return nextPrio > currentPrio;
}
