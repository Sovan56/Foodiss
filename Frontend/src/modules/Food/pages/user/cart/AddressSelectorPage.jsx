import { useMemo, useState, useEffect, useRef, useCallback } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { ChevronLeft, ChevronRight, Plus, MapPin, MoreHorizontal, Navigation, Home, Building2, Briefcase, Phone, X, Crosshair, Search } from "lucide-react"
import { Button } from "@food/components/ui/button"
import { Input } from "@food/components/ui/input"
import { Label } from "@food/components/ui/label"
import { Textarea } from "@food/components/ui/textarea"
import { useDeliveryLocation } from "@food/context/DeliveryLocationContext"
import { useProfile } from "@food/context/ProfileContext"
import { toast } from "sonner"
import { locationAPI, userAPI } from "@food/api"
import { Loader } from '@googlemaps/js-api-loader'
import AnimatedPage from "@food/components/user/AnimatedPage"
import useAppBackNavigation from "@food/hooks/useAppBackNavigation"
import { isModuleAuthenticated } from "@food/utils/auth"
import {
  notifyUserLocationChanged,
  setDeliveryAddressMode,
} from "@food/utils/deliveryLocationUtils"

const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}

// Enable Maps if API Key is available, otherwise fallback to coordinates-only mode
const MAPS_ENABLED = !!import.meta.env.VITE_GOOGLE_MAPS_API_KEY

// Calculate distance between two coordinates using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3 // Earth's radius in meters
  const lat1Rad = lat1 * Math.PI / 180
  const lat2Rad = lat2 * Math.PI / 180
  const deltaLat = (lat2 - lat1) * Math.PI / 180
  const deltaLon = (lon2 - lon1) * Math.PI / 180

  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) *
    Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c // Distance in meters
}

// Get icon based on address type/label
const getAddressIcon = (address) => {
  const label = (address.label || address.additionalDetails || "").toLowerCase()
  if (label.includes("home")) return Home
  if (label.includes("work") || label.includes("office")) return Briefcase
  if (label.includes("building") || label.includes("apt")) return Building2
  return Home
}

export default function AddressSelectorPage() {
  const navigate = useNavigate()
  const routerLocation = useLocation()
  const goBack = useAppBackNavigation()
  const { liveLocation: location, loading, requestLiveLocation } = useDeliveryLocation()
  const { addresses = [], addAddress, updateAddress, setDefaultAddress, userProfile } = useProfile()
  const [showAddressForm, setShowAddressForm] = useState(false)
  const [mapPosition, setMapPosition] = useState([
    Number.isFinite(location?.latitude) ? location.latitude : 20.5937,
    Number.isFinite(location?.longitude) ? location.longitude : 78.9629,
  ])
  const [addressFormData, setAddressFormData] = useState({
    street: "",
    city: "",
    state: "",
    zipCode: "",
    additionalDetails: "",
    label: "Home",
    phone: "",
  })
  const [loadingAddress, setLoadingAddress] = useState(false)
  const [mapLoading, setMapLoading] = useState(false)
  const mapContainerRef = useRef(null)
  const googleMapRef = useRef(null) // Google Maps instance
  const greenMarkerRef = useRef(null) // Green marker for address selection
  const userLocationMarkerRef = useRef(null) // Blue dot marker for user location
  const blueDotCircleRef = useRef(null) // Accuracy circle for Google Maps
  const [currentAddress, setCurrentAddress] = useState("")
  const [addressAutocompleteValue, setAddressAutocompleteValue] = useState("")
  const [keywordAddressSuggestions, setKeywordAddressSuggestions] = useState([])
  const [googlePlacesSuggestions, setGooglePlacesSuggestions] = useState([])
  const [isKeywordSearching, setIsKeywordSearching] = useState(false)
  const [lockMapToAutocomplete, setLockMapToAutocomplete] = useState(true)
  const [GOOGLE_MAPS_API_KEY, setGOOGLE_MAPS_API_KEY] = useState(null)
  const [formScrollTop, setFormScrollTop] = useState(0)
  const [keyboardInset, setKeyboardInset] = useState(0)
  const [baseMapHeight, setBaseMapHeight] = useState(320)
  const formBodyRef = useRef(null)
  const manualFieldRefs = useRef({})
  const placesAutocompleteServiceRef = useRef(null)
  const placesDetailsServiceRef = useRef(null)
  const placesSessionTokenRef = useRef(null)
  const suppressSuggestionFetchRef = useRef(false)
  
  const ENABLE_LOCATION_REVERSE_GEOCODE = import.meta.env.VITE_ENABLE_LOCATION_REVERSE_GEOCODE !== "false"
  const ENABLE_NOMINATIM_SEARCH = import.meta.env.VITE_ENABLE_NOMINATIM_SEARCH !== "false"
  const getAddressId = (address) => address?.id || address?._id || null

  const handleBack = () => {
    goBack()
  }

  const addressAutocompleteSuggestions = useMemo(() => {
    const q = String(addressAutocompleteValue || "").trim().toLowerCase()
    if (!q) return []
    const list = Array.isArray(addresses) ? addresses : []
    return list
      .map((addr) => {
        const text = [
          addr?.label,
          addr?.additionalDetails,
          addr?.street,
          addr?.city,
          addr?.state,
          addr?.zipCode,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        return { addr, text }
      })
      .filter((x) => x.text.includes(q))
      .slice(0, 6)
      .map((x) => x.addr)
  }, [addresses, addressAutocompleteValue])

  // Load Google Maps API key
  useEffect(() => {
    if (!MAPS_ENABLED) return
    import('@food/utils/googleMapsApiKey.js').then(({ getGoogleMapsApiKey }) => {
      getGoogleMapsApiKey().then(key => {
        setGOOGLE_MAPS_API_KEY(key)
      })
    })
  }, [])

  const ensurePlacesServices = useCallback(async () => {
    if (!GOOGLE_MAPS_API_KEY) return false

    if (!window.google?.maps?.places) {
      const loader = new Loader({
        apiKey: GOOGLE_MAPS_API_KEY,
        version: "weekly",
        libraries: ["places"],
      })
      await loader.load()
    }

    if (!window.google?.maps?.places) return false

    if (!placesAutocompleteServiceRef.current) {
      placesAutocompleteServiceRef.current =
        new window.google.maps.places.AutocompleteService()
    }
    if (!placesDetailsServiceRef.current) {
      placesDetailsServiceRef.current = new window.google.maps.places.PlacesService(
        document.createElement("div"),
      )
    }
    if (
      !placesSessionTokenRef.current &&
      window.google.maps.places.AutocompleteSessionToken
    ) {
      placesSessionTokenRef.current =
        new window.google.maps.places.AutocompleteSessionToken()
    }

    return true
  }, [GOOGLE_MAPS_API_KEY])

  // Hybrid search: Google Places first, then an India-scoped Nominatim fallback.
  useEffect(() => {
    if (suppressSuggestionFetchRef.current) {
      suppressSuggestionFetchRef.current = false
      setIsKeywordSearching(false)
      return
    }

    const q = String(addressAutocompleteValue || "").replace(/\s+/g, " ").trim()
    if (q.length < 3) {
      setGooglePlacesSuggestions([])
      setKeywordAddressSuggestions([])
      setIsKeywordSearching(false)
      if (window.google?.maps?.places?.AutocompleteSessionToken) {
        placesSessionTokenRef.current =
          new window.google.maps.places.AutocompleteSessionToken()
      }
      return
    }

    setGooglePlacesSuggestions([])
    setKeywordAddressSuggestions([])
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        setIsKeywordSearching(true)

        const googleReady = await ensurePlacesServices().catch(() => false)
        if (
          googleReady &&
          placesAutocompleteServiceRef.current &&
          window.google?.maps?.places?.PlacesServiceStatus
        ) {
          const predictions = await new Promise((resolve) => {
            placesAutocompleteServiceRef.current.getPlacePredictions(
              {
                input: q,
                componentRestrictions: { country: "in" },
                sessionToken: placesSessionTokenRef.current || undefined,
              },
              (items, status) => {
                const ok =
                  status === window.google.maps.places.PlacesServiceStatus.OK
                resolve(ok && Array.isArray(items) ? items : [])
              },
            )
          })

          if (cancelled) return
          if (predictions.length > 0) {
            setGooglePlacesSuggestions(
              predictions.slice(0, 6).map((prediction) => ({
                id: prediction.place_id,
                placeId: prediction.place_id,
                display: prediction.description || "",
                mainText:
                  prediction.structured_formatting?.main_text ||
                  prediction.description ||
                  "",
                secondaryText:
                  prediction.structured_formatting?.secondary_text || "",
                source: "google",
              })),
            )
            setKeywordAddressSuggestions([])
            return
          }
        }

        setGooglePlacesSuggestions([])
        if (!ENABLE_NOMINATIM_SEARCH) {
          setKeywordAddressSuggestions([])
          return
        }

        const refLat = location?.latitude ?? 22.7196
        const refLng = location?.longitude ?? 75.8577
        const url =
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6` +
          `&countrycodes=in&q=${encodeURIComponent(q)}`
        const response = await fetch(url, { headers: { Accept: "application/json" } })
        const json = await response.json()
        if (cancelled) return

        const suggestions = (Array.isArray(json) ? json : [])
          .map((result) => ({
            id: `n-${result.place_id || result.osm_id}`,
            display: result.display_name || "",
            lat: Number(result.lat),
            lng: Number(result.lon),
            address: result.address || {},
            source: "nominatim",
          }))
          .filter(
            (result) => Number.isFinite(result.lat) && Number.isFinite(result.lng),
          )
          .map((result) => ({
            ...result,
            distanceMeters: calculateDistance(
              refLat,
              refLng,
              result.lat,
              result.lng,
            ),
          }))
          .sort(
            (a, b) =>
              (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity),
          )
          .slice(0, 6)

        setKeywordAddressSuggestions(suggestions)
      } catch (e) {
        debugError("Google Places error:", e);
        if (!cancelled) {
          setGooglePlacesSuggestions([])
          setKeywordAddressSuggestions([])
        }
      } finally {
        if (!cancelled) setIsKeywordSearching(false)
      }
    }, 400)

    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [
    addressAutocompleteValue,
    showAddressForm,
    location?.latitude,
    location?.longitude,
    ENABLE_NOMINATIM_SEARCH,
    ensurePlacesServices,
  ])

  // Keep map anchored to resolved live location when available (avoids default-city bias on first open).
  useEffect(() => {
    if (Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude)) {
      setMapPosition([location.latitude, location.longitude])
    }
  }, [location?.latitude, location?.longitude])

  // Map Initialization logic
  useEffect(() => {
    if (!MAPS_ENABLED || !showAddressForm || !mapContainerRef.current || !GOOGLE_MAPS_API_KEY) return

    let isMounted = true
    setMapLoading(true)

    const initializeGoogleMap = async () => {
      try {
        const loader = new Loader({
          apiKey: GOOGLE_MAPS_API_KEY,
          version: "weekly",
          libraries: ["places"],
        })
        const google = await loader.load()
        if (!isMounted || !mapContainerRef.current) return

        const initialPos = { lat: mapPosition[0], lng: mapPosition[1] }
        
        const map = new google.maps.Map(mapContainerRef.current, {
          center: initialPos,
          zoom: 16,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "greedy",
          styles: [
            { featureType: "poi", stylers: [{ visibility: "off" }] },
            { featureType: "transit", stylers: [{ visibility: "off" }] }
          ]
        })
        googleMapRef.current = map

        // Update coordinates on map idle (center of the map is the chosen location)
        map.addListener("idle", () => {
          const center = map.getCenter()
          const lat = center.lat()
          const lng = center.lng()
          setMapPosition([lat, lng])
          handleMapMoveEnd(lat, lng)
        })

        setMapLoading(false)
      } catch (err) {
        debugError("Map init error:", err)
        setMapLoading(false)
      }
    }
    initializeGoogleMap()
    return () => { isMounted = false }
  }, [showAddressForm, GOOGLE_MAPS_API_KEY])

  const handleUseCurrentLocation = async () => {
    try {
      toast.loading("Getting location...", { id: "geo" })
      const loc = await requestLiveLocation()
      if (loc?.latitude) {
        const newPos = [loc.latitude, loc.longitude]
        setMapPosition(newPos)
        
        // Use Google Reverse Geocoding if available for better accuracy
        if (window.google && window.google.maps) {
          const geocoder = new window.google.maps.Geocoder();
          geocoder.geocode({ location: { lat: loc.latitude, lng: loc.longitude } }, (results, status) => {
            if (status === "OK" && results[0]) {
              const res = results[0];
              setCurrentAddress(res.formatted_address);
              
              // Extract address components
              let street = "", city = "", state = "", postcode = "";
              res.address_components.forEach(comp => {
                const types = comp.types;
                if (types.includes("route") || types.includes("sublocality")) {
                  street = street ? `${street}, ${comp.long_name}` : comp.long_name;
                } else if (types.includes("locality")) {
                  city = comp.long_name;
                } else if (types.includes("administrative_area_level_1")) {
                  state = comp.long_name;
                } else if (types.includes("postal_code")) {
                  postcode = comp.long_name;
                }
              });

              setAddressFormData(prev => ({
                ...prev,
                street: street || res.formatted_address.split(",")[0] || prev.street,
                city: city || prev.city,
                state: state || prev.state,
                zipCode: postcode || prev.zipCode,
              }));
            }
          });
        }

        // Explicitly pan the map to center the user location
        if (googleMapRef.current) {
          googleMapRef.current.panTo({ lat: loc.latitude, lng: loc.longitude })
          googleMapRef.current.setZoom(17)
        }
        
        try {
          setDeliveryAddressMode("current")
        } catch {}
        toast.success("Location updated", { id: "geo" })
        if (!showAddressForm) {
          handleBack()
        }
      }
    } catch (e) {
      toast.error("Failed to get location", { id: "geo" })
    }
  }

  const selectSearchPlaceRoot = async (suggestion) => {
    if (!suggestion) return
    try {
      let lat = suggestion.lat
      let lng = suggestion.lng
      let formattedAddress = suggestion.display || suggestion.mainText || ""
      let city = suggestion.address?.city || ""
      let state = suggestion.address?.state || ""

      if (suggestion.source === "google" && suggestion.placeId) {
        const ready = await ensurePlacesServices().catch(() => false)
        if (ready && placesDetailsServiceRef.current) {
          const place = await new Promise((resolve, reject) => {
            placesDetailsServiceRef.current.getDetails(
              {
                placeId: suggestion.placeId,
                fields: ["formatted_address", "address_components", "geometry"],
              },
              (result, status) => {
                if (status === window.google?.maps?.places?.PlacesServiceStatus?.OK && result) {
                  resolve(result)
                } else {
                  reject(new Error(String(status || "Place details failed")))
                }
              }
            )
          })
          lat = place?.geometry?.location?.lat?.()
          lng = place?.geometry?.location?.lng?.()
          formattedAddress = place?.formatted_address || formattedAddress
          const comps = place?.address_components || []
          city = comps.find((c) => c.types?.includes("locality"))?.long_name || ""
          state = comps.find((c) => c.types?.includes("administrative_area_level_1"))?.long_name || ""
        }
      }

      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const locationData = {
          latitude: lat,
          longitude: lng,
          address: formattedAddress,
          city,
          state,
          formattedAddress,
        }
        localStorage.setItem("userLocation", JSON.stringify(locationData))
        notifyUserLocationChanged(locationData)
        try {
          setDeliveryAddressMode("current")
        } catch {}
        setGooglePlacesSuggestions([])
        setKeywordAddressSuggestions([])
        setAddressAutocompleteValue("")
        toast.success("Location updated")
        handleBack()
      }
    } catch (err) {
      debugError("Select search place error:", err)
      toast.error("Could not select this location")
    }
  }

  const handleSelectSavedAddress = async (address) => {
    const id = getAddressId(address)
    if (id) {
      await setDefaultAddress(id)
      try {
        const coords = address?.location?.coordinates
        const lng =
          Array.isArray(coords) && coords.length >= 2
            ? Number(coords[0])
            : Number(address?.longitude || address?.lng)
        const lat =
          Array.isArray(coords) && coords.length >= 2
            ? Number(coords[1])
            : Number(address?.latitude || address?.lat)

        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const locationData = {
            latitude: lat,
            longitude: lng,
            address: address?.street || address?.address || "",
            city: address?.city || "",
            state: address?.state || "",
            area: address?.additionalDetails || "",
            formattedAddress:
              address?.formattedAddress ||
              [
                address?.additionalDetails,
                address?.street,
                address?.city,
                address?.state,
                address?.zipCode,
              ]
                .filter(Boolean)
                .join(", "),
          }
          localStorage.setItem("userLocation", JSON.stringify(locationData))
          notifyUserLocationChanged(locationData)
        }

        setDeliveryAddressMode("saved")
      } catch {}
      toast.success("Address selected")
      handleBack()
    }
  }

  const handleAddAddressClick = () => {
    if (!isModuleAuthenticated("user")) {
      navigate("/food/user/auth/login", { state: { from: routerLocation.pathname } })
      return
    }
    setShowAddressForm(true)
  }

  const handleCancelAddressForm = () => {
    setShowAddressForm(false)
  }

  const scrollFieldIntoView = useCallback((fieldName) => {
    const el = manualFieldRefs.current?.[fieldName]
    if (!el) return
    setTimeout(() => {
      try {
        const scrollHost = formBodyRef.current
        if (!scrollHost) {
          el.scrollIntoView({ behavior: "smooth", block: "center" })
          return
        }
        const hostRect = scrollHost.getBoundingClientRect()
        const elRect = el.getBoundingClientRect()
        const viewportHeight =
          typeof window !== "undefined" && window.visualViewport
            ? window.visualViewport.height
            : window.innerHeight
        const safeBottom = viewportHeight - keyboardInset - 90
        const overBy = elRect.bottom - safeBottom
        if (overBy > 0) {
          scrollHost.scrollTo({
            top: scrollHost.scrollTop + overBy + 24,
            behavior: "smooth",
          })
          return
        }
        if (elRect.top < hostRect.top + 70) {
          const upBy = hostRect.top + 70 - elRect.top
          scrollHost.scrollTo({
            top: Math.max(0, scrollHost.scrollTop - upBy - 12),
            behavior: "smooth",
          })
          return
        }
        el.scrollIntoView({ behavior: "smooth", block: "center" })
      } catch {
        // Ignore scrolling errors.
      }
    }, 120)
  }, [keyboardInset])

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  const handleMapMoveEnd = async (lat, lng) => {
    if (!ENABLE_LOCATION_REVERSE_GEOCODE) return
    try {
      // Use Nominatim for free reverse geocoding on the client side
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`
      const response = await fetch(url, { 
        headers: { 
          "Accept-Language": "en",
          "User-Agent": "Foodiss-Food-App" 
        } 
      })
      const json = await response.json()
      
      if (json && json.address) {
        const addr = json.address
        const formatted = json.display_name
        
        // Extract meaningful street/area info
        const street = [
          addr.road,
          addr.suburb,
          addr.neighbourhood,
          addr.house_number
        ].filter(Boolean).slice(0, 2).join(", ") || addr.amenity || addr.industrial || ""

        const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || ""
        const state = addr.state || ""
        const postcode = addr.postcode || ""

        setCurrentAddress(formatted)
        setAddressFormData(prev => ({
          ...prev,
          street: street || formatted.split(",")[0] || prev.street,
          city: city || prev.city,
          state: state || prev.state,
          zipCode: postcode || prev.zipCode,
        }))
      }
    } catch (e) {
      debugError("Reverse geocode error:", e)
    }
  }

  const selectGooglePlace = async (suggestion) => {
    if (!suggestion?.placeId) return

    try {
      const ready = await ensurePlacesServices()
      if (!ready || !placesDetailsServiceRef.current) {
        throw new Error("Google Places is unavailable")
      }

      const place = await new Promise((resolve, reject) => {
        placesDetailsServiceRef.current.getDetails(
          {
            placeId: suggestion.placeId,
            fields: ["formatted_address", "address_components", "geometry"],
            sessionToken: placesSessionTokenRef.current || undefined,
          },
          (result, status) => {
            if (
              status === window.google.maps.places.PlacesServiceStatus.OK &&
              result
            ) {
              resolve(result)
              return
            }
            reject(new Error(String(status || "Failed to fetch place details")))
          },
        )
      })

      const lat = place?.geometry?.location?.lat?.()
      const lng = place?.geometry?.location?.lng?.()
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error("Selected place has no coordinates")
      }

      const components = Array.isArray(place.address_components)
        ? place.address_components
        : []
      const getComponent = (types) =>
        components.find((component) =>
          types.some((type) => component.types?.includes(type)),
        )?.long_name || ""
      const streetParts = [
        getComponent(["street_number"]),
        getComponent(["premise"]),
        getComponent(["route"]),
        getComponent(["sublocality_level_1", "sublocality", "neighborhood"]),
      ].filter(Boolean)
      const formattedAddress =
        place.formatted_address || suggestion.display || streetParts.join(", ")
      const city =
        getComponent(["locality"]) ||
        getComponent(["administrative_area_level_2"])
      const state = getComponent(["administrative_area_level_1"])
      const zipCode = getComponent(["postal_code"])

      setMapPosition([lat, lng])
      googleMapRef.current?.panTo({ lat, lng })
      googleMapRef.current?.setZoom(17)
      suppressSuggestionFetchRef.current = true
      setAddressAutocompleteValue(formattedAddress)
      setCurrentAddress(formattedAddress)
      setAddressFormData((prev) => ({
        ...prev,
        street:
          streetParts.join(", ") ||
          suggestion.mainText ||
          formattedAddress ||
          prev.street,
        city: city || prev.city,
        state: state || prev.state,
        zipCode: zipCode || prev.zipCode,
      }))
      setGooglePlacesSuggestions([])
      setKeywordAddressSuggestions([])

      if (window.google?.maps?.places?.AutocompleteSessionToken) {
        placesSessionTokenRef.current =
          new window.google.maps.places.AutocompleteSessionToken()
      }
    } catch (error) {
      debugError("Google place details error:", error)
      toast.error("Unable to select this location. Please try another result.")
    }
  }

  const selectFallbackPlace = (suggestion) => {
    const { lat, lng, display, address = {} } = suggestion || {}
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return

    const street = [
      address.house_number,
      address.road,
      address.suburb || address.neighbourhood || address.city_district,
    ]
      .filter(Boolean)
      .join(", ")
    const city =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.county ||
      ""

    setMapPosition([lat, lng])
    googleMapRef.current?.panTo({ lat, lng })
    googleMapRef.current?.setZoom(17)
    suppressSuggestionFetchRef.current = true
    setAddressAutocompleteValue(display || "")
    setCurrentAddress(display || "")
    setAddressFormData((prev) => ({
      ...prev,
      street: street || display || prev.street,
      city: city || prev.city,
      state: address.state || prev.state,
      zipCode: address.postcode || prev.zipCode,
    }))
    setGooglePlacesSuggestions([])
    setKeywordAddressSuggestions([])
  }

  const handleAddressFormSubmit = async (e) => {
    e.preventDefault()
    if (!addressFormData.street || !addressFormData.city) {
      toast.error("Please fill required fields")
      return
    }
    setLoadingAddress(true)
    try {
      const payload = {
        ...addressFormData,
        label: addressFormData.label === "Work" ? "Office" : addressFormData.label,
        location: { type: "Point", coordinates: [mapPosition[1], mapPosition[0]] },
        latitude: mapPosition[0],
        longitude: mapPosition[1]
      }
      const created = await addAddress(payload)
      if (created) {
        const id = getAddressId(created)
        if (id) await setDefaultAddress(id)
        try {
          setDeliveryAddressMode("saved")
        } catch {}
        toast.success("Address saved")
        handleBack()
      }
    } catch (error) {
      toast.error("Failed to save address")
    } finally {
      setLoadingAddress(false)
    }
  }

  useEffect(() => {
    if (!showAddressForm) return
    const updateBaseMapHeight = () => {
      const vh = typeof window !== "undefined" ? window.innerHeight : 800
      const target = Math.round(vh * 0.45)
      setBaseMapHeight(Math.max(260, Math.min(420, target)))
    }
    updateBaseMapHeight()
    window.addEventListener("resize", updateBaseMapHeight)
    return () => window.removeEventListener("resize", updateBaseMapHeight)
  }, [showAddressForm])

  useEffect(() => {
    if (!showAddressForm) return
    setFormScrollTop(0)
  }, [showAddressForm])

  useEffect(() => {
    if (!showAddressForm || typeof window === "undefined" || !window.visualViewport) return
    const viewport = window.visualViewport
    const updateKeyboardInset = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      setKeyboardInset(inset > 0 ? inset : 0)
    }
    updateKeyboardInset()
    viewport.addEventListener("resize", updateKeyboardInset)
    viewport.addEventListener("scroll", updateKeyboardInset)
    return () => {
      viewport.removeEventListener("resize", updateKeyboardInset)
      viewport.removeEventListener("scroll", updateKeyboardInset)
    }
  }, [showAddressForm])

  if (showAddressForm) {
    const mapHeight = baseMapHeight 
    return (
      <AnimatedPage
        className="fixed inset-0 z-50 bg-white dark:bg-[#0a0a0a] flex flex-col h-screen overflow-hidden"
      >
        <div className="flex-shrink-0 bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800 px-4 py-3 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={handleCancelAddressForm} className="rounded-full">
            <ChevronLeft className="h-6 w-6" />
          </Button>
          <h1 className="text-lg font-bold">Add delivery location</h1>
        </div>

        <div
          ref={formBodyRef}
          onScroll={(e) => {
            setFormScrollTop(e.currentTarget.scrollTop)
          }}
          className="flex-1 overflow-y-auto"
          style={{ paddingBottom: `${96 + keyboardInset}px` }}
        >
          {/* Map Section - Parallax enabled */}
          <div
            className="flex-shrink-0 relative z-0"
            style={{ 
              height: `${mapHeight}px`,
              transform: `translateY(${formScrollTop * 0.4}px)`,
              opacity: clamp(1 - (formScrollTop / 500), 0.4, 1)
            }}
          >
            <div className="absolute top-4 left-4 right-4 z-20">
              <div className="relative group shadow-2xl">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-gray-400" />
                </div>
                <Input
                  value={addressAutocompleteValue}
                  onChange={(e) => setAddressAutocompleteValue(e.target.value)}
                  placeholder="Search area, street, landmark..."
                  className="pl-10 h-12 bg-white/95 dark:bg-[#1a1a1a]/95 backdrop-blur-md border-none rounded-xl shadow-lg focus:ring-2 focus:ring-[#EB590E] transition-all"
                />
                {isKeywordSearching && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                     <div className="animate-spin rounded-full h-4 w-4 border-2 border-[#EB590E] border-t-transparent" />
                  </div>
                )}

                {googlePlacesSuggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-[#1a1a1a] rounded-xl shadow-2xl border border-gray-100 dark:border-gray-800 overflow-hidden z-30 animate-in fade-in slide-in-from-top-2 duration-200">
                    <p className="px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-400 bg-gray-50 dark:bg-gray-800/50">Google Suggestions</p>
                    {googlePlacesSuggestions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => void selectGooglePlace(s)}
                        className="w-full px-4 py-3 flex items-start gap-3 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-colors text-left border-b border-gray-50 dark:border-gray-800 last:border-none"
                      >
                        <MapPin className="h-4 w-4 text-gray-400 mt-1 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{s.mainText}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.secondaryText}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {keywordAddressSuggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-[#1a1a1a] rounded-xl shadow-2xl border border-gray-100 dark:border-gray-800 overflow-hidden z-30 animate-in fade-in slide-in-from-top-2 duration-200">
                    <p className="px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-400 bg-gray-50 dark:bg-gray-800/50">Suggestions</p>
                    {keywordAddressSuggestions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => selectFallbackPlace(s)}
                        className="w-full px-4 py-3 flex items-start gap-3 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-colors text-left border-b border-gray-50 dark:border-gray-800 last:border-none"
                      >
                        <MapPin className="h-4 w-4 text-gray-400 mt-1 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{s.display}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.address?.city || s.address?.state}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div ref={mapContainerRef} className="w-full h-full bg-gray-100 dark:bg-gray-800" />
            
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
               <div className="relative mb-8 flex flex-col items-center">
                  <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center p-2 mb-[-6px] shadow-sm animate-bounce-short">
                     <div className="w-6 h-6 rounded-full bg-green-600 flex items-center justify-center border-2 border-white">
                        <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                     </div>
                  </div>
                  <div className="w-1.5 h-6 bg-green-600 border-x border-white shadow-xl rounded-b-full shadow-green-900/40" />
                  <div className="w-3 h-1.5 bg-black/20 rounded-full blur-[1px] transform scale-x-150 absolute bottom-[-4px]" />
               </div>
            </div>

            {mapLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-sm z-10">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#EB590E]" />
              </div>
            )}
            
            <div className="absolute bottom-10 right-4 z-10">
              <Button 
                  onClick={handleUseCurrentLocation} 
                  className="bg-white text-black hover:bg-gray-100 shadow-xl border border-gray-200 rounded-full h-12 px-6"
              >
                <Navigation className="h-4 w-4 mr-2 text-[#EB590E]" /> Use My Location
              </Button>
            </div>
          </div>

          <div className="relative bg-white dark:bg-[#0a0a0a] rounded-t-[32px] -mt-8 z-10 p-4 space-y-6 shadow-[0_-12px_24px_-10px_rgba(0,0,0,0.1)]">
            <div className="bg-orange-50/50 dark:bg-orange-900/10 border border-orange-100 dark:border-orange-900/20 rounded-xl p-4 flex gap-3">
               <MapPin className="h-5 w-5 text-[#EB590E] mt-0.5" />
               <div className="min-w-0">
                  <p className="text-xs font-bold text-orange-800 dark:text-orange-200 uppercase mb-1">Pinnned Location</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 line-clamp-2">{currentAddress || "Select a location on map"}</p>
               </div>
            </div>

            <div>
              <Label className="text-sm font-bold mb-2 block">Primary Address (Street / Area / Landmark)</Label>
              <Input 
                placeholder="Search or drag to update street/area" 
                value={addressFormData.street} 
                onChange={e => setAddressFormData({...addressFormData, street: e.target.value})}
                onFocus={() => scrollFieldIntoView("street")}
                ref={(el) => { manualFieldRefs.current.street = el }}
                className="mb-4 h-12 rounded-xl bg-gray-50 dark:bg-gray-800/50"
                required
              />

              <Label className="text-sm font-bold mb-2 block text-orange-600 dark:text-orange-400">Secondary Address (House No. / Flat / Floor)</Label>
              <Input 
                placeholder="E.g. Flat 402, 4th Floor, Foodiss Building" 
                value={addressFormData.additionalDetails} 
                onChange={e => setAddressFormData({...addressFormData, additionalDetails: e.target.value})}
                onFocus={() => scrollFieldIntoView("additionalDetails")}
                ref={(el) => { manualFieldRefs.current.additionalDetails = el }}
                className="h-12 rounded-xl border-orange-200 dark:border-orange-900/40 focus:ring-orange-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs mb-1 block">City</Label>
                <Input 
                  value={addressFormData.city} 
                  onChange={e => setAddressFormData({...addressFormData, city: e.target.value})} 
                  onFocus={() => scrollFieldIntoView("city")}
                  ref={(el) => { manualFieldRefs.current.city = el }}
                  className="h-12 rounded-xl"
                  required 
                />
              </div>
              <div>
                <Label className="text-xs mb-1 block">State</Label>
                <Input 
                  value={addressFormData.state} 
                  onChange={e => setAddressFormData({...addressFormData, state: e.target.value})} 
                  onFocus={() => scrollFieldIntoView("state")}
                  ref={(el) => { manualFieldRefs.current.state = el }}
                  className="h-12 rounded-xl"
                  required 
                />
              </div>
            </div>

            <div>
              <Label className="text-xs mb-1 block">Pincode / ZIP</Label>
              <Input 
                placeholder="Pincode" 
                value={addressFormData.zipCode || ""} 
                onChange={e => setAddressFormData({...addressFormData, zipCode: e.target.value})} 
                onFocus={() => scrollFieldIntoView("zipCode")}
                ref={(el) => { manualFieldRefs.current.zipCode = el }}
                className="h-12 rounded-xl"
              />
            </div>

            <div>
               <Label className="text-sm font-bold mb-2 block">Save address as</Label>
               <div className="flex gap-2">
                 {["Home", "Work", "Other"].map(l => (
                   <Button 
                     key={l}
                     variant={addressFormData.label === l ? "default" : "outline"}
                     onClick={() => setAddressFormData({...addressFormData, label: l})}
                     className="flex-1"
                     style={addressFormData.label === l ? {backgroundColor: '#EB590E', color: 'white'} : {}}
                   >
                     {l}
                   </Button>
                 ))}
               </div>
            </div>
          </div>
        </div>

        <div
          className="fixed left-0 right-0 p-4 bg-white dark:bg-[#1a1a1a] border-t dark:border-gray-800 transition-[bottom] duration-150"
          style={{ bottom: `${keyboardInset}px` }}
        >
          <Button 
            className="w-full h-12 text-white font-bold text-lg" 
            style={{backgroundColor: '#EB590E'}}
            onClick={handleAddressFormSubmit}
            disabled={loadingAddress}
          >
            {loadingAddress ? "Saving..." : "Save Address \u0026 Proceed"}
          </Button>
        </div>
      </AnimatedPage>
    )
  }

  return (
    <AnimatedPage className="min-h-screen bg-white dark:bg-[#0a0a0a] flex flex-col">
      <div className="flex-shrink-0 bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800 px-4 py-4 flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={handleBack} className="rounded-full">
          <ChevronLeft className="h-6 w-6" />
        </Button>
        <h1 className="text-xl font-bold">Select Location</h1>
      </div>

      <div className="flex-1 overflow-y-auto pb-10">
        {/* Search Bar on Root View */}
        <div className="px-4 py-3 bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-gray-400" />
            </div>
            <Input
              value={addressAutocompleteValue}
              onChange={(e) => setAddressAutocompleteValue(e.target.value)}
              placeholder="Search area, landmark or street..."
              className="pl-9 h-11 bg-gray-100 dark:bg-gray-800/80 border-none rounded-xl text-sm focus:ring-2 focus:ring-[#EB590E]"
            />
            {isKeywordSearching && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-[#EB590E] border-t-transparent" />
              </div>
            )}
          </div>

          {/* Root Search Suggestions */}
          {(googlePlacesSuggestions.length > 0 || keywordAddressSuggestions.length > 0) && (
            <div className="mt-2 bg-white dark:bg-[#1a1a1a] rounded-xl shadow-xl border border-gray-100 dark:border-gray-800 overflow-hidden z-30 divide-y dark:divide-gray-800">
              {googlePlacesSuggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => void selectSearchPlaceRoot(s)}
                  className="w-full px-3 py-2.5 flex items-start gap-2.5 hover:bg-orange-50 dark:hover:bg-orange-900/10 text-left transition-colors"
                >
                  <MapPin className="h-4 w-4 text-[#EB590E] mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{s.mainText}</p>
                    <p className="text-xs text-gray-500 truncate">{s.secondaryText}</p>
                  </div>
                </button>
              ))}
              {keywordAddressSuggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => void selectSearchPlaceRoot(s)}
                  className="w-full px-3 py-2.5 flex items-start gap-2.5 hover:bg-orange-50 dark:hover:bg-orange-900/10 text-left transition-colors"
                >
                  <MapPin className="h-4 w-4 text-[#EB590E] mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{s.display}</p>
                    <p className="text-xs text-gray-500 truncate">{s.address?.city || s.address?.state}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 bg-gray-50 dark:bg-gray-900 border-b dark:border-gray-800">
          <button 
            onClick={handleUseCurrentLocation}
            className="w-full flex items-center gap-4 p-4 bg-white dark:bg-[#1a1a1a] rounded-xl shadow-sm hover:shadow-md transition-all group"
          >
            <div className="h-10 w-10 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
              <Navigation className="h-5 w-5 text-[#EB590E]" />
            </div>
            <div className="text-left flex-1">
              <p className="font-bold text-[#EB590E]">Use Current Location</p>
              <p className="text-xs text-gray-500 line-clamp-1">{currentAddress || "Enable GPS for accuracy"}</p>
            </div>
            <ChevronRight className="h-5 w-5 text-gray-400" />
          </button>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500">Saved Addresses</h2>
            <Button variant="ghost" className="text-[#EB590E] p-0 h-auto font-bold" onClick={handleAddAddressClick}>
              <Plus className="h-4 w-4 mr-1" /> Add New
            </Button>
          </div>

          <div className="space-y-4">
            {addresses.length === 0 ? (
              <div className="text-center py-10 opacity-50">
                <MapPin className="h-12 w-12 mx-auto mb-2 text-gray-400" />
                <p>No addresses saved yet</p>
              </div>
            ) : (
              addresses.map((addr, idx) => {
                const Icon = getAddressIcon(addr)
                return (
                  <button
                    key={getAddressId(addr) || idx}
                    onClick={() => handleSelectSavedAddress(addr)}
                    className="w-full flex items-start gap-4 p-4 bg-slate-50 dark:bg-[#1a1a1a] rounded-xl hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-colors text-left group"
                  >
                    <div className="h-10 w-10 rounded-full bg-white dark:bg-gray-800 flex items-center justify-center shadow-sm">
                      <Icon className="h-5 w-5 text-gray-600 dark:text-gray-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-gray-900 dark:text-white capitalize">{addr.label || "Address"}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mt-0.5">
                        {[addr.additionalDetails, addr.street, addr.city, addr.state].filter(Boolean).join(", ")}
                      </p>
                    </div>
                    <div className="h-6 w-6 rounded-full border border-gray-200 dark:border-gray-700 mt-2 flex items-center justify-center group-hover:border-[#EB590E]">
                       <ChevronRight className="h-3 w-3 text-gray-400 group-hover:text-[#EB590E]" />
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>
      <style>{`
        @keyframes bounce-short {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        .animate-bounce-short {
          animation: bounce-short 1s infinite ease-in-out;
        }
      `}</style>
    </AnimatedPage>
  )
}
