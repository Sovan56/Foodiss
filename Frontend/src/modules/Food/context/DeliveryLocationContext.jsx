import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import { useLocation } from "@food/hooks/useLocation"
import { useZone } from "@food/hooks/useZone"
import { useProfile } from "@food/context/ProfileContext"
import {
  buildDisplayAddressText,
  buildEffectiveLocation,
  formatSavedAddress,
  getDeliveryAddressMode,
  notifyUserLocationChanged,
  setDeliveryAddressMode as persistDeliveryAddressMode,
} from "@food/utils/deliveryLocationUtils"

const defaultDeliveryLocationContext = {
  liveLocation: null,
  effectiveLocation: null,
  deliveryAddressMode: "current",
  displayAddressText: "Detecting location...",
  savedAddressText: "",
  defaultSavedAddress: null,
  loading: true,
  requestLocation: async () => null,
  requestLiveLocation: async () => null,
  zoneId: null,
  zone: null,
  zoneStatus: null,
  isInService: false,
  isOutOfService: false,
  zoneLoading: true,
  zoneError: null,
  refreshZone: () => {},
}

const DeliveryLocationContext = createContext(defaultDeliveryLocationContext)

export function DeliveryLocationProvider({ children }) {
  const { getDefaultAddress } = useProfile()
  const { location: liveLocation, loading, requestLocation } = useLocation()
  const [deliveryAddressMode, setDeliveryAddressMode] = useState(getDeliveryAddressMode)
  const [addressRevision, setAddressRevision] = useState(0)

  useEffect(() => {
    // Only set to current if no mode was previously saved
    if (typeof window !== "undefined" && !window.localStorage.getItem("deliveryAddressMode")) {
      persistDeliveryAddressMode("current")
    }
  }, [])

  useEffect(() => {
    const syncMode = () => setDeliveryAddressMode(getDeliveryAddressMode())
    const syncAddress = () => setAddressRevision((value) => value + 1)

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        syncMode()
        syncAddress()
      }
    }

    window.addEventListener("deliveryAddressModeChanged", syncMode)
    window.addEventListener("userLocationChanged", syncAddress)
    window.addEventListener("focus", syncMode)
    window.addEventListener("storage", syncMode)
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      window.removeEventListener("deliveryAddressModeChanged", syncMode)
      window.removeEventListener("userLocationChanged", syncAddress)
      window.removeEventListener("focus", syncMode)
      window.removeEventListener("storage", syncMode)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  const defaultSavedAddress = useMemo(() => {
    void addressRevision
    return getDefaultAddress?.() || null
  }, [getDefaultAddress, addressRevision])

  const savedAddressText = useMemo(
    () => formatSavedAddress(defaultSavedAddress),
    [defaultSavedAddress],
  )

  const effectiveLocation = useMemo(
    () =>
      buildEffectiveLocation({
        deliveryAddressMode,
        defaultSavedAddress,
        liveLocation,
      }),
    [deliveryAddressMode, defaultSavedAddress, liveLocation],
  )

  const displayAddressText = useMemo(
    () =>
      buildDisplayAddressText({
        deliveryAddressMode,
        savedAddressText,
        effectiveLocation,
        loading,
      }),
    [deliveryAddressMode, savedAddressText, effectiveLocation, loading],
  )

  const {
    zoneId,
    zone,
    zoneStatus,
    isInService,
    isOutOfService,
    loading: zoneLoading,
    error: zoneError,
    refreshZone,
  } = useZone(effectiveLocation)

  useEffect(() => {
    if (
      !Number.isFinite(effectiveLocation?.latitude) ||
      !Number.isFinite(effectiveLocation?.longitude)
    ) {
      return
    }

    refreshZone()
  }, [
    deliveryAddressMode,
    effectiveLocation?.latitude,
    effectiveLocation?.longitude,
    refreshZone,
  ])

  const requestLiveLocation = useCallback(async () => {
    const loc = await requestLocation({ live: true })
    if (loc) {
      notifyUserLocationChanged(loc)
    }
    return loc
  }, [requestLocation])

  const value = useMemo(
    () => ({
      liveLocation,
      effectiveLocation,
      deliveryAddressMode,
      displayAddressText,
      savedAddressText,
      defaultSavedAddress,
      loading,
      requestLocation,
      requestLiveLocation,
      zoneId,
      zone,
      zoneStatus,
      isInService,
      isOutOfService,
      zoneLoading,
      zoneError,
      refreshZone,
    }),
    [
      liveLocation,
      effectiveLocation,
      deliveryAddressMode,
      displayAddressText,
      savedAddressText,
      defaultSavedAddress,
      loading,
      requestLocation,
      requestLiveLocation,
      zoneId,
      zone,
      zoneStatus,
      isInService,
      isOutOfService,
      zoneLoading,
      zoneError,
      refreshZone,
    ],
  )

  return (
    <DeliveryLocationContext.Provider value={value}>
      {children}
    </DeliveryLocationContext.Provider>
  )
}

export function useDeliveryLocation() {
  const context = useContext(DeliveryLocationContext)
  return context
}
