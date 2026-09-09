import { parseGeoPoint } from "@food/utils/geo"

export const DELIVERY_ADDRESS_MODE_KEY = "deliveryAddressMode"
export const USER_LOCATION_KEY = "userLocation"

export function getDeliveryAddressMode() {
  if (typeof window === "undefined") return "current"
  return window.localStorage.getItem(DELIVERY_ADDRESS_MODE_KEY) || "current"
}

export function isPlaceholderLocationText(value) {
  const text = String(value || "").trim().toLowerCase()
  return (
    !text ||
    text === "select location" ||
    text === "select" ||
    text === "current location" ||
    text === "unknown city" ||
    /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(text)
  )
}

export function setDeliveryAddressMode(mode) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(DELIVERY_ADDRESS_MODE_KEY, mode)
  window.dispatchEvent(new Event("deliveryAddressModeChanged"))
}

export function notifyUserLocationChanged(locationData = null) {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent("userLocationChanged", { detail: locationData || null }),
  )
}

export function persistUserLocation(locationData) {
  if (typeof window === "undefined" || !locationData) return
  const lat = Number(locationData.latitude)
  const lng = Number(locationData.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return

  try {
    window.localStorage.setItem(USER_LOCATION_KEY, JSON.stringify(locationData))
  } catch {
    // ignore quota / private mode errors
  }
}

export function readStoredUserLocation() {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(USER_LOCATION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function getSavedAddressCoords(address) {
  if (!address) return null

  // Same parser as delivery / cart fees — never assume [lng,lat] blindly.
  const point = parseGeoPoint(address)
  if (!point) return null

  return {
    latitude: point.lat,
    longitude: point.lng,
    coordinates: [point.lng, point.lat],
  }
}

export function formatSavedAddress(address) {
  if (!address) return ""

  if (address.formattedAddress && address.formattedAddress !== "Select location") {
    return address.formattedAddress
  }

  const parts = []
  if (address.additionalDetails) parts.push(address.additionalDetails)
  if (address.street) parts.push(address.street)
  if (address.city) parts.push(address.city)
  if (address.state) parts.push(address.state)
  if (address.zipCode) parts.push(address.zipCode)

  if (parts.length > 0) return parts.join(", ")
  if (address.address && address.address !== "Select location") return address.address

  return ""
}

export function buildEffectiveLocation({
  deliveryAddressMode,
  defaultSavedAddress,
  liveLocation,
}) {
  const savedCoords = getSavedAddressCoords(defaultSavedAddress)
  const useSavedAddress =
    deliveryAddressMode === "saved" &&
    Number.isFinite(savedCoords?.latitude) &&
    Number.isFinite(savedCoords?.longitude)

  if (useSavedAddress) {
    return {
      latitude: savedCoords.latitude,
      longitude: savedCoords.longitude,
      coordinates: savedCoords.coordinates,
      city: defaultSavedAddress?.city || liveLocation?.city || "",
      state: defaultSavedAddress?.state || liveLocation?.state || "",
      area: defaultSavedAddress?.additionalDetails || liveLocation?.area || "",
      address:
        defaultSavedAddress?.street && defaultSavedAddress?.city
          ? `${defaultSavedAddress.street}, ${defaultSavedAddress.city}`
          : liveLocation?.address || "",
      formattedAddress: formatSavedAddress(defaultSavedAddress) || liveLocation?.formattedAddress || "",
      label: defaultSavedAddress?.label || liveLocation?.label || "",
      // Keep raw address so distance helpers can match cart/order endpoints.
      deliveryAddress: defaultSavedAddress,
    }
  }

  return liveLocation
}

export function buildDisplayAddressText({
  deliveryAddressMode,
  savedAddressText,
  effectiveLocation,
  loading = false,
}) {
  if (deliveryAddressMode === "saved" && savedAddressText && !isPlaceholderLocationText(savedAddressText)) {
    return savedAddressText
  }

  if (!isPlaceholderLocationText(effectiveLocation?.formattedAddress)) {
    return effectiveLocation.formattedAddress
  }
  if (!isPlaceholderLocationText(effectiveLocation?.address)) {
    return effectiveLocation.address
  }

  const area = effectiveLocation?.area
  const city = effectiveLocation?.city
  if (!isPlaceholderLocationText(area) && !isPlaceholderLocationText(city) && area !== city) {
    return `${area}, ${city}`
  }
  if (!isPlaceholderLocationText(area)) return area
  if (!isPlaceholderLocationText(city)) return city

  const hasCoords =
    Number.isFinite(Number(effectiveLocation?.latitude)) &&
    Number.isFinite(Number(effectiveLocation?.longitude))

  if (loading) return "Detecting location..."
  if (hasCoords) {
    const lat = Number(effectiveLocation.latitude).toFixed(3)
    const lng = Number(effectiveLocation.longitude).toFixed(3)
    return `${lat}, ${lng}`
  }
  return "Select Location"
}
