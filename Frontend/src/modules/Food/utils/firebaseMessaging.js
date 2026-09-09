import { toast } from "sonner";
import { userAPI, restaurantAPI, deliveryAPI, adminAPI } from "@food/api";
import { initializeApp, getApp, getApps } from "firebase/app";
import fallbackNotificationSound from "@food/assets/audio/alert.mp3";

const pushNotificationSoundPath = "/zomato_sms.mp3";

const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  appId: "",
  messagingSenderId: "",
};

const tokenCachePrefix = "fcm_web_registered_token_";
const pushSoundEnabledStorageKey = "push_sound_enabled";
let publicEnvPromise = null;
let foregroundListenerAttached = false;
let registrationInFlight = null;
let lastWebRegistrationAtByModule = new Map();
let serviceWorkerMessageListenerAttached = false;
const MESSAGING_APP_NAME = "web-push-app";
const recentForegroundNotifications = new Map();
let pushSoundAudio = null;
const activePushAudios = new Set();

export function stopAllPushSounds() {
  for (const audio of activePushAudios) {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {}
  }
  activePushAudios.clear();
}

if (typeof window !== "undefined") {
  window.__stopAllPushSounds = stopAllPushSounds;
}

let pushSoundUnlocked = false;
let pushSoundContext = null;
const PUSH_DEBUG_PREFIX = "[push-debug]";
const notificationDedupWindowMs = 8000;
const webRegistrationThrottleMs = 60000;
const pushDebugLog = (prefix, message, data = {}) => {
  console.log(`${prefix} ${message}`, data);
};
const pushDebugWarn = (prefix, message, data = {}) => {
  console.warn(`${prefix} ${message}`, data);
};

function shouldIgnoreFcmRegistrationError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return (
    name === "InvalidStateError" ||
    message.includes("IDBDatabase") ||
    message.includes("database connection is closing") ||
    message.includes("Failed to execute 'transaction'")
  );
}

function normalizeModuleFromPath(pathname = window.location.pathname) {
  if (pathname.includes("/restaurant") && !pathname.includes("/restaurants")) return "restaurant";
  if (pathname.includes("/delivery")) return "delivery";
  if (pathname.includes("/admin")) return "admin";
  return "user";
}

function hasModuleSession(moduleName = normalizeModuleFromPath()) {
  if (typeof window === "undefined") return false;
  if (!moduleName || moduleName === "admin") return false;
  return Boolean(localStorage.getItem(`${moduleName}_accessToken`));
}

function hasAnyFoodModuleSession() {
  if (typeof window === "undefined") return false;
  return ["user", "restaurant", "delivery", "admin"].some((moduleName) =>
    Boolean(localStorage.getItem(`${moduleName}_accessToken`)),
  );
}

async function disablePushWhenLoggedOut() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (hasAnyFoodModuleSession()) return;

  // IMPORTANT: do NOT unsubscribe the browser PushSubscription on logout.
  // Unsubscribing destroys the device endpoint; the next login often cannot
  // obtain a fresh FCM token (hasToken=false, empty fcmTokens in DB).
  // DB token detach on logout is enough to stop pushes for this account.
  pushDebugLog(PUSH_DEBUG_PREFIX, "Logged out — keeping browser push subscription intact for re-login");
}

function isModuleOnline(moduleName = normalizeModuleFromPath()) {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const isVisible = document.visibilityState === "visible";
  const isFocused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  const isWindowFocused = typeof window === "undefined" || typeof window.focus !== "function" ? true : isFocused;
  return isVisible && isWindowFocused;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getPushSoundSources(moduleName = normalizeModuleFromPath()) {
  // Delivery and restaurant should always use the alert tone for FCM pushes.
  if (moduleName === "delivery" || moduleName === "restaurant") {
    return [fallbackNotificationSound];
  }
  return [pushNotificationSoundPath, fallbackNotificationSound];
}

function isSupportedBrowser() {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function isFlutterWebView() {
  return (
    typeof window !== "undefined" &&
    Boolean(window.flutter_inappwebview) &&
    typeof window.flutter_inappwebview.callHandler === "function"
  );
}

function isSecureContextForPush() {
  return window.isSecureContext || window.location.hostname === "localhost";
}

function sanitize(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function getNotificationKey(payload = {}) {
  const normalizedTitle = normalizeNotificationText(payload?.data?.title || payload?.notification?.title || "");
  const normalizedBody = normalizeNotificationText(payload?.data?.body || payload?.notification?.body || "");
  return (
    payload?.data?.notificationId ||
    payload?.data?.messageId ||
    payload?.messageId ||
    [
      normalizedTitle,
      normalizedBody,
      payload?.data?.orderId || "",
      payload?.data?.targetUrl || payload?.data?.link || "",
    ].join("::")
  );
}

function normalizeNotificationText(value = "") {
  const raw = String(value || "");
  if (!raw) return "";

  const repairMojibake = (input) => {
    const text = String(input || "");
    if (!text) return "";
    if (!/[ðÃÂâ]/.test(text)) return text;
    try {
      const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (decoded && !/�/.test(decoded)) return decoded;
      return decoded || text;
    } catch {
      return text;
    }
  };

  const repaired = repairMojibake(raw);
  const withoutModulePrefix = repaired
    .replace(/^\s*(?:[\uD800-\uDBFF][\uDC00-\uDFFF]\s*)*\[(user|shop|restaurant|delivery|admin)\]\s*/i, "")
    .trim();

  const cleaned = withoutModulePrefix
    .replace(/�[A-Za-z0-9{}[\]\\/_.:-]*/g, " ")
    .replace(/[ÂÃâð][^\s]{0,3}/g, " ")
    .replace(/[^\x20-\x7E\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  // Ignore generic placeholder titles.
  if (/^(notification|new notification|on notification)$/i.test(cleaned)) {
    return "";
  }

  return cleaned;
}

function toReadableStatus(value = "") {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferNotificationBodyFromEvent(payload = {}) {
  const data = isRecord(payload?.data) ? payload.data : {};
  const eventType = String(
    data.eventType ||
      data.event ||
      data.type ||
      data.action ||
      data.category ||
      "",
  ).toLowerCase();
  const orderId = String(data.orderId || data.order_id || data.orderMongoId || "").trim();
  const status = toReadableStatus(data.orderStatus || data.status || data.deliveryStatus || "");
  const amount = String(data.amount || data.total || data.walletAmount || "").trim();

  if (eventType.includes("order")) {
    if (status && orderId) return `Order #${orderId} is now ${status}.`;
    if (status) return `Your order is now ${status}.`;
    if (orderId) return `Order #${orderId} has a new update.`;
    return "Your order has a new update.";
  }

  if (eventType.includes("delivery")) {
    if (status) return `Delivery status updated to ${status}.`;
    return "Delivery update available.";
  }

  if (
    eventType.includes("wallet") ||
    eventType.includes("payment") ||
    eventType.includes("refund")
  ) {
    if (amount) return `Wallet/payment update for ₹${amount}.`;
    return "Wallet/payment update available.";
  }

  if (eventType.includes("approve") || eventType.includes("reject")) {
    if (status) return `Approval status updated: ${status}.`;
    return "Approval status has been updated.";
  }

  if (status && orderId) return `Order #${orderId} is now ${status}.`;
  if (status) return `Status updated to ${status}.`;
  if (orderId) return `Order #${orderId} has a new update.`;
  return "";
}

function wasRecentlyHandled(notificationKey) {
  if (!notificationKey) return false;
  const now = Date.now();

  for (const [key, timestamp] of recentForegroundNotifications.entries()) {
    if (now - timestamp > notificationDedupWindowMs) {
      recentForegroundNotifications.delete(key);
    }
  }

  if (recentForegroundNotifications.has(notificationKey)) {
    pushDebugLog(PUSH_DEBUG_PREFIX, "Duplicate notification skipped", { notificationKey });
    return true;
  }

  recentForegroundNotifications.set(notificationKey, now);
  return false;
}

function ensurePushSoundAudio() {
  if (typeof window === "undefined") return null;
  if (!pushSoundAudio) {
    const [primarySource] = getPushSoundSources();
    const audioUrl = primarySource.startsWith("/")
      ? new URL(primarySource, window.location.origin).toString()
      : primarySource;
    pushDebugLog(PUSH_DEBUG_PREFIX, "Creating primary push audio", { audioUrl });
    pushSoundAudio = new Audio(audioUrl);
    pushSoundAudio.preload = "auto";
    pushSoundAudio.volume = 1;
    pushSoundAudio.load();
  }
  return pushSoundAudio;
}

function createPushPlaybackAudio() {
  const moduleName = normalizeModuleFromPath();
  const audioSources = getPushSoundSources(moduleName).map((source) =>
    typeof window === "undefined" || !source.startsWith("/")
      ? source
      : new URL(source, window.location.origin).toString(),
  );
  pushDebugLog(PUSH_DEBUG_PREFIX, "Preparing push playback sources", { audioSources });
  return audioSources.map((source) => {
    const playbackAudio = new Audio(source);
    playbackAudio.preload = "auto";
    playbackAudio.volume = 1;
    playbackAudio.load();
    return playbackAudio;
  });
}

function getAudioContext() {
  if (typeof window === "undefined") return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!pushSoundContext) {
    pushSoundContext = new AudioContextClass();
  }

  return pushSoundContext;
}

async function playSynthNotificationBeep() {
  const ctx = getAudioContext();
  if (!ctx) return false;
  pushDebugLog(PUSH_DEBUG_PREFIX, "Playing synth notification beep");

  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  const now = ctx.currentTime;
  const pulses = [
    { start: 0, duration: 0.11, frequency: 880 },
    { start: 0.16, duration: 0.11, frequency: 988 },
    { start: 0.34, duration: 0.18, frequency: 1046 },
  ];

  pulses.forEach(({ start, duration, frequency }) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now + start);
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.18, now + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(now + start);
    oscillator.stop(now + start + duration);
  });

  return true;
}

export function isPushSoundEnabled() {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(pushSoundEnabledStorageKey) === "true";
}

async function triggerWebViewNativeNotification(payload = {}) {
  if (typeof window === "undefined") return false;

  const bridgePayload = {
    title: payload?.notification?.title || payload?.data?.title || "New notification",
    body: payload?.notification?.body || payload?.data?.body || "",
    notificationId: payload?.data?.notificationId || payload?.messageId || "",
    targetUrl: payload?.data?.targetUrl || payload?.data?.link || "",
    imageUrl: payload?.notification?.image || payload?.data?.image || payload?.data?.imageUrl || "",
    disableActions: true,
  };

  try {
    if (
      window.flutter_inappwebview &&
      typeof window.flutter_inappwebview.callHandler === "function"
    ) {
      const handlerNames = [
        "playNotificationSound",
        "triggerNotificationFeedback",
      ];

      for (const handlerName of handlerNames) {
        try {
          pushDebugLog(PUSH_DEBUG_PREFIX, "Trying native notification handler", { handlerName, bridgePayload });
          await window.flutter_inappwebview.callHandler(handlerName, bridgePayload);
          pushDebugLog(PUSH_DEBUG_PREFIX, "Native notification handler succeeded", { handlerName });
          return true;
        } catch {
          // Try the next available handler name.
        }
      }
    }
  } catch {
    // Ignore bridge failures.
  }

  return false;
}

async function playPushSound(payload = {}) {
  try {
    const moduleName = normalizeModuleFromPath();
    const eventType = String(payload?.data?.type || "").toLowerCase();

    // In restaurant and delivery portals, order alerts and ringtones are owned exclusively by their respective session handlers.
    // Skip FCM standalone audio in these apps to prevent un-stoppable overlapping audio playing till end.
    if (moduleName === "restaurant" || moduleName === "delivery") {
      pushDebugLog(PUSH_DEBUG_PREFIX, "Skipping FCM push sound in portal (alert session owns audio)");
      return;
    }

    pushDebugLog(PUSH_DEBUG_PREFIX, "playPushSound called", {
      notificationKey: getNotificationKey(payload),
      pushSoundUnlocked,
      notificationPermission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",
      payload,
    });
    const usedNativeBridge = await triggerWebViewNativeNotification(payload);

    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      pushDebugLog(PUSH_DEBUG_PREFIX, "Triggering vibration");
      navigator.vibrate([200, 100, 200, 100, 300]);
    }

    if (usedNativeBridge) {
      pushDebugLog(PUSH_DEBUG_PREFIX, "Push sound handled by native bridge");
      return;
    }

    if (!pushSoundUnlocked) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "Push sound blocked because sound is not enabled/unlocked");
      return;
    }

    const players = createPushPlaybackAudio();
    for (const audio of players) {
      try {
        audio.currentTime = 0;
        activePushAudios.add(audio);
        audio.addEventListener("ended", () => activePushAudios.delete(audio), { once: true });
        audio.addEventListener("pause", () => activePushAudios.delete(audio), { once: true });
        await audio.play();
        pushDebugLog(PUSH_DEBUG_PREFIX, "Audio playback succeeded", { source: audio.src });
        return;
      } catch (error) {
        activePushAudios.delete(audio);
        pushDebugWarn(PUSH_DEBUG_PREFIX, "Audio playback failed", {
          source: audio.src,
          error: error?.message || error,
        });
        // Try next fallback sound source.
      }
    }

    await playSynthNotificationBeep();
  } catch (error) {
    pushDebugWarn(PUSH_DEBUG_PREFIX, "playPushSound failed", { error: error?.message || error });
  }
}

function setupPushSoundUnlock() {
  if (typeof window === "undefined" || pushSoundUnlocked) return;

  const unlock = async () => {
    let audio = null;
    try {
      audio = ensurePushSoundAudio();
      if (!audio) return;
      pushDebugLog(PUSH_DEBUG_PREFIX, "Attempting passive push sound unlock");
      audio.muted = true;
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      pushSoundUnlocked = true;
      localStorage.setItem(pushSoundEnabledStorageKey, "true");
      pushDebugLog(PUSH_DEBUG_PREFIX, "Passive push sound unlock succeeded");
      window.dispatchEvent(new CustomEvent("push-sound-enabled"));
    } catch (error) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "Passive push sound unlock failed", {
        error: error?.message || error,
      });
    } finally {
      if (audio) {
        audio.muted = false;
      }
    }

    if (pushSoundUnlocked) {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    }
  };

  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
  window.addEventListener("touchstart", unlock, { passive: true });
}

export async function enablePushNotificationSound() {
  if (typeof window === "undefined") return false;

  let audio = null;
  try {
    audio = ensurePushSoundAudio();
    if (!audio) return false;
    pushDebugLog(PUSH_DEBUG_PREFIX, "Manual push sound enable started");
    audio.muted = true;
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    pushSoundUnlocked = true;
    localStorage.setItem(pushSoundEnabledStorageKey, "true");
    window.dispatchEvent(new CustomEvent("push-sound-enabled"));

    const players = createPushPlaybackAudio();
    for (const previewAudio of players) {
      try {
        previewAudio.currentTime = 0;
        await previewAudio.play();
        pushDebugLog(PUSH_DEBUG_PREFIX, "Manual sound preview succeeded", { source: previewAudio.src });
        return true;
      } catch (error) {
        pushDebugWarn(PUSH_DEBUG_PREFIX, "Manual sound preview failed", {
          source: previewAudio.src,
          error: error?.message || error,
        });
        // Try next preview source.
      }
    }

    await playSynthNotificationBeep();
    return true;
  } catch (error) {
    pushDebugWarn(PUSH_DEBUG_PREFIX, "Manual push sound enable failed, trying synth beep", {
      error: error?.message || error,
    });
    try {
      await playSynthNotificationBeep();
      pushSoundUnlocked = true;
      localStorage.setItem(pushSoundEnabledStorageKey, "true");
      window.dispatchEvent(new CustomEvent("push-sound-enabled"));
      }
    catch (beepError) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "Synth beep fallback failed", {
        error: beepError?.message || beepError,
      });
      return false;
    }
    return true;
  } finally {
    if (audio) {
      audio.muted = false;
    }
  }
}

async function getFirebasePublicEnv() {
  if (publicEnvPromise) return publicEnvPromise;

  publicEnvPromise = (async () => {
    try {
      return {
        apiKey: sanitize(import.meta.env.VITE_FIREBASE_API_KEY) || DEFAULT_FIREBASE_CONFIG.apiKey,
        authDomain: sanitize(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN) || DEFAULT_FIREBASE_CONFIG.authDomain,
        projectId: sanitize(import.meta.env.VITE_FIREBASE_PROJECT_ID) || DEFAULT_FIREBASE_CONFIG.projectId,
        appId: sanitize(import.meta.env.VITE_FIREBASE_APP_ID) || DEFAULT_FIREBASE_CONFIG.appId,
        messagingSenderId:
          sanitize(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID) || DEFAULT_FIREBASE_CONFIG.messagingSenderId,
        storageBucket: sanitize(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
        measurementId: sanitize(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID),
        vapidKey: sanitize(import.meta.env.VITE_FIREBASE_VAPID_KEY),
      };
    } catch {
      return {
        ...DEFAULT_FIREBASE_CONFIG,
        storageBucket: sanitize(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
        measurementId: sanitize(import.meta.env.VITE_FIREBASE_MEASUREMENT_ID),
        vapidKey: sanitize(import.meta.env.VITE_FIREBASE_VAPID_KEY),
      };
    } finally {
      publicEnvPromise = null;
    }
  })();

  return publicEnvPromise;
}

function passFirebaseConfigToServiceWorker(registration, config) {
  if (!registration || !config) return;
  const payload = {
    type: "INIT_FIREBASE_CONFIG",
    config: {
      apiKey: sanitize(config.apiKey),
      authDomain: sanitize(config.authDomain),
      projectId: sanitize(config.projectId),
      appId: sanitize(config.appId),
      messagingSenderId: sanitize(config.messagingSenderId),
      storageBucket: sanitize(config.storageBucket),
      measurementId: sanitize(config.measurementId),
    },
  };

  const postConfig = (worker) => {
    if (!worker || typeof worker.postMessage !== "function") return false;
    worker.postMessage(payload);
    return true;
  };

  if (!postConfig(registration.active)) {
    postConfig(registration.waiting);
    postConfig(registration.installing);
  }
}

function getMessagingFirebaseApp(config) {
  const appConfig = {
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    appId: config.appId,
    messagingSenderId: config.messagingSenderId,
    ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}),
    ...(config.measurementId ? { measurementId: config.measurementId } : {}),
  };

  if (!appConfig.apiKey || !appConfig.projectId || !appConfig.appId || !appConfig.messagingSenderId) {
    return null;
  }

  const existing = getApps().find((a) => a.name === MESSAGING_APP_NAME);
  if (existing) return existing;

  try {
    return getApp(MESSAGING_APP_NAME);
  } catch {
    return initializeApp(appConfig, MESSAGING_APP_NAME);
  }
}

function getSavedToken(moduleName) {
  return localStorage.getItem(`${tokenCachePrefix}${moduleName}`) || "";
}

function setSavedToken(moduleName, token) {
  localStorage.setItem(`${tokenCachePrefix}${moduleName}`, token);
}

async function saveTokenByModule(moduleName, token, platform = "web") {
  pushDebugLog(PUSH_DEBUG_PREFIX, "saveTokenByModule starting", { moduleName, platform, tokenPreview: `${token?.slice(0, 10)}...` });
  if (moduleName === "restaurant") {
    await restaurantAPI.saveFcmToken(token, platform);
    return;
  }
  if (moduleName === "delivery") {
    await deliveryAPI.saveFcmToken(token, platform);
    return;
  }
  if (moduleName === "user") {
    await userAPI.saveFcmToken(token, { platform });
  }
}

async function registerNativeWebViewFcmToken(moduleName) {
  if (!isFlutterWebView()) return;

  const handlerNames = ["getFcmToken", "getFCMToken", "getPushToken", "getFirebaseToken"];
  for (const handlerName of handlerNames) {
    try {
      const token = await window.flutter_inappwebview.callHandler(handlerName, { module: moduleName });
      const normalizedToken = String(token || "").trim();
      if (normalizedToken.length < 20) continue;

      // Always sync to backend — local cache can be stale after manual DB cleanup.
      try {
        await saveTokenByModule(moduleName, normalizedToken, "mobile");
        setSavedToken(moduleName, normalizedToken);
      } catch (e) {
        pushDebugWarn(PUSH_DEBUG_PREFIX, "Failed to sync native WebView FCM token", {
          moduleName,
          error: e?.message || e,
        });
      }

      pushDebugLog(PUSH_DEBUG_PREFIX, "Registered native WebView FCM token", {
        moduleName,
        handlerName,
        tokenPreview: `${normalizedToken.slice(0, 12)}...`,
      });
      return;
    } catch {
      // Try next handler.
    }
  }
}

/**
 * Resolve this device's FCM token for save/logout.
 * Prefers native Flutter token, then localStorage cache, then live web getToken().
 * @param {string} [moduleName="user"]
 * @param {{ allowPrompt?: boolean }} [options]
 *   allowPrompt: when true (login), request notification permission and register the SW if needed.
 */
export async function resolveDeviceFcmToken(moduleName = "user", options = {}) {
  const normalizedModule = String(moduleName || "user").trim().toLowerCase() || "user";
  const allowPrompt = Boolean(options?.allowPrompt);

  if (typeof window !== "undefined" && isFlutterWebView()) {
    const handlerNames = ["getFcmToken", "getFCMToken", "getPushToken", "getFirebaseToken"];
    for (const handlerName of handlerNames) {
      try {
        const token = await window.flutter_inappwebview.callHandler(handlerName, {
          module: normalizedModule,
        });
        const normalizedToken = String(token || "").trim();
        if (normalizedToken.length > 20) {
          return { token: normalizedToken, platform: "mobile" };
        }
      } catch {
        // Try next handler.
      }
    }
  }

  // On login we need a live token even if cache was cleared by logout.
  // On logout, prefer cache first for a fast detach.
  if (!allowPrompt) {
    const cached = getSavedToken(normalizedModule);
    if (cached && cached.length > 20) {
      return { token: cached, platform: "web" };
    }
  }

  // Best-effort live web token.
  try {
    if (!isSupportedBrowser() || !isSecureContextForPush()) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "FCM resolve skipped: browser/secure-context unsupported", {
        moduleName: normalizedModule,
        supportedBrowser: isSupportedBrowser(),
        secureContext: isSecureContextForPush(),
      });
      return { token: getSavedToken(normalizedModule) || null, platform: "web" };
    }

    let permission =
      typeof Notification !== "undefined" ? Notification.permission : "denied";
    if (allowPrompt && permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "FCM resolve skipped: notification permission not granted", {
        moduleName: normalizedModule,
        permission,
      });
      const cached = getSavedToken(normalizedModule);
      return {
        token: cached && cached.length > 20 ? cached : null,
        platform: "web",
      };
    }

    const firebasePublicEnv = await getFirebasePublicEnv();
    if (!firebasePublicEnv?.vapidKey) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "FCM resolve skipped: missing VAPID key", {
        moduleName: normalizedModule,
      });
      return { token: null, platform: "web" };
    }

    const app = getMessagingFirebaseApp(firebasePublicEnv);
    if (!app) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "FCM resolve skipped: incomplete Firebase config", {
        moduleName: normalizedModule,
      });
      return { token: null, platform: "web" };
    }

    const { getMessaging, getToken, isSupported } = await import("firebase/messaging");
    const supported = await isSupported().catch(() => false);
    if (!supported) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "FCM resolve skipped: firebase messaging unsupported", {
        moduleName: normalizedModule,
      });
      return { token: null, platform: "web" };
    }

    let registration = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
    if (!registration) {
      registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    }
    // Wait until the SW is active — getToken often fails on a non-ready registration.
    if (navigator.serviceWorker.ready) {
      registration = (await navigator.serviceWorker.ready) || registration;
    }
    passFirebaseConfigToServiceWorker(registration, firebasePublicEnv);

    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: firebasePublicEnv.vapidKey,
      serviceWorkerRegistration: registration,
    });
    const normalizedToken = String(token || "").trim();
    if (normalizedToken.length > 20) {
      setSavedToken(normalizedModule, normalizedToken);
      pushDebugLog(PUSH_DEBUG_PREFIX, "Resolved live web FCM token", {
        moduleName: normalizedModule,
        tokenPreview: `${normalizedToken.slice(0, 12)}...`,
      });
      return { token: normalizedToken, platform: "web" };
    }
    pushDebugWarn(PUSH_DEBUG_PREFIX, "FCM getToken returned empty token", {
      moduleName: normalizedModule,
    });
  } catch (error) {
    pushDebugWarn(PUSH_DEBUG_PREFIX, "Failed to resolve live web FCM token", {
      moduleName: normalizedModule,
      allowPrompt,
      error: error?.message || error,
    });
  }

  const cachedFallback = getSavedToken(normalizedModule);
  return {
    token: cachedFallback && cachedFallback.length > 20 ? cachedFallback : null,
    platform: "web",
  };
}

function showForegroundNotification(payload = {}) {
  if (!isRecord(payload)) {
    pushDebugWarn(PUSH_DEBUG_PREFIX, "Ignoring malformed foreground notification payload", { payload });
    return;
  }
  const moduleName = normalizeModuleFromPath();
  if (!hasModuleSession(moduleName)) {
    pushDebugLog(PUSH_DEBUG_PREFIX, "Skipping foreground notification: module is logged out", { moduleName });
    return;
  }
  if (!isModuleOnline(moduleName)) {
    pushDebugLog(PUSH_DEBUG_PREFIX, "Skipping foreground notification: module is not online", { moduleName });
    return;
  }
  const notificationKey = getNotificationKey(payload);
  pushDebugLog(PUSH_DEBUG_PREFIX, "showForegroundNotification received", { notificationKey, payload });
  if (wasRecentlyHandled(notificationKey)) {
    return;
  }

  // Extract content from data first (backend often sends here), then notification object
  const titleCandidate = normalizeNotificationText(
    payload?.data?.title || payload?.notification?.title || "",
  );
  const bodyCandidate = normalizeNotificationText(
    payload?.data?.body || payload?.notification?.body || "",
  );
  const inferredBody = normalizeNotificationText(inferNotificationBodyFromEvent(payload));
  const title = titleCandidate || bodyCandidate || "New update";
  const body = titleCandidate ? (bodyCandidate || inferredBody) : "";

  // Play sound only when app is in foreground
  playPushSound(payload);

  // App is in foreground - just show in-app toast, NOT system notification
  // System notification will be handled by service worker only when app is closed/background
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    if (!title && !body) {
      pushDebugLog(PUSH_DEBUG_PREFIX, "Skipping blank foreground notification after sanitize");
      return;
    }
    if (body) {
      toast.success(`${title}: ${body}`);
    } else {
      toast.success(title);
    }
    pushDebugLog(PUSH_DEBUG_PREFIX, "Foreground notification shown as toast", { title, body });
  }
}

function attachServiceWorkerMessageListener() {
  if (serviceWorkerMessageListenerAttached || typeof window === "undefined") {
    return;
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = isRecord(event?.data) ? event.data : null;
      if (!data || data.type !== "push-notification-received") return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        pushDebugLog(PUSH_DEBUG_PREFIX, "Skipping page notification render for SW relay because tab is hidden");
        return;
      }
      if (!isRecord(data.payload)) {
        pushDebugWarn(PUSH_DEBUG_PREFIX, "Ignoring malformed SW push relay payload", { payload: data.payload });
        return;
      }
      pushDebugLog(PUSH_DEBUG_PREFIX, "Received service worker message in page", { payload: data.payload });
      scheduleForegroundNotification(data.payload);
    });
  }

  window.addEventListener("native-push-notification", (event) => {
    const payload = isRecord(event?.detail) ? event.detail : null;
    if (!payload) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "Ignoring malformed native push event", { payload: event?.detail });
      return;
    }
    pushDebugLog(PUSH_DEBUG_PREFIX, "Received native push event", { payload });
    scheduleForegroundNotification(payload);
  });

  window.addEventListener("message", (event) => {
    const data = isRecord(event?.data) ? event.data : null;
    if (!data) return;
    if (data.type !== "native-push-notification") return;
    if (!isRecord(data.payload)) {
      pushDebugWarn(PUSH_DEBUG_PREFIX, "Ignoring malformed native postMessage payload", { payload: data.payload });
      return;
    }
    pushDebugLog(PUSH_DEBUG_PREFIX, "Received native postMessage push event", { payload: data.payload });
    scheduleForegroundNotification(data.payload);
  });

  serviceWorkerMessageListenerAttached = true;
}

function scheduleForegroundNotification(payload) {
  // Keep message handlers fast to avoid Chrome [Violation] warnings.
  // Defer heavier work (toast, audio) to idle time / next tick.
  const run = () => showForegroundNotification(payload);
  try {
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 1000 });
      return;
    }
  } catch {
    // ignore
  }
  setTimeout(run, 0);
}

export function initPushNotificationClient() {
  if (typeof window === "undefined") return;
  const moduleName = normalizeModuleFromPath(window.location.pathname);
  pushDebugLog(PUSH_DEBUG_PREFIX, "Initializing push notification client", {
    path: window.location.pathname,
    moduleName,
    soundEnabled: isPushSoundEnabled(),
  });

  if (moduleName === "admin") {
    return;
  }

  if (!hasModuleSession(moduleName)) {
    pushDebugLog(PUSH_DEBUG_PREFIX, "Skipping push client init: module is logged out", { moduleName });
    void disablePushWhenLoggedOut();
    return;
  }

  if (isPushSoundEnabled()) {
    pushSoundUnlocked = true;
  }

  setupPushSoundUnlock();
  attachServiceWorkerMessageListener();
}

async function attachForegroundListener(firebaseAppInstance) {
  if (foregroundListenerAttached) return;

  const { getMessaging, onMessage, isSupported } = await import("firebase/messaging");
  const supported = await isSupported().catch(() => false);
  if (!supported) return;

  const messaging = getMessaging(firebaseAppInstance);
  setupPushSoundUnlock();
  attachServiceWorkerMessageListener();

  onMessage(messaging, (payload) => {
    pushDebugLog(PUSH_DEBUG_PREFIX, "Received Firebase foreground message", { payload });
    scheduleForegroundNotification(payload);
  });

  foregroundListenerAttached = true;
}

export async function registerWebPushForCurrentModule(pathname = window.location.pathname, options = {}) {
  const moduleName = normalizeModuleFromPath(pathname);
  if (moduleName === "admin") return;

  const accessToken = localStorage.getItem(`${moduleName}_accessToken`);
  if (!accessToken) {
    // Only run logged-out cleanup when we know there is no session.
    // Never call this before the accessToken check — it used to unsubscribe push and break re-login.
    initPushNotificationClient();
    return;
  }

  initPushNotificationClient();

  const force = Boolean(options?.force);
  const supportsBrowserPush = isSupportedBrowser() && isSecureContextForPush();

  if (supportsBrowserPush) {
    const now = Date.now();
    const lastTs = Number(lastWebRegistrationAtByModule.get(moduleName) || 0);
    if (!force && now - lastTs < webRegistrationThrottleMs) {
      pushDebugLog(PUSH_DEBUG_PREFIX, "Skipping web push registration (throttled)", {
        moduleName,
        sinceMs: now - lastTs,
      });
      return;
    }

    if (registrationInFlight && !force) return registrationInFlight;

    const runRegistration = async () => {
      const firebasePublicEnv = await getFirebasePublicEnv();
      if (!firebasePublicEnv?.vapidKey) {
        console.warn("FCM web registration skipped: FIREBASE_VAPID_KEY is missing in env setup.");
        return;
      }

      const app = getMessagingFirebaseApp(firebasePublicEnv);
      if (!app) {
        console.warn("FCM web registration skipped: Firebase public web config is incomplete.");
        return;
      }

      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission()
          : Notification.permission;

      if (permission !== "granted") {
        console.warn("FCM web registration skipped: Notification permission not granted.", permission);
        return;
      }

      const { getMessaging, getToken, isSupported } = await import("firebase/messaging");
      const supported = await isSupported().catch(() => false);
      if (!supported) {
        console.warn("FCM web registration skipped: firebase messaging unsupported in this browser.");
        return;
      }

      let registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
      if (navigator.serviceWorker.ready) {
        registration = (await navigator.serviceWorker.ready) || registration;
      }
      pushDebugLog(PUSH_DEBUG_PREFIX, "Service worker registered for push", {
        scope: registration.scope,
        moduleName,
      });
      passFirebaseConfigToServiceWorker(registration, firebasePublicEnv);
      const messaging = getMessaging(app);

      const token = await getToken(messaging, {
        vapidKey: firebasePublicEnv.vapidKey,
        serviceWorkerRegistration: registration,
      });

      if (!token) {
        console.warn("FCM web registration skipped: getToken returned empty.");
        return;
      }
      pushDebugLog(PUSH_DEBUG_PREFIX, "FCM token resolved", {
        moduleName,
        tokenPreview: `${token.slice(0, 12)}...`,
      });

      // Always sync to backend so tokens reappear after manual DB cleanup / logout.
      try {
        pushDebugLog(PUSH_DEBUG_PREFIX, "Synchronizing FCM token with backend database", { moduleName, tokenPreview: `${token?.slice(0, 10)}...` });
        await saveTokenByModule(moduleName, token);
        setSavedToken(moduleName, token);
        lastWebRegistrationAtByModule.set(moduleName, Date.now());
        pushDebugLog(PUSH_DEBUG_PREFIX, "FCM token synchronized with backend successfully");
      } catch (e) {
        pushDebugWarn(PUSH_DEBUG_PREFIX, "Failed to synchronize FCM token to backend", { error: e?.message || e, stack: e?.stack });
      }

      await attachForegroundListener(app);
    };

    registrationInFlight = runRegistration()
      .catch((e) => {
        if (shouldIgnoreFcmRegistrationError(e)) {
          pushDebugWarn(PUSH_DEBUG_PREFIX, "Ignoring transient FCM web registration error", {
            name: e?.name,
            message: e?.message,
          });
          return;
        }
        console.error("FCM web registration failed:", e);
      })
      .finally(() => {
        registrationInFlight = null;
      });

    return registrationInFlight;
  }

  // Flutter WebView fallback: register native token when browser web push isn't available.
  // This keeps restaurant/delivery FCM alerts working even when Web Push APIs are limited.
  await registerNativeWebViewFcmToken(moduleName);
  return null;
}
