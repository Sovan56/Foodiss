/**
 * Single global "pending order" alert session for both Delivery and Restaurant apps.
 * One looping Audio (or native loop) for all mounts — idempotent start/stop.
 */
import alertSound from "@food/assets/audio/alert.mp3";

const pendingKeys = new Set();
const pendingOrders = new Map();
const keyToOrderMap = new Map();
let audio = typeof window !== "undefined" ? window.__globalAlertAudio : null;
let unlockAttempted = false;
let muted = false;
let nativeLoopActive = false;
let playInFlight = null;
let vibrationInterval = null;

function startVibrationLoop() {
  if (vibrationInterval) clearInterval(vibrationInterval);
  
  const doVibrate = () => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate([500, 300, 500]); } catch (e) {}
    }
    if (isFlutterWebView()) {
      callNativeHandlers(['vibrate', 'triggerVibration', 'vibrateDevice']);
    }
  };

  // Initial pattern
  doVibrate();
  
  // Repeat every 2.5 seconds
  vibrationInterval = setInterval(() => {
    if ((pendingOrders.size === 0 && pendingKeys.size === 0) || muted) {
      stopVibrationLoop();
      return;
    }
    doVibrate();
  }, 2500);
}

function stopVibrationLoop() {
  if (vibrationInterval) {
    clearInterval(vibrationInterval);
    vibrationInterval = null;
  }
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate(0); } catch (e) {}
  }
  if (isFlutterWebView()) {
    callNativeHandlers(['cancelVibration', 'stopVibration']);
  }
}

const resolveAudioSource = (source) => {
  if (!source) return '';
  const url = typeof source === 'object' ? (source.default || source) : source;
  return url;
};

const isFlutterWebView = () =>
  typeof window !== "undefined" &&
  Boolean(window.flutter_inappwebview) &&
  typeof window.flutter_inappwebview.callHandler === "function";

export function collectOrderAlertKeys(orderLike = {}) {
  if (orderLike == null) return [];
  if (typeof orderLike === "string" || typeof orderLike === "number") {
    const key = String(orderLike).trim();
    return key ? [key] : [];
  }

  const keys = [
    orderLike.orderMongoId,
    orderLike.order_mongo_id,
    orderLike._id,
    orderLike.mongoId,
    orderLike.orderId,
    orderLike.order_id,
    orderLike.id,
  ]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter(Boolean);

  return [...new Set(keys)];
}

export function getOrderAlertKey(orderLike = {}) {
  return collectOrderAlertKeys(orderLike)[0] || "";
}

export function isAlertRinging() {
  return (pendingOrders.size > 0 || pendingKeys.size > 0) && !muted;
}

export function isAlertMuted() {
  return muted;
}

export function getAlertPendingCount() {
  return Math.max(pendingOrders.size, pendingKeys.size > 0 ? 1 : 0);
}

function ensureAudio() {
  if (typeof window === "undefined") return null;
  if (!audio) {
    audio = window.__globalAlertAudio || new Audio(resolveAudioSource(alertSound));
    audio.preload = "auto";
    audio.loop = true;
    audio.volume = 1;
    window.__globalAlertAudio = audio;
  }
  return audio;
}

function isWebAudioPlaying() {
  const el = audio || (typeof window !== "undefined" ? window.__globalAlertAudio : null);
  return Boolean(el && !el.paused && !el.ended);
}

async function callNativeHandlers(handlerNames, payload = {}) {
  if (!isFlutterWebView()) return false;
  for (const handlerName of handlerNames) {
    try {
      await window.flutter_inappwebview.callHandler(handlerName, payload);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function startNativeLoop(orderLike = {}, context = "delivery") {
  const keys = collectOrderAlertKeys(orderLike);
  const payload = {
    title: context === "restaurant" ? "New Restaurant Order" : "New Delivery Offer",
    body: `Order #${keys[0] || ""}`.trim(),
    orderId: orderLike?.orderId || orderLike?.order_id || keys[0] || "",
    orderMongoId: orderLike?.orderMongoId || orderLike?._id || "",
    loop: true,
    action: "start",
  };

  const started = await callNativeHandlers(
    ["startAlertLoop", "startOrderAlert", "playNotificationSoundLoop"],
    payload,
  );
  if (started) {
    nativeLoopActive = true;
    return true;
  }
  return false;
}

async function stopNativeLoop() {
  if (!nativeLoopActive && !isFlutterWebView()) return;
  await callNativeHandlers(
    ["stopAlertLoop", "stopOrderAlert", "stopNotificationSound"],
    { action: "stop", loop: false },
  );
  nativeLoopActive = false;
}

function pauseWebAudio() {
  stopVibrationLoop();

  // Also stop any concurrent push sounds
  if (typeof window !== "undefined" && typeof window.__stopAllPushSounds === "function") {
    try {
      window.__stopAllPushSounds();
    } catch {}
  }

  const el = audio || (typeof window !== "undefined" ? window.__globalAlertAudio : null);
  if (el) {
    try {
      el.pause();
      el.currentTime = 0;
      el.loop = true;
    } catch {
      // ignore
    }
  }

  // Safety: ensure any stray audio elements in the page are paused
  if (typeof document !== "undefined") {
    try {
      document.querySelectorAll("audio").forEach((a) => {
        try {
          a.pause();
          a.currentTime = 0;
        } catch {}
      });
    } catch {}
  }
}

async function playWebLoop() {
  if (pendingOrders.size === 0 && pendingKeys.size === 0) {
    console.log("playWebLoop: No pending orders");
    return false;
  }
  const el = ensureAudio();
  if (!el || muted) {
    console.log("playWebLoop: el missing or muted", { el: !!el, muted });
    return false;
  }
  
  el.muted = false;
  el.volume = 1;
  el.loop = true;
  try {
    console.log("playWebLoop: Attempting to play");
    if (el.paused) {
      el.currentTime = 0;
      const playPromise = el.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn("Alert play failed:", err);
          import('sonner').then(({ toast }) => toast.error("Audio play failed: " + err.message)).catch(() => {});
        });
      }
    }
    // Always vibrate even if audio fails to play
    startVibrationLoop();
    console.log("playWebLoop: Playing successfully");
    return true;
  } catch (err) {
    console.warn("Alert playWebLoop failed:", err);
    import('sonner').then(({ toast }) => toast.error("Audio play failed: " + err.message)).catch(() => {});
    return false;
  }
}

async function ensureRinging(orderLike = {}, context = "delivery") {
  if (muted || (pendingOrders.size === 0 && pendingKeys.size === 0)) return false;
  if (nativeLoopActive || isWebAudioPlaying()) return true;

  if (playInFlight) return playInFlight;

  playInFlight = (async () => {
    // Try to start native loop (returns true even if handler is missing because it doesn't throw)
    const nativeStarted = await startNativeLoop(orderLike, context);

    // One-shot native feedback (non-loop)
    await callNativeHandlers(
      ["playNotificationSound", "triggerNotificationFeedback"],
      {
        title: context === "restaurant" ? "New Restaurant Order" : "New Delivery Offer",
        body: "New order waiting",
        orderId: getOrderAlertKey(orderLike),
        disableActions: true,
      },
    );

    // Always fallback to web loop because the current Flutter apps don't implement the native audio handlers.
    // The native callHandler resolves to null instead of throwing, so nativeStarted is misleadingly true.
    return playWebLoop();
  })().finally(() => {
    playInFlight = null;
  });

  return playInFlight;
}

/**
 * Unlock autoplay on a user gesture. Safe to call many times.
 */
export async function unlockAlertAudio() {
  if (typeof window === "undefined") return false;
  const el = ensureAudio();
  if (!el) return false;
  if (unlockAttempted && !el.paused) return true;

  unlockAttempted = true;
  try {
    // To unlock UNMUTED autoplay in modern browsers, we must play unmuted during a user gesture.
    el.muted = false;
    el.volume = 0.01; // barely audible
    el.loop = false;
    
    if (!el.src || el.src === window.location.href) {
      el.src = resolveAudioSource(alertSound);
    }
    el.load();

    const playPromise = el.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        // Wait a tiny bit before pausing to avoid 'interrupted by pause' DOMException
        setTimeout(() => {
          el.pause();
          el.currentTime = 0;
          el.volume = 1;
          el.loop = true;
          if ((pendingOrders.size > 0 || pendingKeys.size > 0) && !muted) {
            void ensureRinging();
          }
        }, 50);
      }).catch(err => {
        console.warn("Alert unlock play failed:", err);
        unlockAttempted = false;
      });
    }
    return true;
  } catch (err) {
    console.warn("Alert unlock failed:", err);
    import('sonner').then(({ toast }) => toast.error("Audio unlock failed: " + err.message)).catch(() => {});
    unlockAttempted = false;
    if (el) el.muted = false;
    return false;
  }
}

/**
 * Add pending order keys and start looping sound only if not already ringing.
 */
export async function startAlert(orderLike = {}, context = "delivery") {
  const keys = collectOrderAlertKeys(orderLike);
  if (!keys.length) return { ok: false, reason: "no_key" };

  let primaryId = null;
  for (const k of keys) {
    if (keyToOrderMap.has(k)) {
      primaryId = keyToOrderMap.get(k);
      break;
    }
  }
  if (!primaryId) {
    primaryId = keys[0];
  }

  const existingKeys = pendingOrders.get(primaryId) || new Set();
  keys.forEach((k) => {
    existingKeys.add(k);
    pendingKeys.add(k);
    keyToOrderMap.set(k, primaryId);
  });
  pendingOrders.set(primaryId, existingKeys);

  const alreadyPending = pendingOrders.size > 1;

  if (muted) {
    return { ok: true, ringing: false, reason: "muted", alreadyPending };
  }

  // Idempotent: another pending order already owns the audible session.
  if (alreadyPending && (nativeLoopActive || isWebAudioPlaying())) {
    return { ok: true, ringing: true, continued: true };
  }

  const started = await ensureRinging(orderLike, context);
  return { ok: true, ringing: started, continued: alreadyPending };
}

/**
 * Remove this order from the pending set. Stops sound only when none remain.
 */
export function stopAlert(orderLike = {}) {
  const keys = collectOrderAlertKeys(orderLike);

  // If no specific key is passed, or if only 1 pending order exists, stop immediately
  if (!keys.length || pendingOrders.size <= 1 || pendingKeys.size <= 2) {
    return stopAllAlerts();
  }

  const affectedPrimaryIds = new Set();
  for (const k of keys) {
    pendingKeys.delete(k);
    if (keyToOrderMap.has(k)) {
      affectedPrimaryIds.add(keyToOrderMap.get(k));
    } else if (pendingOrders.has(k)) {
      affectedPrimaryIds.add(k);
    }
  }

  for (const primaryId of affectedPrimaryIds) {
    const orderKeys = pendingOrders.get(primaryId);
    if (orderKeys) {
      for (const k of orderKeys) {
        pendingKeys.delete(k);
        keyToOrderMap.delete(k);
      }
    }
    pendingOrders.delete(primaryId);
  }

  if (pendingOrders.size === 0 || pendingKeys.size === 0) {
    pauseWebAudio();
    void stopNativeLoop();
    return { ok: true, ringing: false };
  }

  return { ok: true, ringing: !muted };
}

export function stopAllAlerts() {
  pendingOrders.clear();
  keyToOrderMap.clear();
  pendingKeys.clear();
  pauseWebAudio();
  void stopNativeLoop();
  return { ok: true, ringing: false };
}

/**
 * Align session with current confirmed/pending orders from REST poll.
 * Drops keys that are no longer waiting; starts/keeps ring if any remain.
 */
export function syncAlertsWithOrders(orderList = [], context = "delivery") {
  const incomingOrderKeys = new Set();
  const incomingList = Array.isArray(orderList) ? orderList : [];

  incomingList.forEach((order) => {
    collectOrderAlertKeys(order).forEach((k) => incomingOrderKeys.add(k));
  });

  // Remove pending orders that are no longer in incoming list
  for (const [primaryId, orderKeys] of [...pendingOrders.entries()]) {
    const isStillActive = [...orderKeys].some((k) => incomingOrderKeys.has(k));
    if (!isStillActive) {
      for (const k of orderKeys) {
        pendingKeys.delete(k);
        keyToOrderMap.delete(k);
      }
      pendingOrders.delete(primaryId);
    }
  }

  for (const key of [...pendingKeys]) {
    if (!incomingOrderKeys.has(key)) {
      pendingKeys.delete(key);
      keyToOrderMap.delete(key);
    }
  }

  if (pendingOrders.size === 0 && pendingKeys.size === 0) {
    pauseWebAudio();
    void stopNativeLoop();
    return { ok: true, ringing: false, pending: 0 };
  }

  if (!muted) {
    void ensureRinging(incomingList[0] || {}, context);
  }
  return { ok: true, ringing: !muted, pending: pendingOrders.size };
}

export function setAlertMuted(nextMuted) {
  muted = Boolean(nextMuted);
  if (muted) {
    pauseWebAudio();
    void stopNativeLoop();
    return { muted: true, ringing: false };
  }
  if (pendingKeys.size > 0) {
    void ensureRinging();
    return { muted: false, ringing: true };
  }
  return { muted: false, ringing: false };
}

/** Attach once: unlock audio on first user gesture anywhere in the app. */
export function attachAlertUnlockListeners() {
  if (typeof window === "undefined") return () => {};

  const onGesture = () => {
    void unlockAlertAudio();
  };

  window.addEventListener("pointerdown", onGesture, { passive: true });
  window.addEventListener("keydown", onGesture);
  window.addEventListener("touchstart", onGesture, { passive: true });

  return () => {
    window.removeEventListener("pointerdown", onGesture);
    window.removeEventListener("keydown", onGesture);
    window.removeEventListener("touchstart", onGesture);
  };
}
