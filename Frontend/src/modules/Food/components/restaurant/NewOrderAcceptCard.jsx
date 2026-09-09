import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronRight,
  Minus,
  Plus,
  Printer,
  Volume2,
  VolumeX,
} from "lucide-react";
import { getRestaurantCookingNote } from "@food/utils/orderCookingNote";
import { stopAlert } from "@food/utils/audioSessionManager";

const getOrderTotal = (orderLike) => {
  if (!orderLike) return 0;

  const directTotal = Number(orderLike.total);
  if (Number.isFinite(directTotal) && directTotal > 0) return directTotal;

  const pricingTotal = Number(orderLike.pricing?.total);
  if (Number.isFinite(pricingTotal) && pricingTotal > 0) return pricingTotal;

  const amountDue = Number(orderLike.payment?.amountDue);
  if (Number.isFinite(amountDue) && amountDue > 0) return amountDue;

  const items = Array.isArray(orderLike.items) ? orderLike.items : [];
  return items.reduce((sum, item) => {
    const price = Number(item?.price || 0);
    const qty = Number(item?.quantity || 0);
    return (
      sum +
      (Number.isFinite(price) ? price : 0) * (Number.isFinite(qty) ? qty : 0)
    );
  }, 0);
};

const getCountdownSeconds = (orderLike) => {
  const deadlineRaw = orderLike?.acceptanceDeadlineAt;
  if (!deadlineRaw) return 240;
  const deadlineMs = new Date(deadlineRaw).getTime();
  if (!Number.isFinite(deadlineMs)) return 240;
  return Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
};

const getAcceptanceWindowSeconds = (orderLike) => {
  const snapshotSeconds = Number(orderLike?.acceptanceWindowSeconds);
  if (Number.isFinite(snapshotSeconds) && snapshotSeconds > 0) {
    return Math.round(snapshotSeconds);
  }

  const deadlineMs = new Date(orderLike?.acceptanceDeadlineAt || "").getTime();
  const createdMs = new Date(orderLike?.createdAt || "").getTime();
  if (
    Number.isFinite(deadlineMs) &&
    Number.isFinite(createdMs) &&
    deadlineMs > createdMs
  ) {
    return Math.max(1, Math.round((deadlineMs - createdMs) / 1000));
  }

  return 240;
};

const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

/**
 * Per-order accept card for the New Orders tab (queue item).
 */
export default function NewOrderAcceptCard({
  order,
  isMuted = false,
  onToggleMute,
  onPrint,
  onAccept,
  onReject,
  onExpired,
}) {
  const [prepTime, setPrepTime] = useState(11);
  const [countdown, setCountdown] = useState(() => getCountdownSeconds(order));
  const [acceptSwipeProgress, setAcceptSwipeProgress] = useState(0);
  const [isAcceptingOrder, setIsAcceptingOrder] = useState(false);
  const acceptSliderRef = useRef(null);
  const acceptSwipeStartXRef = useRef(0);
  const acceptSwipeActiveRef = useRef(false);
  const expiredNotifiedRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = getCountdownSeconds(order);
      setCountdown(remaining);
      if (remaining <= 0 && !expiredNotifiedRef.current) {
        expiredNotifiedRef.current = true;
        onExpired?.(order);
      }
    }, 1000);
    setCountdown(getCountdownSeconds(order));
    return () => clearInterval(timer);
  }, [order, onExpired]);

  const totalSeconds = getAcceptanceWindowSeconds(order);
  const fillPercent =
    Number.isFinite(totalSeconds) && totalSeconds > 0
      ? Math.max(0, Math.min(100, (countdown / totalSeconds) * 100))
      : 0;
  const fillColor =
    fillPercent > 60
      ? "rgba(16, 185, 129, 0.16)"
      : fillPercent > 30
        ? "rgba(245, 158, 11, 0.18)"
        : "rgba(244, 63, 94, 0.16)";

  const cookingNote = getRestaurantCookingNote(order);
  const isExpired = countdown <= 0;

  const getSliderMetrics = () => {
    const sliderWidth = acceptSliderRef.current?.offsetWidth || 320;
    const handleWidth = 44;
    const maxTravel = Math.max(sliderWidth - handleWidth - 12, 0);
    return { maxTravel };
  };

  const handleAccept = async () => {
    if (isAcceptingOrder || isExpired) return;
    setIsAcceptingOrder(true);
    // Stop ringing immediately on accept interaction
    try {
      stopAlert(order);
    } catch {}
    try {
      await onAccept?.(order, prepTime);
    } catch {
      setIsAcceptingOrder(false);
      setAcceptSwipeProgress(0);
    }
  };

  const handleAcceptSwipeStart = (clientX) => {
    if (isAcceptingOrder || isExpired) return;
    acceptSwipeStartXRef.current = clientX;
    acceptSwipeActiveRef.current = true;
  };

  const handleAcceptSwipeMove = (clientX) => {
    if (!acceptSwipeActiveRef.current || isAcceptingOrder || isExpired) return;
    const deltaX = Math.max(clientX - acceptSwipeStartXRef.current, 0);
    const { maxTravel } = getSliderMetrics();
    setAcceptSwipeProgress(Math.min(deltaX / Math.max(maxTravel, 1), 1));
  };

  const handleAcceptSwipeEnd = () => {
    if (!acceptSwipeActiveRef.current || isAcceptingOrder) return;
    acceptSwipeActiveRef.current = false;

    if (acceptSwipeProgress >= 0.45) {
      setAcceptSwipeProgress(1);
      try {
        stopAlert(order);
      } catch {}
      setTimeout(() => {
        void handleAccept();
      }, 160);
      return;
    }

    setAcceptSwipeProgress(0);
  };

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (acceptSwipeActiveRef.current) {
        handleAcceptSwipeMove(event.clientX);
      }
    };
    const handleTouchMove = (event) => {
      if (acceptSwipeActiveRef.current && event.touches[0]) {
        if (typeof event.preventDefault === "function") event.preventDefault();
        handleAcceptSwipeMove(event.touches[0].clientX);
      }
    };
    const handlePointerEnd = () => {
      if (acceptSwipeActiveRef.current) {
        handleAcceptSwipeEnd();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handlePointerEnd);
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handlePointerEnd);
    window.addEventListener("touchcancel", handlePointerEnd);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handlePointerEnd);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handlePointerEnd);
      window.removeEventListener("touchcancel", handlePointerEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptSwipeProgress, isAcceptingOrder, isExpired]);

  const paymentRaw =
    order?.paymentMethod || order?.payment?.method;
  const paymentMethod =
    paymentRaw != null ? String(paymentRaw).toLowerCase().trim() : "";
  const isCod = paymentMethod === "cash" || paymentMethod === "cod";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, height: 0 }}
      className="w-full bg-white rounded-[24px] overflow-hidden mb-3 relative"
      style={{
        borderStyle: "solid",
        borderColor: "var(--module-theme-color, #2563EB)",
        borderWidth: "2px",
        borderTopWidth: "5px",
        boxShadow:
          "0 0 0 4px rgba(var(--module-theme-rgb, 37,99,235), 0.12), 0 10px 28px -8px rgba(var(--module-theme-rgb, 37,99,235), 0.35)",
        background:
          "linear-gradient(180deg, rgba(var(--module-theme-rgb, 37,99,235), 0.06) 0%, #ffffff 42%)",
      }}
    >
      <div
        className="px-5 py-4 border-b flex items-center justify-between gap-3"
        style={{
          borderColor: "rgba(var(--module-theme-rgb, 37,99,235), 0.18)",
          backgroundColor: "rgba(var(--module-theme-rgb, 37,99,235), 0.08)",
        }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="relative flex h-2.5 w-2.5">
              <span
                className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                style={{ backgroundColor: "var(--module-theme-color, #2563EB)" }}
              />
              <span
                className="relative inline-flex rounded-full h-2.5 w-2.5"
                style={{ backgroundColor: "var(--module-theme-color, #2563EB)" }}
              />
            </span>
            <h3
              className="font-bold tracking-wider text-[11px] uppercase"
              style={{ color: "var(--module-theme-color, #2563EB)" }}
            >
              New Order
            </h3>
          </div>
          <p className="text-xl font-black text-gray-900 tracking-tight truncate">
            {order?.orderId || "#Order"}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Desktop: timer chip next to actions */}
          <div
            className="hidden md:flex flex-col items-end px-3 py-1.5 rounded-xl border mr-1"
            style={{
              borderColor: "rgba(var(--module-theme-rgb, 37,99,235), 0.25)",
              backgroundColor: "rgba(var(--module-theme-rgb, 37,99,235), 0.08)",
            }}
          >
            <span className="text-[9px] font-black uppercase tracking-widest text-gray-400">
              Accept in
            </span>
            <span
              className="text-sm font-black tabular-nums"
              style={{ color: "var(--module-theme-color, #2563EB)" }}
            >
              {isExpired ? "00:00" : formatTime(countdown)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onPrint?.(order)}
            className="p-2.5 bg-white shadow-sm border border-gray-100 hover:bg-gray-50 rounded-full transition-colors text-gray-600"
          >
            <Printer className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onToggleMute}
            className="p-2.5 bg-white shadow-sm border border-gray-100 hover:bg-gray-50 rounded-full transition-colors text-gray-600"
          >
            {isMuted ? (
              <VolumeX className="w-4 h-4" />
            ) : (
              <Volume2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile: stacked (unchanged). Desktop: items left, summary/actions right */}
      <div className="px-5 py-4 flex flex-col gap-4 md:grid md:grid-cols-12 md:gap-5 md:items-stretch">
        {/* Order items */}
        <div className="md:col-span-7 md:pr-2 md:border-r md:border-gray-100">
          <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest mb-3">
            Order Details
          </p>
          <div className="space-y-2 max-h-[140px] md:max-h-[220px] overflow-y-auto no-scrollbar">
            {order?.items?.length ? (
              order.items.map((item, idx) => (
                <div
                  key={idx}
                  className="flex justify-between items-start gap-4"
                >
                  <div className="flex gap-2.5 min-w-0">
                    <span className="text-sm font-black text-emerald-600 bg-emerald-50 w-6 h-6 rounded-md flex items-center justify-center shrink-0">
                      {item.quantity}
                    </span>
                    <span className="text-sm font-bold text-gray-800 leading-tight">
                      {item.name}
                    </span>
                  </div>
                  <span className="text-sm font-medium text-gray-400 shrink-0">
                    ₹{(Number(item.price) || 0) * (Number(item.quantity) || 0)}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-sm text-gray-400 italic">No items found</p>
            )}
          </div>

          {order?.sendCutlery === false && (
            <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 rounded-full border border-amber-100">
              <span className="text-[10px] text-amber-700 font-black uppercase tracking-tight">
                No Cutlery Requested
              </span>
            </div>
          )}

          {cookingNote ? (
            <div className="mt-3 rounded-[16px] border border-blue-100 bg-blue-50/80 px-3.5 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-blue-500 mb-1">
                Cooking Requests
              </p>
              <p className="text-sm font-bold text-blue-900 leading-snug italic">
                "{cookingNote}"
              </p>
            </div>
          ) : null}
        </div>

        {/* Bill / payment / prep (+ desktop actions) */}
        <div className="flex flex-col gap-3 md:col-span-5 md:pl-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 p-4 rounded-[20px] border border-gray-100">
              <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1">
                Total Bill
              </p>
              <p className="text-xl font-black text-gray-900">
                ₹{getOrderTotal(order)}
              </p>
            </div>
            <div className="bg-gray-50 p-4 rounded-[20px] border border-gray-100">
              <p className="text-[9px] text-gray-400 font-black uppercase tracking-widest mb-1">
                Payment
              </p>
              <p
                className={`text-sm font-black leading-tight ${isCod ? "text-amber-600" : "text-emerald-600"}`}
              >
                {isCod ? "Cash on Delivery" : "Online Paid"}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between bg-emerald-50/50 p-4 rounded-[20px] border border-emerald-100/50">
            <span className="text-[10px] font-black text-emerald-700 uppercase tracking-widest">
              Prep Time
            </span>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setPrepTime(Math.max(1, prepTime - 1))}
                disabled={isAcceptingOrder || isExpired}
                className="w-8 h-8 flex items-center justify-center bg-white shadow-sm border border-emerald-100 rounded-full transition-all active:scale-90 text-emerald-600 disabled:opacity-50"
              >
                <Minus className="w-4 h-4 stroke-[3]" />
              </button>
              <span className="text-lg font-black text-emerald-900 w-10 text-center">
                {prepTime}
                <span className="text-xs font-bold text-emerald-600 ml-0.5">
                  m
                </span>
              </span>
              <button
                type="button"
                onClick={() => setPrepTime(prepTime + 1)}
                disabled={isAcceptingOrder || isExpired}
                className="w-8 h-8 flex items-center justify-center bg-white shadow-sm border border-emerald-100 rounded-full transition-all active:scale-90 text-emerald-600 disabled:opacity-50"
              >
                <Plus className="w-4 h-4 stroke-[3]" />
              </button>
            </div>
          </div>

          {/* Desktop actions sit with summary */}
          <div className="hidden md:flex flex-col gap-2 mt-auto pt-1">
            {isExpired ? (
              <div className="w-full h-12 rounded-2xl bg-gray-100 text-gray-500 font-bold text-sm flex items-center justify-center">
                Acceptance window expired
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleAccept()}
                disabled={isAcceptingOrder}
                className="w-full h-12 rounded-2xl bg-[#E11D48] hover:bg-[#BE185D] text-white font-black text-[14px] uppercase tracking-widest shadow-[0_8px_20px_rgba(225,29,72,0.3)] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center"
              >
                {isAcceptingOrder
                  ? "Accepting..."
                  : `Accept Order (${formatTime(countdown)})`}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                try {
                  stopAlert(order);
                } catch {}
                onReject?.(order);
              }}
              disabled={isAcceptingOrder}
              className="w-full py-2.5 rounded-2xl font-bold text-[12px] text-gray-400 hover:text-red-500 transition-colors uppercase tracking-widest disabled:opacity-50"
            >
              Decline Order
            </button>
          </div>
        </div>
      </div>

      {/* Mobile actions only — same as before */}
      <div className="px-5 pb-5 flex flex-col gap-3 md:hidden">
        {isExpired ? (
          <div className="w-full h-14 rounded-2xl bg-gray-100 text-gray-500 font-bold text-sm flex items-center justify-center">
            Acceptance window expired
          </div>
        ) : (
          <div
            ref={acceptSliderRef}
            className="relative h-14 rounded-2xl bg-gray-100 overflow-hidden select-none touch-pan-y shadow-inner border border-gray-200"
          >
            <motion.div
              className="absolute inset-y-0 left-0"
              initial={{ width: "100%", backgroundColor: fillColor }}
              animate={{
                width: `${fillPercent}%`,
                backgroundColor: fillColor,
              }}
              transition={{ duration: 1, ease: "linear" }}
            />

            <div className="absolute inset-0 flex items-center justify-center px-12">
              <span className="relative z-10 text-sm font-black text-gray-500 text-center tracking-tight">
                {isAcceptingOrder
                  ? "Accepting..."
                  : `Slide to accept (${formatTime(countdown)})`}
              </span>
            </div>

            <motion.button
              type="button"
              className="absolute left-1.5 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-[12px] bg-emerald-600 text-white shadow-lg active:scale-95 transition-transform"
              style={{
                x: (() => {
                  const { maxTravel } = getSliderMetrics();
                  return acceptSwipeProgress * maxTravel;
                })(),
              }}
              onMouseDown={(e) => handleAcceptSwipeStart(e.clientX)}
              onTouchStart={(e) =>
                handleAcceptSwipeStart(e.touches[0].clientX)
              }
              disabled={isAcceptingOrder}
            >
              <ChevronRight className="w-6 h-6 stroke-[3]" />
            </motion.button>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            try {
              stopAlert(order);
            } catch {}
            onReject?.(order);
          }}
          disabled={isAcceptingOrder}
          className="w-full py-3 rounded-2xl font-bold text-[13px] text-gray-400 hover:text-red-500 transition-colors uppercase tracking-widest disabled:opacity-50"
        >
          Decline Order
        </button>
      </div>
    </motion.div>
  );
}
