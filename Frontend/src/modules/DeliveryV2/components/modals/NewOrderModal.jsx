import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { MapPin, Clock } from 'lucide-react';
import { ActionSlider } from '@/modules/DeliveryV2/components/ui/ActionSlider';
import { resolveCustomerAddress } from '@/modules/DeliveryV2/utils/orderAddress';
import { getUserRestaurantDistance, normalizeRestaurantLocation } from '@food/utils/geo';
import { fetchDrivingDistanceKm, formatDistanceLabel } from '@food/utils/roadDistance';
import { isGoogleOrderRoadDistanceEnabled } from '@food/utils/googleDistanceFeatures';

/**
 * NewOrderModal — Rest → User distance.
 * Prefer Google road trip km (what partners said is correct, e.g. 7.7),
 * then client Directions, then Haversine fallback (~6.9).
 * Client Directions is gated by admin Google Order / Pricing Road Distance toggle.
 */
export const NewOrderModal = ({ order, onAccept, onReject, onMinimize, swapGuard = false }) => {
  const [timeLeft, setTimeLeft] = useState(30);
  const [lockedOrder] = useState(() => order);
  const [distanceLabel, setDistanceLabel] = useState(null);
  const [etaMins, setEtaMins] = useState(null);
  const [isAccepted, setIsAccepted] = useState(false);

  useEffect(() => {
    if (timeLeft <= 0) {
      if (!isAccepted) onReject();
      return;
    }
    const timer = setInterval(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearInterval(timer);
  }, [timeLeft, onReject, isAccepted]);

  useEffect(() => {
    if (!lockedOrder) return undefined;
    let cancelled = false;

    const restaurantLoc = normalizeRestaurantLocation(
      lockedOrder.restaurantId?.location ||
        lockedOrder.restaurant?.location ||
        lockedOrder.restaurantLocation ||
        lockedOrder.restaurantId ||
        lockedOrder.restaurant,
    );

    const customerLoc =
      lockedOrder.deliveryAddress ||
      lockedOrder.customerLocation ||
      lockedOrder.deliveryAddress?.location;

    const apply = (km, mins = null) => {
      if (cancelled || km == null || !Number.isFinite(Number(km))) return;
      setDistanceLabel(formatDistanceLabel(km));
      if (mins != null && Number(mins) > 0) {
        setEtaMins(Math.ceil(Number(mins)));
      } else {
        setEtaMins(Math.max(1, Math.ceil((Number(km) * 60) / 25)));
      }
    };

    const resolveDistance = async () => {
      // 1) Backend road / trip fields
      const tripKm =
        lockedOrder.tripDistanceKm ??
        lockedOrder.pricing?.roadDistanceKm ??
        lockedOrder.distanceKm ??
        lockedOrder.pricing?.distanceKm;
      const tripEta =
        lockedOrder.tripDurationMins ??
        lockedOrder.pricing?.roadDurationMins ??
        lockedOrder.estimatedTime ??
        lockedOrder.duration ??
        lockedOrder.eta;

      if (tripKm != null && Number.isFinite(Number(tripKm))) {
        // Prefer true road when both road + haversine-looking pricing are present:
        // if only pricing.distanceKm / distanceKm without road fields, still try Directions.
        const hasExplicitRoad =
          lockedOrder.tripDistanceKm != null ||
          lockedOrder.pricing?.roadDistanceKm != null;
        if (hasExplicitRoad) {
          apply(tripKm, tripEta);
          return;
        }
      }

      // 2) Google Directions restaurant → customer (admin-gated)
      const googleEnabled = await isGoogleOrderRoadDistanceEnabled();
      if (googleEnabled) {
        const roadKm = await fetchDrivingDistanceKm(restaurantLoc, customerLoc);
        if (!cancelled && roadKm != null) {
          apply(roadKm);
          return;
        }
      }

      // 3) Backend trip/pricing km if Directions unavailable / disabled
      if (tripKm != null && Number.isFinite(Number(tripKm))) {
        apply(tripKm, tripEta);
        return;
      }

      // 4) Haversine fallback
      const measured = getUserRestaurantDistance(customerLoc, restaurantLoc);
      if (measured) apply(measured.km);
      else {
        setDistanceLabel('--');
        setEtaMins('--');
      }
    };

    resolveDistance();
    return () => {
      cancelled = true;
    };
  }, [lockedOrder]);

  if (!lockedOrder) return null;

  const earnings = lockedOrder.earnings || lockedOrder.riderEarning || (lockedOrder.orderAmount ? lockedOrder.orderAmount * 0.1 : 0);
  const deliverySurge = Number(lockedOrder.deliverySurge || lockedOrder.pricing?.deliverySurge || 0);
  const restaurantName =
    lockedOrder.restaurantName ||
    lockedOrder.restaurant_name ||
    lockedOrder.restaurant?.restaurantName ||
    lockedOrder.restaurant?.name ||
    lockedOrder.restaurantId?.restaurantName ||
    lockedOrder.restaurantId?.name ||
    'Restaurant';
  const restaurantAddress = lockedOrder.restaurantAddress || lockedOrder.restaurant_address || (lockedOrder.restaurantId?.location?.address) || 'Address not available';
  const customerAddress = resolveCustomerAddress(lockedOrder) || 'Location not available';
  const mapsLink = customerAddress !== 'Location not available'
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customerAddress)}`
    : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[150] bg-black/60 backdrop-blur-sm flex items-end justify-center"
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.5 }}
        onDragEnd={(e, info) => {
          if (!isAccepted && (info.offset.y > 100 || info.velocity.y > 400)) {
            onReject();
          }
        }}
        className="w-full max-w-lg bg-white rounded-t-[3.5rem] shadow-[0_-25px_80px_rgba(0,0,0,0.5)] flex flex-col max-h-[85vh] relative overflow-hidden"
      >
        <div className="w-full flex justify-center py-3 bg-white relative z-20">
          <button
            onClick={onMinimize}
            className="w-12 h-1.5 bg-gray-200 rounded-full hover:bg-gray-300 transition-colors active:scale-95"
            aria-label="Minimize"
          />
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar">
          <div
            className="px-6 py-5 flex justify-between items-center text-white"
            style={{
              backgroundColor: "var(--module-theme-color, #00B761)",
              borderBottom: "1px solid rgba(var(--module-theme-rgb, 0,183,97), 0.25)",
            }}
          >
            <div>
              <p className="text-white/80 text-[10px] font-black uppercase tracking-[0.2em] mb-1">
                New Order <span className="opacity-50 mx-1">•</span> #{lockedOrder?.shortId || lockedOrder?.orderId || lockedOrder?._id?.slice(-6) || 'N/A'}
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold opacity-80">₹</span>
                <h2 className="text-4xl font-black tracking-tighter">{Number(earnings || 0).toFixed(2)}</h2>
              </div>
              {deliverySurge > 0 && (
                <p className="text-[10px] text-white/75 mt-1 font-semibold">
                  Includes ₹{deliverySurge.toFixed(0)} zone surge
                </p>
              )}
            </div>
            <div className="bg-black/15 border border-white/20 rounded-2xl px-4 py-2 text-white flex flex-col items-center min-w-[80px]">
              <span className="text-[9px] font-black uppercase tracking-widest opacity-60">Expires</span>
              <span className="font-black text-2xl tabular-nums leading-none">{timeLeft}s</span>
            </div>
          </div>

          <div className="px-6 py-4 space-y-5">
            <div className="flex gap-2">
               <div className="flex-1 p-3 bg-gray-50 rounded-2xl border border-gray-100 flex items-center gap-3">
                 <div className="w-9 h-9 rounded-xl bg-white shadow-sm flex items-center justify-center text-emerald-500">
                    <Clock className="w-5 h-5" />
                 </div>
                 <div className="flex flex-col">
                    <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest leading-none mb-1">Trip Time</span>
                    <span className="text-sm font-black text-gray-900 tracking-tight leading-none">{etaMins ?? '--'} MINS</span>
                 </div>
               </div>
               <div className="flex-1 p-3 bg-gray-50 rounded-2xl border border-gray-100 flex items-center gap-3">
                 <div className="w-9 h-9 rounded-xl bg-white shadow-sm flex items-center justify-center text-blue-500">
                    <MapPin className="w-5 h-5" />
                 </div>
                 <div className="flex flex-col">
                    <span className="text-[9px] text-gray-400 font-black uppercase tracking-widest leading-none mb-1">Rest → User</span>
                    <span className="text-sm font-black text-gray-900 tracking-tight leading-none">{distanceLabel ?? '--'}</span>
                 </div>
               </div>
            </div>

            <div className="bg-gray-50/50 rounded-3xl p-5 border border-gray-100/50">
              <div className="flex gap-4 relative">
                <div className="flex flex-col items-center py-1">
                  <div className="w-3 h-3 rounded-full bg-emerald-500 shadow-lg shadow-emerald-500/20" />
                  <div className="flex-1 w-0.5 border-l-2 border-dashed border-gray-200 my-1" />
                  <div className="w-3 h-3 rounded-full bg-blue-500 shadow-lg shadow-blue-500/20" />
                </div>

                <div className="flex-1 space-y-4">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-[0.15em] text-emerald-600 mb-0.5">Restaurant Pickup</h4>
                    <h3 className="text-gray-950 font-black text-lg leading-tight mb-0.5 line-clamp-1">{restaurantName}</h3>
                    <p className="text-gray-500 text-[11px] font-bold line-clamp-1">{restaurantAddress}</p>
                  </div>
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-[0.15em] text-blue-600 mb-0.5">Customer Drop</h4>
                    {mapsLink ? (
                      <a
                        href={mapsLink}
                        target="_blank"
                        rel="noreferrer"
                        className="text-gray-950 font-black text-base leading-tight underline decoration-blue-200 underline-offset-2"
                      >
                        {customerAddress}
                      </a>
                    ) : (
                      <p className="text-gray-950 font-black text-base leading-tight">{customerAddress}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 pt-2 bg-white border-t border-gray-50 space-y-3">
          {swapGuard && (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-xs font-black uppercase tracking-wider">
              <span className="text-base leading-none">⚠</span>
              Order changed — previous offer was taken. Review before accepting.
            </div>
          )}
          <ActionSlider
            label="Slide to Accept"
            disabled={swapGuard || isAccepted}
            onConfirm={() => {
              setIsAccepted(true);
              onAccept?.(lockedOrder);
            }}
            color="var(--module-theme-color, #00B761)"
          />
          <button
            onClick={() => { if (!isAccepted) onReject(); }}
            disabled={isAccepted}
            className={`w-full py-3 text-sm font-black uppercase tracking-widest transition-colors ${isAccepted ? 'text-gray-200' : 'text-gray-400 hover:text-red-500'}`}
          >
            Reject Order
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};
