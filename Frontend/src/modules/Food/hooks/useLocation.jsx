import { useState, useEffect, useRef } from "react"
import { locationAPI, userAPI } from "@food/api"
import {
  getDeliveryAddressMode,
  notifyUserLocationChanged,
  persistUserLocation,
  readStoredUserLocation,
  setDeliveryAddressMode,
} from "@food/utils/deliveryLocationUtils"
import { reverseGeocodeAccurate } from "@food/utils/reverseGeocodeAccurate"

const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}
const DEFAULT_LOCATION = {
  latitude: null,
  longitude: null,
  city: "Select location",
  state: "",
  area: "",
  address: "Select location",
  formattedAddress: "Select location"
}


// BigDataCloud reverse-geocode is expensive/noisy if many components mount `useLocation()`.
// This module-level guard dedupes concurrent calls + rate-limits starts across the whole app.
const GLOBAL_GEOCODE_MIN_INTERVAL_MS = 60_000
const GLOBAL_GEOCODE_REUSE_DISTANCE_METERS = 75
const geoDistanceMeters = (lat1, lng1, lat2, lng2) => {
  if (
    typeof lat1 !== "number" ||
    typeof lng1 !== "number" ||
    typeof lat2 !== "number" ||
    typeof lng2 !== "number"
  ) {
    return Number.POSITIVE_INFINITY
  }
  const latDiff = lat2 - lat1
  const lngDiff = lng2 - lng1
  return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff) * 111320
}

let globalReverseGeocodeInFlight = null
let globalReverseGeocodeLastStartAt = 0
let globalReverseGeocodeLastCoords = { latitude: null, longitude: null }
let globalReverseGeocodeLastSuccess = null

// Default behavior: resolve from cache/DB quickly, and when permission is already granted
// keep a live geolocation watch so zone/location updates react without page refresh.
const AUTO_START_LIVE_WATCH = true
const HIGH_ACCURACY_GEO_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 0,
}
const LIVE_WATCH_GEO_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 0,
}
const GOOD_ACCURACY_M = 50
const ACCURACY_WATCH_MS = 15000
const STALE_GPS_MS = 30000
let globalAccurateGpsInFlight = null
let globalAccurateGpsLastAt = 0
const GLOBAL_ACCURATE_GPS_MIN_INTERVAL_MS = 12_000

const isMeaningfulAddressValue = (value) => {
  const normalized = String(value || "").trim().toLowerCase()
  return Boolean(
    normalized &&
      normalized !== "select location" &&
      normalized !== "current location" &&
      !/^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(normalized)
  )
}

const buildBigDataCloudAddress = (data, latitude, longitude) => {
  const administrative = Array.isArray(data?.localityInfo?.administrative)
    ? data.localityInfo.administrative
    : []
  const locality = String(data?.locality || data?.city || "").trim()
  const city = String(data?.city || data?.locality || "").trim()
  const state = String(data?.principalSubdivision || "").trim()
  const postcode = String(data?.postcode || "").trim()
  const areaCandidates = [
    data?.locality,
    data?.city,
    administrative.find((item) => Number(item?.adminLevel) >= 8)?.name,
    administrative.find((item) => Number(item?.adminLevel) === 6)?.name,
    administrative.find((item) => Number(item?.adminLevel) === 5)?.name,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)

  const uniqueParts = []
  const pushUnique = (value) => {
    const next = String(value || "").trim()
    if (!next) return
    if (uniqueParts.some((part) => part.toLowerCase() === next.toLowerCase())) return
    uniqueParts.push(next)
  }

  const explicitFormattedAddress = data?.formattedAddress || data?.lookupSourceAddress || data?.displayName
  if (isMeaningfulAddressValue(explicitFormattedAddress)) {
    return {
      area: areaCandidates[0] || city || "",
      city: city || "Unknown City",
      state,
      country: String(data?.countryName || "").trim(),
      postalCode: postcode,
      address: String(explicitFormattedAddress).trim(),
      formattedAddress: String(explicitFormattedAddress).trim(),
    }
  }

  pushUnique(areaCandidates[0])
  pushUnique(areaCandidates[1])
  pushUnique(areaCandidates[2])
  pushUnique(city)
  pushUnique(state)
  pushUnique(postcode)

  if (uniqueParts.length === 0) {
    const fallbackText = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
    return {
      area: "",
      city: city || "Unknown City",
      state,
      country: String(data?.countryName || "").trim(),
      postalCode: postcode,
      address: fallbackText,
      formattedAddress: fallbackText,
    }
  }

  return {
    area: areaCandidates[0] || locality || city || "",
    city: city || "Unknown City",
    state,
    country: String(data?.countryName || "").trim(),
    postalCode: postcode,
    address: uniqueParts.join(", "),
    formattedAddress: uniqueParts.join(", "),
  }
}

const buildNominatimAddress = (data) => {
  if (!data || !data.address) return null
  const addr = data.address
  const displayName = data.display_name || ""
  const streetParts = [addr.road, addr.house_number, addr.building].filter(Boolean)
  const street = streetParts.join(", ")
  const area = addr.suburb || addr.neighbourhood || addr.city_district || addr.residential || ""
  const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || ""
  const state = addr.state || ""
  const postcode = addr.postcode || ""
  if (!isMeaningfulAddressValue(displayName) && !street && !area && !city) return null
  return {
    area: area || city || "",
    city: city || "Unknown City",
    state,
    country: addr.country || "",
    postalCode: postcode,
    street: street || area || "",
    address: displayName || [street, area, city, state, postcode].filter(Boolean).join(", "),
    formattedAddress: displayName || [street, area, city, state, postcode].filter(Boolean).join(", "),
  }
}

const buildGoogleAddress = (result) => {
  if (!result) return null
  const addressComponents = result.address_components || []
  const displayName = result.formatted_address || ""
  let streetNumber = ""
  let route = ""
  let premise = ""
  let neighborhood = ""
  let sublocality1 = ""
  let sublocality2 = ""
  let locality = ""
  let administrativeArea1 = ""
  let country = ""
  let postalCode = ""

  addressComponents.forEach((comp) => {
    const types = comp.types || []
    if (types.includes("street_number")) streetNumber = comp.long_name
    if (types.includes("route")) route = comp.long_name
    if (types.includes("premise")) premise = comp.long_name
    if (types.includes("neighborhood")) neighborhood = comp.long_name
    if (types.includes("sublocality_level_1")) sublocality1 = comp.long_name
    if (types.includes("sublocality_level_2")) sublocality2 = comp.long_name
    if (types.includes("locality")) locality = comp.long_name
    if (types.includes("administrative_area_level_1")) administrativeArea1 = comp.long_name
    if (types.includes("country")) country = comp.long_name
    if (types.includes("postal_code")) postalCode = comp.long_name
  })

  const city = locality || "Unknown City"
  const state = administrativeArea1 || ""
  const area = sublocality1 || sublocality2 || neighborhood || ""
  const street = [streetNumber, route, premise].filter(Boolean).join(", ")
  if (!isMeaningfulAddressValue(displayName) && !street && !area) return null

  return {
    area: area || city,
    city,
    state,
    country,
    postalCode,
    street: street || area || "",
    streetNumber,
    address: displayName,
    formattedAddress: displayName,
  }
}

const clearReverseGeocodeCache = () => {
  globalReverseGeocodeLastSuccess = null
  globalReverseGeocodeLastStartAt = 0
  globalReverseGeocodeLastCoords = { latitude: null, longitude: null }
  globalReverseGeocodeInFlight = null
}

const getBestAccuratePosition = (options = {}) => {
  const geoOptions = {
    ...HIGH_ACCURACY_GEO_OPTIONS,
    ...options,
    enableHighAccuracy: true,
    maximumAge: 0,
  }

  return new Promise((resolve, reject) => {
    let best = null
    let settled = false
    let watchId = null
    let timer = null

    const finish = (pos, err) => {
      if (settled) return
      settled = true
      if (watchId != null) {
        navigator.geolocation.clearWatch(watchId)
        watchId = null
      }
      if (timer) clearTimeout(timer)
      if (pos) resolve(pos)
      else reject(err || { code: 3, message: "Location request timed out" })
    }

    const consider = (pos) => {
      if (settled || !pos?.coords) return
      const age = Date.now() - (pos.timestamp || Date.now())
      if (age > STALE_GPS_MS) return
      if (!best || (pos.coords.accuracy || Infinity) < (best.coords.accuracy || Infinity)) {
        best = pos
      }
      if ((pos.coords.accuracy || Infinity) <= GOOD_ACCURACY_M) {
        finish(pos)
      }
    }

    navigator.geolocation.getCurrentPosition(consider, (err) => {
      if (err?.code === 1) finish(null, err)
    }, geoOptions)

    watchId = navigator.geolocation.watchPosition(consider, (err) => {
      if (err?.code === 1) finish(null, err)
      else if (best) finish(best)
    }, geoOptions)

    timer = setTimeout(() => {
      if (best) finish(best)
      else finish(null, { code: 3, message: "Location request timed out" })
    }, options.watchMs ?? ACCURACY_WATCH_MS)
  })
}

const reverseGeocodeDirect = async (latitude, longitude, forceFresh = false) => {
  const now = Date.now()
  const movedMeters = geoDistanceMeters(
    globalReverseGeocodeLastCoords.latitude,
    globalReverseGeocodeLastCoords.longitude,
    latitude,
    longitude
  )
  const timeSinceLastStart = now - globalReverseGeocodeLastStartAt

  if (
    !forceFresh &&
    globalReverseGeocodeLastSuccess &&
    movedMeters < GLOBAL_GEOCODE_REUSE_DISTANCE_METERS &&
    timeSinceLastStart < GLOBAL_GEOCODE_MIN_INTERVAL_MS
  ) {
    return globalReverseGeocodeLastSuccess
  }

  if (!forceFresh && globalReverseGeocodeInFlight) {
    const inFlightMoved = geoDistanceMeters(
      globalReverseGeocodeLastCoords.latitude,
      globalReverseGeocodeLastCoords.longitude,
      latitude,
      longitude
    )
    if (inFlightMoved < GLOBAL_GEOCODE_REUSE_DISTANCE_METERS) {
      try {
        return await globalReverseGeocodeInFlight
      } catch {
        // fall through to a fresh attempt
      }
    }
  }

  globalReverseGeocodeLastStartAt = now
  globalReverseGeocodeLastCoords = { latitude, longitude }

  const run = (async () => {
    try {
      try {
        const controller = new AbortController()
        const abortTimeout = setTimeout(() => controller.abort(), 4000)
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`,
          {
            signal: controller.signal,
            headers: {
              "Accept-Language": "en",
              "User-Agent": "Foodiss-Food-App",
            },
          }
        )
        clearTimeout(abortTimeout)
        if (res.ok) {
          const parsed = buildNominatimAddress(await res.json())
          if (parsed && isMeaningfulAddressValue(parsed.formattedAddress)) {
            globalReverseGeocodeLastSuccess = parsed
            return parsed
          }
        }
      } catch {
        // fall through to BigDataCloud
      }

      const controller = new AbortController()
      const abortTimeout = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(
        `https://api-bdc.io/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
        { signal: controller.signal }
      )
      clearTimeout(abortTimeout)
      const value = buildBigDataCloudAddress(await res.json(), latitude, longitude)
      globalReverseGeocodeLastSuccess = value
      return value
    } catch {
      const fallback = {
        city: "Current Location",
        address: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
        formattedAddress: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      }
      return fallback
    } finally {
      globalReverseGeocodeInFlight = null
    }
  })()

  globalReverseGeocodeInFlight = run
  return run
}

export function useLocation() {
  const [location, setLocation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [permissionGranted, setPermissionGranted] = useState(false)

  const watchIdRef = useRef(null)
  const updateTimerRef = useRef(null)
  const prevLocationCoordsRef = useRef({ latitude: null, longitude: null })
  const lastGeocodeAtRef = useRef(0)
  const lastGeocodedCoordsRef = useRef({ latitude: null, longitude: null })
  const lastResolvedAddressRef = useRef(null)
  const lastDbLocationFetchAtRef = useRef(0)
  const lastDbLocationRef = useRef(null)
  const lastDbUpdateAtRef = useRef(0)
  const lastDbUpdatedCoordsRef = useRef({ latitude: null, longitude: null })
  const visibilityCleanupRef = useRef(null)
  const gpsRequestSeqRef = useRef(0)

  const GEOCODE_REUSE_DISTANCE_METERS = 120
  const GEOCODE_REUSE_TIME_MS = 10 * 60 * 1000
  const DB_LOCATION_FETCH_TTL_MS = 2 * 60 * 1000
  const DB_UPDATE_MIN_DISTANCE_METERS = 30
  const DB_UPDATE_MIN_INTERVAL_MS = 90 * 1000
  const getDistanceMeters = (lat1, lng1, lat2, lng2) => {
    if (
      typeof lat1 !== "number" ||
      typeof lng1 !== "number" ||
      typeof lat2 !== "number" ||
      typeof lng2 !== "number"
    ) {
      return Number.POSITIVE_INFINITY
    }
    const latDiff = lat2 - lat1
    const lngDiff = lng2 - lng1
    return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff) * 111320
  }

  /* ===================== DB UPDATE (LIVE LOCATION TRACKING) ===================== */
  const updateLocationInDB = async (locationData) => {
    try {
      // Check if location has placeholder values - don't save placeholders
      const hasPlaceholder =
        locationData?.city === "Current Location" ||
        locationData?.address === "Select location" ||
        locationData?.formattedAddress === "Select location" ||
        (!locationData?.city && !locationData?.address && !locationData?.formattedAddress);

      if (hasPlaceholder) {
        debugLog("?? Skipping DB update - location contains placeholder values:", {
          city: locationData?.city,
          address: locationData?.address,
          formattedAddress: locationData?.formattedAddress
        });
        return;
      }

      // Check if user is authenticated before trying to update DB
      const userToken = localStorage.getItem('user_accessToken') || localStorage.getItem('accessToken')
      if (!userToken || userToken === 'null' || userToken === 'undefined') {
        // User not logged in - skip DB update, just use localStorage
        debugLog("?? User not authenticated, skipping DB update (using localStorage only)")
        return
      }

      const dbUpdateDistanceMeters = getDistanceMeters(
        lastDbUpdatedCoordsRef.current.latitude,
        lastDbUpdatedCoordsRef.current.longitude,
        locationData.latitude,
        locationData.longitude
      )
      const dbUpdateAgeMs = Date.now() - lastDbUpdateAtRef.current
      const shouldSkipDbUpdate =
        dbUpdateDistanceMeters < DB_UPDATE_MIN_DISTANCE_METERS &&
        dbUpdateAgeMs < DB_UPDATE_MIN_INTERVAL_MS
      if (shouldSkipDbUpdate) {
        debugLog("Skipping DB update (small movement + recent update):", {
          dbUpdateDistanceMeters: dbUpdateDistanceMeters.toFixed(1),
          dbUpdateAgeMs
        })
        return
      }

      // Prepare complete location data for database storage
      const locationPayload = {
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        address: locationData.address || "",
        city: locationData.city || "",
        state: locationData.state || "",
        area: locationData.area || "",
        formattedAddress: locationData.formattedAddress || locationData.address || "",
      }

      // Add optional fields if available
      if (locationData.accuracy !== undefined && locationData.accuracy !== null) {
        locationPayload.accuracy = locationData.accuracy
      }
      if (locationData.postalCode) {
        locationPayload.postalCode = locationData.postalCode
      }
      if (locationData.street) {
        locationPayload.street = locationData.street
      }
      if (locationData.streetNumber) {
        locationPayload.streetNumber = locationData.streetNumber
      }

      debugLog("?? Updating live location in database:", {
        coordinates: `${locationPayload.latitude}, ${locationPayload.longitude}`,
        formattedAddress: locationPayload.formattedAddress,
        city: locationPayload.city,
        area: locationPayload.area,
        accuracy: locationPayload.accuracy
      })

      await userAPI.updateLocation(locationPayload)
      lastDbUpdatedCoordsRef.current = {
        latitude: locationPayload.latitude,
        longitude: locationPayload.longitude
      }
      lastDbUpdateAtRef.current = Date.now()

      debugLog("? Live location successfully stored in database")
    } catch (err) {
      // Only log non-network and non-auth errors
      if (err.code !== "ERR_NETWORK" && err.response?.status !== 404 && err.response?.status !== 401) {
        debugError("? DB location update error:", err)
      } else if (err.response?.status === 404 || err.response?.status === 401) {
        // 404 or 401 means user not authenticated or route doesn't exist
        // Silently skip - this is expected for non-authenticated users
        debugLog("?? Location update skipped (user not authenticated or route not available)")
      }
    }
  }

  // Same reverse-geocode path as restaurant onboarding: Google JS Geocoder, then Nominatim.
  const reverseGeocodeWithGoogleMaps = async (latitude, longitude, _options = {}) => {
    const forceFresh = Boolean(_options?.forceFresh)
    try {
      const accurate = await reverseGeocodeAccurate(latitude, longitude)
      if (accurate && isMeaningfulAddressValue(accurate.formattedAddress)) {
        return accurate
      }
      return reverseGeocodeDirect(latitude, longitude, forceFresh)
    } catch {
      return reverseGeocodeDirect(latitude, longitude, forceFresh)
    }
  }


  /* ===================== OLA MAPS REVERSE GEOCODE (DEPRECATED - KEPT FOR FALLBACK) ===================== */
  const reverseGeocodeWithOLAMaps = async (latitude, longitude) => {
    try {
      debugLog("?? Fetching address from OLA Maps for:", latitude, longitude)

      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("OLA Maps API timeout")), 10000)
      )

      const apiPromise = locationAPI.reverseGeocode(latitude, longitude)
      const res = await Promise.race([apiPromise, timeoutPromise])

      // Log full response for debugging
      debugLog("?? Full OLA Maps API Response:", JSON.stringify(res?.data, null, 2))

      // Check if response is valid
      if (!res || !res.data) {
        throw new Error("Invalid response from OLA Maps API")
      }

      // Check if API call was successful
      if (res.data.success === false) {
        throw new Error(res.data.message || "OLA Maps API returned error")
      }

      // Backend returns: { success: true, data: { results: [{ formatted_address, address_components: { city, state, country, area } }] } }
      const backendData = res?.data?.data || {}

      // Debug: Check backend data structure
      debugLog("?? Backend data structure:", {
        hasResults: !!backendData.results,
        hasResult: !!backendData.result,
        keys: Object.keys(backendData),
        dataType: typeof backendData,
        backendData: JSON.stringify(backendData, null, 2).substring(0, 500) // First 500 chars
      })

      // Handle different OLA Maps response structures
      // Backend processes OLA Maps response and returns: { results: [{ formatted_address, address_components: { city, state, area } }] }
      let result = null;
      if (backendData.results && Array.isArray(backendData.results) && backendData.results.length > 0) {
        result = backendData.results[0];
        debugLog("? Using results[0] from backend")
      } else if (backendData.result && Array.isArray(backendData.result) && backendData.result.length > 0) {
        result = backendData.result[0];
        debugLog("? Using result[0] from backend")
      } else if (backendData.results && !Array.isArray(backendData.results)) {
        result = backendData.results;
        debugLog("? Using results object from backend")
      } else {
        result = backendData;
        debugLog("?? Using backendData directly (fallback)")
      }

      if (!result) {
        debugWarn("?? No result found in backend data")
        result = {};
      }

      debugLog("?? Parsed result:", {
        hasFormattedAddress: !!result.formatted_address,
        hasAddressComponents: !!result.address_components,
        formattedAddress: result.formatted_address,
        addressComponents: result.address_components
      })

      // Extract address_components - handle both object and array formats
      let addressComponents = {};
      if (result.address_components) {
        if (Array.isArray(result.address_components)) {
          // Google Maps style array
          result.address_components.forEach(comp => {
            const types = comp.types || [];
            if (types.includes('sublocality') || types.includes('sublocality_level_1')) {
              addressComponents.area = comp.long_name || comp.short_name;
            } else if (types.includes('neighborhood') && !addressComponents.area) {
              addressComponents.area = comp.long_name || comp.short_name;
            } else if (types.includes('locality')) {
              addressComponents.city = comp.long_name || comp.short_name;
            } else if (types.includes('administrative_area_level_1')) {
              addressComponents.state = comp.long_name || comp.short_name;
            } else if (types.includes('country')) {
              addressComponents.country = comp.long_name || comp.short_name;
            }
          });
        } else {
          // Object format
          addressComponents = result.address_components;
        }
      } else if (result.components) {
        addressComponents = result.components;
      }

      debugLog("?? Parsed result structure:", {
        result,
        addressComponents,
        hasArrayComponents: Array.isArray(result.address_components),
        hasObjectComponents: !Array.isArray(result.address_components) && !!result.address_components
      })

      // Extract address details - try multiple possible response structures
      let city = addressComponents?.city ||
        result?.city ||
        result?.locality ||
        result?.address_components?.city ||
        ""

      let state = addressComponents?.state ||
        result?.state ||
        result?.administrative_area_level_1 ||
        result?.address_components?.state ||
        ""

      let country = addressComponents?.country ||
        result?.country ||
        result?.country_name ||
        result?.address_components?.country ||
        ""

      let formattedAddress = result?.formatted_address ||
        result?.formattedAddress ||
        result?.address ||
        ""

      // PRIORITY 1: Extract area from formatted_address FIRST (most reliable for Indian addresses)
      // Indian address format: "Area, City, State" e.g., "New Palasia, Indore, Madhya Pradesh"
      // ALWAYS try formatted_address FIRST - it's the most reliable source and preserves full names like "New Palasia"
      let area = ""
      if (formattedAddress) {
        const addressParts = formattedAddress.split(',').map(part => part.trim()).filter(part => part.length > 0)

        debugLog("?? Parsing formatted address for area:", { formattedAddress, addressParts, city, state, currentArea: area })

        // ZOMATO-STYLE: If we have 3+ parts, first part is ALWAYS the area/locality
        // Format: "New Palasia, Indore, Madhya Pradesh" -> area = "New Palasia"
        if (addressParts.length >= 3) {
          const firstPart = addressParts[0]
          const secondPart = addressParts[1] // Usually city
          const thirdPart = addressParts[2]  // Usually state

          // First part is the area (e.g., "New Palasia")
          // Second part is usually city (e.g., "Indore")
          // Third part is usually state (e.g., "Madhya Pradesh")
          if (firstPart && firstPart.length > 2 && firstPart.length < 50) {
            // Make sure first part is not the same as city or state
            const firstLower = firstPart.toLowerCase()
            const cityLower = (city || secondPart || "").toLowerCase()
            const stateLower = (state || thirdPart || "").toLowerCase()

            if (firstLower !== cityLower &&
              firstLower !== stateLower &&
              !firstPart.match(/^\d+/) && // Not a number
              !firstPart.match(/^\d+\s*(km|m|meters?)$/i) && // Not a distance
              !firstLower.includes("district") && // Not a district name
              !firstLower.includes("city")) { // Not a city name
              area = firstPart
              debugLog("??? EXTRACTED AREA from formatted address (3+ parts):", area)

              // Also update city if second part matches better
              if (secondPart && (!city || secondPart.toLowerCase() !== city.toLowerCase())) {
                city = secondPart
              }
              // Also update state if third part matches better
              if (thirdPart && (!state || thirdPart.toLowerCase() !== state.toLowerCase())) {
                state = thirdPart
              }
            }
          }
        } else if (addressParts.length === 2 && !area) {
          // Two parts: Could be "Area, City" or "City, State"
          const firstPart = addressParts[0]
          const secondPart = addressParts[1]

          // Check if first part is city (if we already have city name)
          const isFirstCity = city && firstPart.toLowerCase() === city.toLowerCase()

          // If first part is NOT the city, it's likely the area
          if (!isFirstCity &&
            firstPart.length > 2 &&
            firstPart.length < 50 &&
            !firstPart.toLowerCase().includes("district") &&
            !firstPart.toLowerCase().includes("city") &&
            !firstPart.match(/^\d+/)) {
            area = firstPart
            debugLog("? Extracted area from 2 part address:", area)
            // Update city if second part exists
            if (secondPart && !city) {
              city = secondPart
            }
          } else if (isFirstCity) {
            // First part is city, second part might be state
            // No area in this case, but update state if needed
            if (secondPart && !state) {
              state = secondPart
            }
          }
        } else if (addressParts.length === 1 && !area) {
          // Single part - could be just city or area
          const singlePart = addressParts[0]
          if (singlePart && singlePart.length > 2 && singlePart.length < 50) {
            // If it doesn't match city exactly, it might be an area
            if (!city || singlePart.toLowerCase() !== city.toLowerCase()) {
              // Don't use as area if it looks like a city name (contains common city indicators)
              if (!singlePart.toLowerCase().includes("city") &&
                !singlePart.toLowerCase().includes("district")) {
                // Could be area, but be cautious - only use if we're sure
                debugLog("?? Single part address - ambiguous, not using as area:", singlePart)
              }
            }
          }
        }
      }

      // PRIORITY 2: If still no area from formatted_address, try from address_components (fallback)
      // Note: address_components might have incomplete/truncated names like "Palacia" instead of "New Palasia"
      // So we ALWAYS prefer formatted_address extraction over address_components
      if (!area && addressComponents) {
        // Try all possible area fields (but exclude state and generic names!)
        const possibleAreaFields = [
          addressComponents.sublocality,
          addressComponents.sublocality_level_1,
          addressComponents.neighborhood,
          addressComponents.sublocality_level_2,
          addressComponents.locality,
          addressComponents.area, // Check area last
        ].filter(field => {
          // Filter out invalid/generic area names
          if (!field) return false
          const fieldLower = field.toLowerCase()
          return fieldLower !== state.toLowerCase() &&
            fieldLower !== city.toLowerCase() &&
            !fieldLower.includes("district") &&
            !fieldLower.includes("city") &&
            field.length > 3 // Minimum length
        })

        if (possibleAreaFields.length > 0) {
          const fallbackArea = possibleAreaFields[0]
          // CRITICAL: If formatted_address exists and has a different area, prefer formatted_address
          // This ensures "New Palasia" from formatted_address beats "Palacia" from address_components
          if (formattedAddress && formattedAddress.toLowerCase().includes(fallbackArea.toLowerCase())) {
            // formatted_address contains the fallback area, so it's likely more complete
            // Try one more time to extract from formatted_address
            debugLog("?? address_components has area but formatted_address might have full name, re-checking formatted_address")
          } else {
            area = fallbackArea
            debugLog("? Extracted area from address_components (fallback):", area)
          }
        }
      }

      // Also check address_components array structure (Google Maps style)
      if (!area && result?.address_components && Array.isArray(result.address_components)) {
        const components = result.address_components
        // Find sublocality or neighborhood in the components array
        const sublocality = components.find(comp =>
          comp.types?.includes('sublocality') ||
          comp.types?.includes('sublocality_level_1') ||
          comp.types?.includes('neighborhood')
        )
        if (sublocality?.long_name || sublocality?.short_name) {
          area = sublocality.long_name || sublocality.short_name
        }
      }

      // FINAL FALLBACK: If area is still empty, force extract from formatted_address
      // This is the last resort - be very aggressive (ZOMATO-STYLE)
      // Even if formatted_address only has 2 parts (City, State), try to extract area
      if (!area && formattedAddress) {
        const parts = formattedAddress.split(',').map(p => p.trim()).filter(p => p.length > 0)
        debugLog("?? Final fallback: Parsing formatted_address for area", { parts, city, state })

        if (parts.length >= 2) {
          const potentialArea = parts[0]
          // Very lenient check - if it's not obviously city/state, use it as area
          const potentialAreaLower = potentialArea.toLowerCase()
          const cityLower = (city || "").toLowerCase()
          const stateLower = (state || "").toLowerCase()

          if (potentialArea &&
            potentialArea.length > 2 &&
            potentialArea.length < 50 &&
            !potentialArea.match(/^\d+/) &&
            potentialAreaLower !== cityLower &&
            potentialAreaLower !== stateLower &&
            !potentialAreaLower.includes("district") &&
            !potentialAreaLower.includes("city")) {
            area = potentialArea
            debugLog("??? FORCE EXTRACTED area (final fallback):", area)
          }
        }
      }

      // Final validation and logging
      debugLog("??? FINAL PARSED OLA Maps response:", {
        city,
        state,
        country,
        area,
        formattedAddress,
        hasArea: !!area,
        areaLength: area?.length || 0
      })

      // CRITICAL: If formattedAddress has only 2 parts, OLA Maps didn't provide sublocality
      // Try to get more detailed location using coordinates-based search
      if (!area && formattedAddress) {
        const parts = formattedAddress.split(',').map(p => p.trim()).filter(p => p.length > 0)

        // If we have 3+ parts, extract area from first part
        if (parts.length >= 3) {
          // ZOMATO PATTERN: "New Palasia, Indore, Madhya Pradesh"
          // First part = Area, Second = City, Third = State
          const potentialArea = parts[0]
          // Validate it's not state, city, or generic names
          const potentialAreaLower = potentialArea.toLowerCase()
          if (potentialAreaLower !== state.toLowerCase() &&
            potentialAreaLower !== city.toLowerCase() &&
            !potentialAreaLower.includes("district") &&
            !potentialAreaLower.includes("city")) {
            area = potentialArea
            if (!city && parts[1]) city = parts[1]
            if (!state && parts[2]) state = parts[2]
            debugLog("??? ZOMATO-STYLE EXTRACTION:", { area, city, state })
          }
        } else if (parts.length === 2) {
          // Only 2 parts: "Indore, Madhya Pradesh" - area is missing
          // OLA Maps API didn't provide sublocality
          debugWarn("?? Only 2 parts in address - OLA Maps didn't provide sublocality")
          // Try to extract from other fields in the response
          // Check if result has any other location fields
          if (result.locality && result.locality !== city) {
            area = result.locality
            debugLog("? Using locality as area:", area)
          } else if (result.neighborhood) {
            area = result.neighborhood
            debugLog("? Using neighborhood as area:", area)
          } else {
            // Leave area empty - will show city instead
            area = ""
          }
        }
      }

      // FINAL VALIDATION: Never use state as area!
      if (area && state && area.toLowerCase() === state.toLowerCase()) {
        debugWarn("?????? REJECTING area (same as state):", area)
        area = ""
      }

      // FINAL VALIDATION: Reject district names
      if (area && area.toLowerCase().includes("district")) {
        debugWarn("?????? REJECTING area (contains district):", area)
        area = ""
      }

      // If we have a valid formatted address or city, return it
      if (formattedAddress || city) {
        const finalLocation = {
          city: city || "Unknown City",
          state: state || "",
          country: country || "",
          area: area || "", // Area is CRITICAL - must be extracted
          address: formattedAddress || `${city || "Current Location"}`,
          formattedAddress: formattedAddress || `${city || "Current Location"}`,
        }

        debugLog("??? RETURNING LOCATION DATA:", finalLocation)
        return finalLocation
      }

      // If no valid data, throw to trigger fallback
      throw new Error("No valid address data from OLA Maps")
    } catch (err) {
      debugWarn("?? OLA Maps geocoding failed, trying BigDataCloud:", err.message)
      // Fallback to direct reverse geocoding (BigDataCloud)
      try {
        return await reverseGeocodeWithGoogleMaps(latitude, longitude)
      } catch (fallbackErr) {
        // If all fail, return minimal location data
        debugError("? All reverse geocoding failed:", fallbackErr)
        return {
          city: "Current Location",
          address: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
          formattedAddress: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
        }
      }
    }
  }
  const fetchLocationFromDB = async () => {
    try {
      // Check if user is authenticated before trying to fetch from DB
      const userToken = localStorage.getItem('user_accessToken') || localStorage.getItem('accessToken')
      if (!userToken || userToken === 'null' || userToken === 'undefined') {
        // User not logged in - skip DB fetch, return null to use localStorage
        return null
      }

      const dbLocationAgeMs = Date.now() - lastDbLocationFetchAtRef.current
      if (lastDbLocationRef.current && dbLocationAgeMs < DB_LOCATION_FETCH_TTL_MS) {
        return lastDbLocationRef.current
      }

      if (typeof userAPI?.getLocation !== "function") {
        return null
      }
      const res = await userAPI.getLocation()
      const loc = res?.data?.data?.location
      if (loc?.latitude && loc?.longitude) {
        // Validate coordinates are in India range BEFORE attempting geocoding
        const isInIndiaRange = loc.latitude >= 6.5 && loc.latitude <= 37.1 && loc.longitude >= 68.7 && loc.longitude <= 97.4 && loc.longitude > 0

        if (!isInIndiaRange || loc.longitude < 0) {
          // Coordinates are outside India - return placeholder
          debugWarn("?? Coordinates from DB are outside India range:", { latitude: loc.latitude, longitude: loc.longitude })
          const outOfRangeLocation = {
            latitude: loc.latitude,
            longitude: loc.longitude,
            ...DEFAULT_LOCATION,
          }
          lastDbLocationRef.current = outOfRangeLocation
          lastDbLocationFetchAtRef.current = Date.now()
          return outOfRangeLocation
        }

        const hasUsableStoredAddress =
          (loc.formattedAddress && loc.formattedAddress !== "Select location") ||
          (loc.address && loc.address !== "Select location") ||
          (loc.city && loc.city !== "Current Location")

        if (hasUsableStoredAddress) {
          const storedLocation = {
            latitude: loc.latitude,
            longitude: loc.longitude,
            city: loc.city || "Current Location",
            area: loc.area || "",
            state: loc.state || "",
            country: loc.country || "",
            address: loc.address || loc.formattedAddress || DEFAULT_LOCATION.address,
            formattedAddress: loc.formattedAddress || loc.address || DEFAULT_LOCATION.formattedAddress
          }
          lastDbLocationRef.current = storedLocation
          lastDbLocationFetchAtRef.current = Date.now()
          return storedLocation
        }

        try {
          const addr = await reverseGeocodeWithGoogleMaps(
            loc.latitude,
            loc.longitude,
            { includePlaceDetails: false }
          )
          const resolvedLocation = { ...addr, latitude: loc.latitude, longitude: loc.longitude }
          lastDbLocationRef.current = resolvedLocation
          lastDbLocationFetchAtRef.current = Date.now()
          return resolvedLocation
        } catch (geocodeErr) {
          // If reverse geocoding fails, return location without coordinates in address
          debugWarn("?? Reverse geocoding failed in fetchLocationFromDB:", geocodeErr.message)
          const fallbackLocation = {
            latitude: loc.latitude,
            longitude: loc.longitude,
            ...DEFAULT_LOCATION,
          }
          lastDbLocationRef.current = fallbackLocation
          lastDbLocationFetchAtRef.current = Date.now()
          return fallbackLocation
        }
      }
    } catch (err) {
      // Silently fail for 404/401 (user not authenticated) or network errors
      if (err.code !== "ERR_NETWORK" && err.response?.status !== 404 && err.response?.status !== 401) {
        debugError("DB location fetch error:", err)
      }
    }
    return null
  }

  /* ===================== MAIN LOCATION ===================== */
  const getLocation = async (updateDB = true, forceFresh = false, showLoading = false) => {
    const requestId = ++gpsRequestSeqRef.current
    const isCurrentGpsRequest = () => requestId === gpsRequestSeqRef.current

    // Show last-known location immediately, but never treat DB/cache as the final
    // answer when we can still read a live GPS fix.
    let dbLocation = !forceFresh ? await fetchLocationFromDB() : null
    if (dbLocation) {
      setLocation(dbLocation)
      if (showLoading) setLoading(false)
    }

    if (forceFresh && Date.now() - globalAccurateGpsLastAt < GLOBAL_ACCURATE_GPS_MIN_INTERVAL_MS) {
      if (globalAccurateGpsInFlight) {
        try {
          const inFlight = await globalAccurateGpsInFlight
          if (inFlight) {
            setLocation(inFlight)
            if (showLoading) setLoading(false)
            return inFlight
          }
        } catch {
          // Fall through and request a new GPS fix.
        }
      } else {
        const recent = readStoredUserLocation() || dbLocation
        if (recent) {
          setLocation(recent)
          if (showLoading) setLoading(false)
          return recent
        }
      }
    }

    if (!navigator.geolocation) {
      setError("Geolocation not supported")
      if (showLoading) setLoading(false)
      return dbLocation
    }

    // Helper function to get position with retry mechanism
    const getPositionWithRetry = (options, retryCount = 0) => {
      return new Promise((resolve, reject) => {
        const isRetry = retryCount > 0
        debugLog(`?? Requesting location${isRetry ? ' (retry with lower accuracy)' : ' (high accuracy)'}...`)
        debugLog(`?? Force fresh: ${forceFresh ? 'YES' : 'NO'}, maximumAge: ${options.maximumAge || (forceFresh ? 0 : 60000)}`)

        const geoOptions = {
          ...HIGH_ACCURACY_GEO_OPTIONS,
          ...options,
          maximumAge: 0,
        }

        const applyPosition = async (pos) => {
            if (!isCurrentGpsRequest()) {
              return null
            }
            const { latitude, longitude, accuracy } = pos.coords
            const timestamp = pos.timestamp || Date.now()
            const age = Date.now() - timestamp

            if (forceFresh && age > STALE_GPS_MS) {
              debugWarn(`Stale GPS location detected (age: ${age}ms), rejecting...`)
              throw { code: 3, message: "Stale location" }
            }

            try {

              debugLog(`Got location${isRetry ? ' (lower accuracy)' : ' (high accuracy)'}:`, {
                latitude,
                longitude,
                accuracy: `${accuracy}m`,
                timestamp: new Date(timestamp).toISOString(),
                coordinates: `${latitude.toFixed(8)}, ${longitude.toFixed(8)}`
              })

              // Validate coordinates are in India range BEFORE attempting geocoding
              // India: Latitude 6.5 to 37.1 N, Longitude 68.7 to 97.4 E
              const isInIndiaRange = latitude >= 6.5 && latitude <= 37.1 && longitude >= 68.7 && longitude <= 97.4 && longitude > 0

              // Reverse geocode (BigDataCloud via reverseGeocodeWithGoogleMaps wrapper)
              let addr
              if (!isInIndiaRange || longitude < 0) {
                // Coordinates are outside India - skip geocoding and use placeholder
                debugWarn("?? Coordinates outside India range, skipping geocoding:", { latitude, longitude })
                addr = {
                  ...DEFAULT_LOCATION,
                }
              } else {
                debugLog("?? Calling reverse geocode with coordinates:", { latitude, longitude })
                try {
                  addr = await reverseGeocodeWithGoogleMaps(latitude, longitude, {
                    includePlaceDetails: Boolean(forceFresh && showLoading),
                    forceFresh,
                  })
                  debugLog("? Reverse geocoding successful:", addr)
                } catch (geocodeErr) {
                  debugWarn("?? Primary geocoding failed, trying fallback:", geocodeErr.message)
                  try {
                    // Fallback to direct reverse geocode (BigDataCloud)
                    addr = await reverseGeocodeDirect(latitude, longitude, forceFresh)
                    debugLog("? Fallback geocoding successful:", addr)

                    // Validate fallback result - if it still has placeholder values, don't use it
                    if (addr.city === "Current Location" || addr.address.includes(latitude.toFixed(4))) {
                      debugWarn("?? Fallback geocoding returned placeholder, will not save")
                      addr = {
                        ...DEFAULT_LOCATION,
                      }
                    }
                  } catch (fallbackErr) {
                    debugError("? All geocoding methods failed:", fallbackErr.message)
                    addr = {
                      ...DEFAULT_LOCATION,
                    }
                  }
                }
              }
              debugLog("Reverse geocode result:", addr)
              if (addr?.formattedAddress && addr.formattedAddress !== "Select location") {
                lastResolvedAddressRef.current = addr
                lastGeocodedCoordsRef.current = { latitude, longitude }
                lastGeocodeAtRef.current = Date.now()
              }
              // Ensure we don't use coordinates as address if we have area/city
              // Keep the complete formattedAddress from geocoder when available
              const completeFormattedAddress = addr.formattedAddress || "";
              let displayAddress = addr.address || "";

              // If address contains coordinates pattern, use area/city instead
              const isCoordinatesPattern = /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(displayAddress.trim());
              if (isCoordinatesPattern) {
                if (addr.area && addr.area.trim() !== "") {
                  displayAddress = addr.area;
                } else if (addr.city && addr.city.trim() !== "" && addr.city !== "Unknown City") {
                  displayAddress = addr.city;
                }
              }

              // Build location object with ALL fields from reverse geocoding
              const finalLoc = {
                ...addr, // This includes: city, state, area, street, streetNumber, postalCode, formattedAddress
                latitude,
                longitude,
                accuracy: accuracy || null,
                address: displayAddress, // Locality parts for navbar display
                formattedAddress: completeFormattedAddress || addr.formattedAddress || displayAddress // Complete detailed address
              }

              // Check if location has placeholder values - don't save placeholders
              const hasPlaceholder =
                finalLoc.city === "Current Location" ||
                finalLoc.address === "Select location" ||
                finalLoc.formattedAddress === "Select location" ||
                (!finalLoc.city && !finalLoc.address && !finalLoc.formattedAddress && !finalLoc.area);

              if (hasPlaceholder) {
                debugWarn("?? Geocoding returned placeholder — persisting GPS coords only:", finalLoc)
                const coordOnlyLoc = {
                  latitude,
                  longitude,
                  accuracy: accuracy || null,
                  city: finalLoc.city && finalLoc.city !== "Select location" ? finalLoc.city : "Current location",
                  address: finalLoc.address && finalLoc.address !== "Select location" ? finalLoc.address : "Current location",
                  formattedAddress: finalLoc.formattedAddress && finalLoc.formattedAddress !== "Select location" ? finalLoc.formattedAddress : "Current location",
                }
                persistUserLocation(coordOnlyLoc)
                notifyUserLocationChanged(coordOnlyLoc)
                setLocation(coordOnlyLoc)
                setPermissionGranted(true)
                if (showLoading) setLoading(false)
                setError(null)
                resolve(coordOnlyLoc)
                return
              }

              debugLog("?? Saving location:", finalLoc)
              persistUserLocation(finalLoc)
              notifyUserLocationChanged(finalLoc)
              setLocation(finalLoc)
              setPermissionGranted(true)
              if (showLoading) setLoading(false)
              setError(null)

              if (updateDB) {
                await updateLocationInDB(finalLoc).catch(err => {
                  debugWarn("Failed to update location in DB:", err)
                })
              }
              resolve(finalLoc)
            } catch (err) {
              debugError("? Error processing location:", err)
              // Try one more time with direct reverse geocode as last resort
              const { latitude, longitude } = pos.coords

              try {
                debugLog("?? Last attempt: trying direct reverse geocode...")
                const lastResortAddr = await reverseGeocodeDirect(latitude, longitude, forceFresh)

                // Check if we got valid data (not just coordinates)
                if (lastResortAddr &&
                  lastResortAddr.city !== "Current Location" &&
                  !lastResortAddr.address.includes(latitude.toFixed(4)) &&
                  lastResortAddr.formattedAddress &&
                  !lastResortAddr.formattedAddress.includes(latitude.toFixed(4))) {
                  const lastResortLoc = {
                    ...lastResortAddr,
                    latitude,
                    longitude,
                    accuracy: pos.coords.accuracy || null
                  }
                  debugLog("? Last resort geocoding succeeded:", lastResortLoc)
                  persistUserLocation(lastResortLoc)
                  notifyUserLocationChanged(lastResortLoc)
                  setLocation(lastResortLoc)
                  setPermissionGranted(true)
                  if (showLoading) setLoading(false)
                  setError(null)
                  if (updateDB) await updateLocationInDB(lastResortLoc).catch(() => { })
                  resolve(lastResortLoc)
                  return
                } else {
                  debugWarn("?? Last resort geocoding returned invalid data:", lastResortAddr)
                }
              } catch (lastErr) {
                debugError("? Last resort geocoding also failed:", lastErr.message)
              }

              // If all geocoding fails, use placeholder but don't save
              const fallbackLoc = {
                latitude,
                longitude,
                ...DEFAULT_LOCATION,
              }
              // Don't save placeholder values to localStorage
              // Only set in state for display
              debugWarn("?? Skipping save - all geocoding failed, using placeholder")
              setLocation(fallbackLoc)
              setPermissionGranted(true)
              if (showLoading) setLoading(false)
              // Don't try to update DB with placeholder
              resolve(fallbackLoc)
            }
        }

        const onError = async (err) => {
            // If timeout and we haven't retried yet, try with lower accuracy
            if (err.code === 3 && retryCount === 0 && options.enableHighAccuracy) {
              debugWarn("?? High accuracy timeout, retrying with lower accuracy...")
              getPositionWithRetry({
                enableHighAccuracy: false,
                timeout: 10000,
                maximumAge: forceFresh ? 0 : 300000,
              }, 1).then(resolve).catch(reject)
              return
            }

            // Don't log timeout errors as errors - they're expected in some cases
            if (err.code === 3) {
              debugWarn("?? Geolocation timeout (code 3) - using fallback location")
            } else {
              debugError("? Geolocation error:", err.code, err.message)
            }
            if (forceFresh) {
              debugWarn("Fresh GPS request failed — keeping last known location")
              const lastKnown = readStoredUserLocation() || dbLocation
              if (lastKnown) {
                setLocation(lastKnown)
                setPermissionGranted(true)
              }
              if (err.code !== 3) setError(err.message)
              if (showLoading) setLoading(false)
              resolve(lastKnown || null)
              return
            }

            // Try multiple fallback strategies
            try {
              // Strategy 1: Use DB location if available
              let fallback = dbLocation
              if (!fallback) {
                fallback = await fetchLocationFromDB()
              }

              // Strategy 2: Use cached location from localStorage
              if (!fallback) {
                const stored = localStorage.getItem("userLocation")
                if (stored) {
                  try {
                    fallback = JSON.parse(stored)
                    debugLog("? Using cached location from localStorage")
                  } catch (parseErr) {
                    debugWarn("?? Failed to parse stored location:", parseErr)
                  }
                }
              }

              if (fallback) {
                debugLog("? Using fallback location:", fallback)
                setLocation(fallback)
                // Don't set error for timeout when we have fallback
                if (err.code !== 3) {
                  setError(err.message)
                }
                setPermissionGranted(true) // Still grant permission if we have location
                if (showLoading) setLoading(false)
                resolve(fallback)
              } else {
                // No fallback available: keep location unset instead of forcing an inaccurate city.
                debugWarn("?? No fallback location available, keeping location unset")
                setLocation(null)
                setError(err.code === 3 ? "Location request timed out. Please try again." : err.message)
                setPermissionGranted(false)
                if (showLoading) setLoading(false)
                resolve(null)
              }
            } catch (fallbackErr) {
              debugWarn("?? Fallback retrieval failed:", fallbackErr)
              setLocation(null)
              setError(err.code === 3 ? "Location request timed out. Please try again." : err.message)
              setPermissionGranted(false)
              if (showLoading) setLoading(false)
              resolve(null)
            }
        }

        const requestPosition = forceFresh && retryCount === 0
          ? getBestAccuratePosition({ ...geoOptions, watchMs: ACCURACY_WATCH_MS })
          : new Promise((res, rej) => {
              navigator.geolocation.getCurrentPosition(res, rej, geoOptions)
            })

        requestPosition.then(applyPosition).catch(onError)
      })
    }

    globalAccurateGpsLastAt = Date.now()
    const gpsPromise = getPositionWithRetry(HIGH_ACCURACY_GEO_OPTIONS)
    globalAccurateGpsInFlight = gpsPromise
    return gpsPromise.finally(() => {
      if (globalAccurateGpsInFlight === gpsPromise) {
        globalAccurateGpsInFlight = null
      }
    })
  }

  /* ===================== WATCH LOCATION ===================== */
  const startWatchingLocation = () => {
    if (!navigator.geolocation) {
      debugWarn("?? Geolocation not supported")
      return
    }

    // Clear any existing watch
    if (watchIdRef.current) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }

    debugLog("?? Starting to watch location for live updates...")

    let retryCount = 0
    const maxRetries = 2

    const startWatch = (options) => {
      watchIdRef.current = navigator.geolocation.watchPosition(
        async (pos) => {
          try {
            const { latitude, longitude, accuracy } = pos.coords
            debugLog("?? Location updated:", { latitude, longitude, accuracy: `${accuracy}m` })
            retryCount = 0

            const isInIndiaRange = latitude >= 6.5 && latitude <= 37.1 && longitude >= 68.7 && longitude <= 97.4 && longitude > 0

            let addr
            if (!isInIndiaRange || longitude < 0) {
              debugWarn("?? Coordinates outside India range; skipping reverse geocoding:", { latitude, longitude })
              addr = {
                ...DEFAULT_LOCATION,
              }
            } else {
              const lastAddr = lastResolvedAddressRef.current
              const addressDriftMeters =
                lastAddr?.latitude && lastAddr?.longitude
                  ? getDistanceMeters(lastAddr.latitude, lastAddr.longitude, latitude, longitude)
                  : Number.POSITIVE_INFINITY

              if (
                addressDriftMeters > 200 &&
                Date.now() - lastGeocodeAtRef.current > 15_000
              ) {
                try {
                  addr = await reverseGeocodeWithGoogleMaps(latitude, longitude, {
                    includePlaceDetails: false,
                  })
                  if (addr?.formattedAddress && addr.formattedAddress !== "Select location") {
                    lastResolvedAddressRef.current = { ...addr, latitude, longitude }
                    lastGeocodeAtRef.current = Date.now()
                  }
                } catch {
                  addr = lastAddr || { ...DEFAULT_LOCATION }
                }
              } else if (
                lastAddr?.formattedAddress &&
                lastAddr.formattedAddress !== "Select location"
              ) {
                addr = lastAddr
              } else {
                addr = { ...DEFAULT_LOCATION }
              }
            }

            let completeFormattedAddress = addr.formattedAddress || "";
            let displayAddress = addr.address || "";

            const isFormattedAddressCoordinates = /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(completeFormattedAddress.trim());
            const isDisplayAddressCoordinates = /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(displayAddress.trim());

            if (isFormattedAddressCoordinates || !completeFormattedAddress || completeFormattedAddress === "Select location") {
              const addressParts = [];
              if (addr.area && addr.area.trim() !== "") {
                addressParts.push(addr.area);
              }
              if (addr.city && addr.city.trim() !== "") {
                addressParts.push(addr.city);
              }
              if (addr.state && addr.state.trim() !== "") {
                addressParts.push(addr.state);
              }

              if (addressParts.length > 0) {
                completeFormattedAddress = addressParts.join(', ');
                displayAddress = addr.area || addr.city || DEFAULT_LOCATION.address;
              } else {
                completeFormattedAddress = addr.city || DEFAULT_LOCATION.formattedAddress;
                displayAddress = addr.city || DEFAULT_LOCATION.address;
              }
            }

            if (isDisplayAddressCoordinates) {
              displayAddress = addr.area || addr.city || DEFAULT_LOCATION.address;
            }

            let loc = {
              ...addr,
              latitude,
              longitude,
              accuracy: accuracy || null,
              address: displayAddress,
              formattedAddress: completeFormattedAddress
            }

            const currentLoc = location
            if (currentLoc && currentLoc.latitude && currentLoc.longitude) {
              const latDiff = latitude - currentLoc.latitude
              const lngDiff = longitude - currentLoc.longitude
              const distanceMeters = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff) * 111320

              const currentParts = (currentLoc.formattedAddress || "").split(',').filter(p => p.trim()).length
              const newParts = completeFormattedAddress.split(',').filter(p => p.trim()).length
              const addressImproved = newParts > currentParts

              if (distanceMeters <= 10 && !addressImproved) {
                return
              }
            }

            if (loc.formattedAddress && /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(loc.formattedAddress.trim())) {
              loc.formattedAddress = loc.area || loc.city || DEFAULT_LOCATION.formattedAddress;
              loc.address = loc.area || loc.city || DEFAULT_LOCATION.address;
            }

            const hasPlaceholder =
              loc.city === "Current Location" ||
              loc.address === "Select location" ||
              loc.formattedAddress === "Select location" ||
              (!loc.city && !loc.address && !loc.formattedAddress && !loc.area);

            const shouldPersistLocation = !hasPlaceholder
            if (hasPlaceholder) {
              const existingAddress =
                (location && typeof location === "object" ? location : null) ||
                (() => {
                  try {
                    const raw = localStorage.getItem("userLocation")
                    return raw ? JSON.parse(raw) : null
                  } catch {
                    return null
                  }
                })()

              loc = {
                ...loc,
                city: existingAddress?.city && existingAddress.city !== "Current Location" ? existingAddress.city : loc.city,
                area: existingAddress?.area || loc.area,
                state: existingAddress?.state || loc.state,
                address: existingAddress?.address && existingAddress.address !== "Select location" ? existingAddress.address : loc.address,
                formattedAddress: existingAddress?.formattedAddress && existingAddress.formattedAddress !== "Select location" ? existingAddress.formattedAddress : loc.formattedAddress,
              }
            }

            const coordThreshold = 0.0001
            const coordsChanged =
              !prevLocationCoordsRef.current.latitude ||
              !prevLocationCoordsRef.current.longitude ||
              Math.abs(prevLocationCoordsRef.current.latitude - loc.latitude) > coordThreshold ||
              Math.abs(prevLocationCoordsRef.current.longitude - loc.longitude) > coordThreshold
            
            let persistedLocation = loc
            try {
              const storedRaw = localStorage.getItem("userLocation")
              const storedLocation = storedRaw ? JSON.parse(storedRaw) : null
              const savedLabel = loc?.label || storedLocation?.label
              if (savedLabel && String(savedLabel).trim()) {
                persistedLocation = { ...loc, label: String(savedLabel).trim() }
              }
            } catch {
              persistedLocation = loc
            }

            if (coordsChanged) {
              prevLocationCoordsRef.current = { latitude: loc.latitude, longitude: loc.longitude }
              if (shouldPersistLocation) {
                localStorage.setItem("userLocation", JSON.stringify(persistedLocation))
              }
              setLocation(persistedLocation)
              setPermissionGranted(true)
              setError(null)
            } else if (shouldPersistLocation) {
              localStorage.setItem("userLocation", JSON.stringify(persistedLocation))
            }

            if (shouldPersistLocation) {
              clearTimeout(updateTimerRef.current)
              updateTimerRef.current = setTimeout(() => {
                updateLocationInDB(loc).catch(() => {})
              }, 5000)
            }
          } catch (err) {
            debugError("?? Error in watchPosition callback:", err)
          }
        },
        (err) => {
          debugWarn("?? watchPosition error:", err.code, err.message)
          if (err.code === 1) { // PERMISSION_DENIED
            setPermissionGranted(false)
            stopWatchingLocation()
          } else if (retryCount < maxRetries) {
            retryCount++
            stopWatchingLocation()
            setTimeout(() => startWatch({ enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }), 5000)
          }
        },
        options
      )
    }

    startWatch(LIVE_WATCH_GEO_OPTIONS)
  }

  const stopWatchingLocation = () => {
    if (watchIdRef.current) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
      debugLog("?? Stopped watching location")
    }
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current)
    }
  }

  useEffect(() => {
    let hasInitialLocation = false
    let initialResolvedLocation = null
    const hasUsableSavedLocation = (loc) => {
      if (!loc || typeof loc !== "object") return false
      const lat = Number(loc.latitude)
      const lng = Number(loc.longitude)
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lng)
      const hasAddress =
        (loc.formattedAddress && loc.formattedAddress !== "Select location") ||
        (loc.address && loc.address !== "Select location") ||
        (loc.city && loc.city !== "Current Location")
      return hasCoords && Boolean(hasAddress)
    }

    const loadingTimeout = setTimeout(() => {
      setLoading(false)
    }, 5000)

    const init = async () => {
      try {
        const stored = localStorage.getItem("userLocation")
        if (stored) {
          try {
            const loc = JSON.parse(stored)
            if (loc?.latitude && loc?.longitude) {
              setLocation(loc)
              initialResolvedLocation = loc
              hasInitialLocation = true
              setLoading(false)
              setPermissionGranted(true)

            }
          } catch (e) {
            debugWarn("Failed to parse stored location", e)
          }
        }

        const dbLoc = await fetchLocationFromDB()
        if (dbLoc) {
          setLocation(dbLoc)
          initialResolvedLocation = dbLoc
          hasInitialLocation = true
          setLoading(false)
          setPermissionGranted(true)
        }

        if (!hasInitialLocation) {
          setLocation(null)
          setLoading(false)
        }

        const currentKnownLocation = initialResolvedLocation || lastDbLocationRef.current || location
        const hasUsableInitialLocation = hasUsableSavedLocation(currentKnownLocation)

        const readGeoPermission = async () => {
          try {
            if (navigator.permissions?.query) {
              const result = await navigator.permissions.query({ name: "geolocation" })
              return result.state
            }
          } catch {
            // Permissions API can throw in some webviews.
          }
          return "prompt"
        }

        const refreshLiveGps = async ({ promptIfNeeded = false } = {}) => {
          if (!navigator.geolocation) return null
          const permissionState = await readGeoPermission()
          if (permissionState === "denied") return null
          if (permissionState === "prompt" && !promptIfNeeded) return null

          const freshLoc = await getLocation(true, true, false)
          if (freshLoc) {
            setLocation(freshLoc)
            persistUserLocation(freshLoc)
            notifyUserLocationChanged(freshLoc)
          }
          if (AUTO_START_LIVE_WATCH) startWatchingLocation()
          return freshLoc
        }

        // Always ask for a live GPS fix on a new tab / first load.
        // Cached DB/localStorage is only used as a fast first paint.
        void refreshLiveGps({ promptIfNeeded: true })

        const onTabVisible = () => {
          if (typeof document !== "undefined" && document.visibilityState && document.visibilityState !== "visible") {
            return
          }
          void refreshLiveGps({ promptIfNeeded: !hasUsableInitialLocation })
        }

        window.addEventListener("focus", onTabVisible)
        window.addEventListener("pageshow", onTabVisible)
        document.addEventListener("visibilitychange", onTabVisible)
        visibilityCleanupRef.current = () => {
          window.removeEventListener("focus", onTabVisible)
          window.removeEventListener("pageshow", onTabVisible)
          document.removeEventListener("visibilitychange", onTabVisible)
        }
      } catch (err) {
        debugError("Initialization error", err)
      } finally {
        setLoading(false)
      }
    }

    init()

    return () => {
      clearTimeout(loadingTimeout)
      visibilityCleanupRef.current?.()
      visibilityCleanupRef.current = null
      stopWatchingLocation()
    }
  }, [])

  useEffect(() => {
    const applyLocation = (locationData) => {
      if (!locationData?.latitude || !locationData?.longitude) return false

      setLocation(locationData)
      lastResolvedAddressRef.current = locationData
      prevLocationCoordsRef.current = {
        latitude: locationData.latitude,
        longitude: locationData.longitude,
      }
      return true
    }

    const syncFromStorage = (event) => {
      if (applyLocation(event?.detail)) return

      const stored = readStoredUserLocation()
      applyLocation(stored)
    }

    const onModeChanged = () => {
      if (AUTO_START_LIVE_WATCH) {
        startWatchingLocation()
      }
    }

    window.addEventListener("userLocationChanged", syncFromStorage)
    window.addEventListener("deliveryAddressModeChanged", onModeChanged)
    return () => {
      window.removeEventListener("userLocationChanged", syncFromStorage)
      window.removeEventListener("deliveryAddressModeChanged", onModeChanged)
    }
  }, [])

  const requestLocation = async (options = {}) => {
    const live = options?.live === true
    const fresh = options?.fresh === true || live
    const silent = options?.silent === true
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      if (live || fresh) {
        gpsRequestSeqRef.current += 1
        globalAccurateGpsLastAt = 0
        globalAccurateGpsInFlight = null
        clearReverseGeocodeCache()
        lastResolvedAddressRef.current = null
        lastGeocodedCoordsRef.current = { latitude: null, longitude: null }
        lastGeocodeAtRef.current = 0
      }
      if (live) {
        setDeliveryAddressMode("current")
      }
      const loc = await getLocation(true, fresh, !silent)
      setPermissionGranted(true)
      if (loc) {
        persistUserLocation(loc)
        notifyUserLocationChanged(loc)
      }
      if (AUTO_START_LIVE_WATCH) {
        startWatchingLocation()
      }
      return loc
    } catch (err) {
      setError(err.message || "Failed to get location")
      throw err
    } finally {
      if (!silent) setLoading(false)
    }
  }

  return {
    location,
    loading,
    error,
    permissionGranted,
    requestLocation,
    startWatchingLocation,
    stopWatchingLocation,
  }
}
