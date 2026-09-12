import mongoose from 'mongoose';
import { FoodOrder } from '../models/order.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodFeeSettings } from '../../admin/models/feeSettings.model.js';
import { FoodZone } from '../../admin/models/zone.model.js';
import { FoodZoneDeliverySurge } from '../../admin/models/zoneDeliverySurge.model.js';
import { FoodOffer } from '../../admin/models/offer.model.js';
import { FoodOfferUsage } from '../../admin/models/offerUsage.model.js';
import { FoodRainIncentiveSettings } from '../../admin/models/foodDeliveryIncentive.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
  calculateDistanceKm,
  normalizeDeliveryAddress,
  normalizeRestaurantLocation,
  parseGeoPoint,
} from '../../shared/geo.utils.js';
import { fetchDrivingRoute } from '../utils/googleMaps.js';
import { attachOutletTimingsToRestaurants } from '../../restaurant/services/outletTimings.service.js';
import { getRestaurantAvailabilityStatus } from '../../restaurant/helpers/restaurantAvailability.helper.js';
import { resolveOrderCartItems } from '../helpers/order-cart-items.helper.js';
import { calculateDeliverySurgeFromConfig } from '../utils/deliverySurge.utils.js';
import {
  FEATURE_KEYS,
  isFeatureEnabled,
} from '../../admin/services/featureSettings.service.js';

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Fixed 18% GST on delivery fee (separate from item GST in fee settings). */
export const DELIVERY_FEE_GST_RATE = 0.18;

export function computeDeliveryFeeGst(deliveryFee, deliverySurge = 0) {
  const base = Math.max(0, Number(deliveryFee) || 0) + Math.max(0, Number(deliverySurge) || 0);
  if (base <= 0) return 0;
  return round2(base * DELIVERY_FEE_GST_RATE);
}

const applyDeliveryModePricing = (pricing, deliveryMode, quickSurcharge = 0) => {
  const surcharge = Math.max(0, Number(quickSurcharge) || 0);
  const mode = deliveryMode === 'quick' ? 'quick' : 'basic';
  if (mode !== 'quick' || surcharge <= 0) {
    return {
      ...pricing,
      deliveryMode: mode,
      quickDeliveryFee: 0,
    };
  }
  const platformFee = round2((Number(pricing.platformFee) || 0) + surcharge);
  const total = round2((Number(pricing.total) || 0) + surcharge);
  return {
    ...pricing,
    platformFee,
    total,
    deliveryMode: mode,
    quickDeliveryFee: surcharge,
  };
};

export async function loadRestaurantForOrdering(restaurantId) {
  if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
    throw new ValidationError('Restaurant not found');
  }

  const doc = await FoodRestaurant.findById(restaurantId)
    .select(
      'status restaurantName zoneId location isAcceptingOrders outsideHoursOverride openingTime closingTime openDays deliveryTimings isActive',
    )
    .lean();

  if (!doc) throw new ValidationError('Restaurant not found');
  if (doc.status !== 'approved') throw new ValidationError('Restaurant not available');

  const [withTimings] = await attachOutletTimingsToRestaurants([doc], {
    useDefaults: false,
  });
  if (withTimings?.location) {
    withTimings.location = normalizeRestaurantLocation(withTimings.location);
  }
  return withTimings;
}

export function assertRestaurantOpenForOrdering(restaurant, at = new Date()) {
  const availability = getRestaurantAvailabilityStatus(restaurant, at);
  if (availability.isOpen) return availability;

  if (availability.reason === 'not-accepting-orders') {
    throw new ValidationError('Restaurant is currently offline. Please try again later.');
  }

  throw new ValidationError('Restaurant is currently closed. Please try again later.');
}

/**
 * Single source of truth for restaurant ↔ customer trip distance.
 * Prefer Google driving/road km (matches delivery partner Rest→User UI);
 * fall back to Haversine when Directions is unavailable or admin toggles Google off.
 */
export async function getDeliveryDistanceKm(restaurant, deliveryAddress) {
  const straightLineKm = calculateDistanceKm(restaurant, deliveryAddress);

  const restaurantPoint = parseGeoPoint(restaurant);
  const customerPoint = parseGeoPoint(deliveryAddress);
  if (!restaurantPoint || !customerPoint) {
    return straightLineKm;
  }

  const googleOrderRoadEnabled = await isFeatureEnabled(
    FEATURE_KEYS.GOOGLE_ORDER_ROAD_DISTANCE,
    true,
  );
  if (!googleOrderRoadEnabled) {
    return straightLineKm;
  }

  try {
    const route = await fetchDrivingRoute(
      { lat: restaurantPoint.lat, lng: restaurantPoint.lng },
      { lat: customerPoint.lat, lng: customerPoint.lng },
    );
    if (route?.distanceKm != null && Number.isFinite(Number(route.distanceKm))) {
      return Number(route.distanceKm);
    }
  } catch {
    // Fall through to Haversine.
  }

  return straightLineKm;
}

// Single money-rounding rule (2 decimals) so preview and charged totals always match.

function resolveBaseDeliveryFee(feeSettings = {}) {
  const ranges = Array.isArray(feeSettings.deliveryFeeRanges)
    ? feeSettings.deliveryFeeRanges
    : [];
  const rangeFees = ranges
    .map((range) => Number(range?.fee))
    .filter((fee) => Number.isFinite(fee) && fee >= 0);

  const flat = Number(feeSettings.deliveryFee);
  const hasPositiveFlat = Number.isFinite(flat) && flat > 0;

  if (rangeFees.length > 0) {
    const minRangeFee = Math.min(...rangeFees);
    return hasPositiveFlat ? flat : minRangeFee;
  }

  return Number.isFinite(flat) && flat >= 0 ? flat : 0;
}

function matchFeeRange(ranges, distanceKm, pickValue) {
  if (!Array.isArray(ranges) || ranges.length === 0 || !Number.isFinite(distanceKm)) {
    return null;
  }

  const sorted = [...ranges].sort((a, b) => Number(a.min) - Number(b.min));
  for (let i = 0; i < sorted.length; i += 1) {
    const range = sorted[i] || {};
    const min = Number(range.min);
    const max = Number(range.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;

    const isLast = i === sorted.length - 1;
    const inRange = isLast
      ? distanceKm >= min && distanceKm <= max
      : distanceKm >= min && distanceKm < max;

    if (inRange) {
      const value = pickValue(range);
      return Number.isFinite(value) ? value : null;
    }
  }

  return null;
}

export async function loadActiveFeeSettings() {
  const feeDoc = await FoodFeeSettings.findOne({ isActive: { $ne: false } })
    .sort({ createdAt: -1 })
    .lean();

  return (
    feeDoc || {
      deliveryFee: 0,
      deliveryFeeRanges: [],
      platformFee: 0,
      gstRate: 0,
    }
  );
}

export function resolveUserDeliveryFee(feeSettings = {}, { subtotal = 0, distanceKm = null } = {}) {
  const ranges = Array.isArray(feeSettings.deliveryFeeRanges)
    ? feeSettings.deliveryFeeRanges
    : [];

  if (ranges.length > 0 && Number.isFinite(distanceKm)) {
    const matchedFee = matchFeeRange(ranges, distanceKm, (range) => Number(range.fee));
    if (Number.isFinite(matchedFee)) {
      return {
        deliveryFee: matchedFee,
        distanceKm: Number(distanceKm.toFixed(2)),
        source: 'distance',
      };
    }
  }

  const fallbackFee = resolveBaseDeliveryFee(feeSettings);
  return {
    deliveryFee: fallbackFee,
    distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    source: Number.isFinite(distanceKm) ? 'default_unmatched_range' : 'default',
  };
}

export async function loadZoneDeliverySurge(zoneId, baseDeliveryFee) {
  if (!zoneId || !mongoose.Types.ObjectId.isValid(String(zoneId))) {
    return calculateDeliverySurgeFromConfig(null, baseDeliveryFee);
  }

  const [zone, surge] = await Promise.all([
    FoodZone.findById(zoneId).select('isActive').lean(),
    FoodZoneDeliverySurge.findOne({ zoneId }).lean(),
  ]);

  if (!zone || zone.isActive === false) {
    return calculateDeliverySurgeFromConfig(null, baseDeliveryFee);
  }

  return calculateDeliverySurgeFromConfig(surge, baseDeliveryFee);
}

export function calculateRiderEarning(feeSettings = {}, distanceKm, deliverySurge = 0) {
  const surge = Math.max(0, Number(deliverySurge) || 0);
  const distance = Number(distanceKm);
  if (!Number.isFinite(distance) || distance < 0) return surge;

  const ranges = Array.isArray(feeSettings.deliveryFeeRanges)
    ? feeSettings.deliveryFeeRanges
    : [];
  if (ranges.length === 0) return surge;

  const earning = matchFeeRange(ranges, distance, (range) => {
    const basePay = Number(range.deliveryBoyBasePay || 0);
    const perKm = Number(range.deliveryBoyPerKm || 0);

    if (basePay > 0) return basePay;
    if (perKm > 0) return distance * perKm;
    return 0;
  });

  return Number.isFinite(earning) ? Math.round(earning) + surge : surge;
}

export async function calculateRainIncentive(riderEarning, lat, lng) {
  const settings = await FoodRainIncentiveSettings.findOne({ key: 'global' }).lean();
  
  if (!settings || !settings.isEnabled) {
    return {
      rainIncentiveApplied: false,
      rainIncentiveType: null,
      rainIncentiveValue: 0,
      rainIncentiveAmount: 0
    };
  }

  let rainIncentiveAmount = 0;
  if (settings.incentiveType === 'FIXED') {
    rainIncentiveAmount = Number(settings.incentiveValue) || 0;
  } else if (settings.incentiveType === 'PERCENTAGE') {
    rainIncentiveAmount = Math.round((Number(riderEarning) * (Number(settings.incentiveValue) || 0)) / 100);
  }

  return {
    rainIncentiveApplied: true,
    rainIncentiveType: settings.incentiveType,
    rainIncentiveValue: settings.incentiveValue,
    rainIncentiveAmount
  };
}

export async function calculateOrderPricing(userId, dto, options = {}) {
  const at = options.at instanceof Date ? options.at : new Date();
  const restaurant =
    options.restaurant || (await loadRestaurantForOrdering(dto.restaurantId));

  if (!options.skipAvailabilityCheck) {
    assertRestaurantOpenForOrdering(restaurant, at);
  }

  const deliveryAddress = normalizeDeliveryAddress(dto.deliveryAddress);

  const resolvedItems = await resolveOrderCartItems(dto.restaurantId, dto.items);
  const items = resolvedItems.map((item) => ({
    ...item,
    price: Number(item.price) || 0,
    quantity: Number(item.quantity) || 1,
  }));
  const subtotal = round2(
    items.reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 1),
      0,
    ),
  );

  const feeSettings = await loadActiveFeeSettings();

  const packagingFee = 0;
  const platformFee = Number(feeSettings.platformFee || 0);

  let distanceKm = await getDeliveryDistanceKm(restaurant, deliveryAddress);
  const straightLineKm = calculateDistanceKm(restaurant, deliveryAddress);

  const deliveryFeeResult = resolveUserDeliveryFee(feeSettings, { subtotal, distanceKm });
  const deliveryFee = round2(deliveryFeeResult.deliveryFee);
  distanceKm = deliveryFeeResult.distanceKm ?? distanceKm;

  const zoneId = dto.zoneId || restaurant?.zoneId || null;
  const surgeResult = await loadZoneDeliverySurge(zoneId, deliveryFee);
  const deliverySurge = round2(surgeResult.deliverySurge);

  let discount = 0;
  let appliedCoupon = null;
  const codeRaw = dto.couponCode
    ? String(dto.couponCode).trim().toUpperCase()
    : "";

  if (codeRaw) {
    const now = new Date();
    const offer = await FoodOffer.findOne({ couponCode: codeRaw }).lean();
    if (offer) {
      const offerEnd = offer.endDate ? new Date(offer.endDate) : null;
      if (offerEnd && offerEnd.getHours() === 0 && offerEnd.getMinutes() === 0) {
        offerEnd.setHours(23, 59, 59, 999);
      }
      const endOk = !offerEnd || now <= offerEnd;
      const startOk = !offer.startDate || now >= new Date(offer.startDate);
      const statusOk = offer.status === "active" && offer.showInCart !== false;
      const selectedRestaurantIds = Array.isArray(offer.restaurantIds) && offer.restaurantIds.length > 0
        ? offer.restaurantIds
        : [offer.restaurantId].filter(Boolean);
      const scopeOk =
        offer.restaurantScope !== "selected" ||
        selectedRestaurantIds.some((id) => String(id) === String(dto.restaurantId || ""));
      const minOk = subtotal >= (Number(offer.minOrderValue) || 0);
      let usageOk = true;
      if (
        Number(offer.usageLimit) > 0 &&
        Number(offer.usedCount || 0) >= Number(offer.usageLimit)
      ) {
        usageOk = false;
      }

      let perUserOk = true;
      if (userId && mongoose.Types.ObjectId.isValid(userId) && Number(offer.perUserLimit) > 0) {
        const usage = await FoodOfferUsage.findOne({
          offerId: offer._id,
          userId: new mongoose.Types.ObjectId(userId),
        }).lean();
        if (usage && Number(usage.count) >= Number(offer.perUserLimit)) {
          perUserOk = false;
        }
      }

      let firstOrderOk = true;
      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        if (offer.customerScope === "first-time") {
          const c = await FoodOrder.countDocuments({
            userId: new mongoose.Types.ObjectId(userId),
          });
          firstOrderOk = c === 0;
        }
        if (offer.isFirstOrderOnly === true) {
          const c2 = await FoodOrder.countDocuments({
            userId: new mongoose.Types.ObjectId(userId),
          });
          if (c2 > 0) firstOrderOk = false;
        }
      }

      const allowed =
        statusOk &&
        startOk &&
        endOk &&
        scopeOk &&
        minOk &&
        usageOk &&
        perUserOk &&
        firstOrderOk;

      if (allowed) {
        if (offer.discountType === "percentage") {
          const raw = subtotal * (Number(offer.discountValue) / 100);
          const capped = Number(offer.maxDiscount)
            ? Math.min(raw, Number(offer.maxDiscount))
            : raw;
          discount = Math.max(0, Math.min(subtotal, Math.floor(capped)));
        } else {
          discount = Math.max(
            0,
            Math.min(subtotal, Math.floor(Number(offer.discountValue) || 0)),
          );
        }
        appliedCoupon = { code: codeRaw, discount };
      }
    }
  }

  // GST is charged on the post-discount item value (discount is already clamped to <= subtotal).
  const gstRate = Number(feeSettings.gstRate || 0);
  const tax =
    Number.isFinite(gstRate) && gstRate > 0
      ? Math.round(Math.max(0, subtotal - discount) * (gstRate / 100))
      : 0;

  const deliveryFeeGst = computeDeliveryFeeGst(deliveryFee, deliverySurge);

  const total = round2(
    Math.max(
      0,
      subtotal + packagingFee + deliveryFee + deliverySurge + deliveryFeeGst + platformFee + tax - discount,
    ),
  );

  const basePricing = {
    subtotal,
    tax,
    packagingFee,
    deliveryFee,
    deliverySurge,
    deliverySurgeType: surgeResult.deliverySurgeType || 'none',
    deliverySurgeValue: surgeResult.deliverySurgeValue || 0,
    deliveryFeeGst,
    platformFee,
    discount,
    total,
    currency: "INR",
    couponCode: appliedCoupon?.code || codeRaw || null,
    appliedCoupon,
    distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    roadDistanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
    straightLineDistanceKm: Number.isFinite(straightLineKm)
      ? Number(straightLineKm.toFixed(2))
      : null,
    deliveryFeeBreakdown: deliveryFeeResult.breakdown || null,
  };

  const pricing = applyDeliveryModePricing(
    basePricing,
    dto.deliveryMode,
    Number(feeSettings.quickDeliveryFee) || 0,
  );

  const priceChanges = (Array.isArray(dto.items) ? dto.items : [])
    .map((rawItem) => {
      const itemId = String(rawItem?.itemId || rawItem?.id || '').trim();
      const resolved = items.find((entry) => String(entry.itemId) === itemId);
      if (!resolved) return null;

      const previousPrice = Number(rawItem?.price);
      const nextPrice = Number(resolved.price);
      if (!Number.isFinite(previousPrice) || previousPrice === nextPrice) return null;

      return {
        itemId,
        name: resolved.name,
        previousPrice,
        price: nextPrice,
      };
    })
    .filter(Boolean);

  return {
    items,
    priceChanges,
    pricing: {
      ...pricing,
      deliveryFeeBreakdown: {
        source: deliveryFeeResult.source,
        distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null,
        deliveryFee,
        deliverySurge,
        deliverySurgeType: surgeResult.deliverySurgeType || 'none',
        deliverySurgeValue: surgeResult.deliverySurgeValue || 0,
        message: Number.isFinite(distanceKm)
          ? `Distance: ${Number(distanceKm).toFixed(1)} km`
          : null,
      },
    },
  };
}
