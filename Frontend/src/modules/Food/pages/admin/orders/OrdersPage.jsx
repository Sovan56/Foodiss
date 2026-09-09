import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import io from "socket.io-client"
import { FileText, Package } from "lucide-react"
import { adminAPI } from "@food/api"
import { API_BASE_URL } from "@food/api/config"
import { toast } from "sonner"
import OrdersTopbar from "@food/components/admin/orders/OrdersTopbar"
import OrdersTable from "@food/components/admin/orders/OrdersTable"
import FilterPanel from "@food/components/admin/orders/FilterPanel"
import ViewOrderDialog from "@food/components/admin/orders/ViewOrderDialog"
import SettingsDialog from "@food/components/admin/orders/SettingsDialog"
import RefundModal from "@food/components/admin/orders/RefundModal"
import { useOrdersManagement } from "@food/components/admin/orders/useOrdersManagement"
import { Loader2 } from "lucide-react"
import { OrdersDashboardSkeleton } from "@food/components/ui/loading-skeletons"
import { useDelayedLoading } from "@food/hooks/useDelayedLoading"
import alertSound from "@food/assets/audio/alert.mp3"
import originalSound from "@food/assets/audio/original.mp3"
const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}


// Status configuration with titles, colors, and icons
const statusConfig = {
  "all": { title: "All Orders", color: "emerald", icon: FileText },
  "pending": {
    title: "Pending Orders",
    subtitle: "Cash orders awaiting restaurant acceptance",
    color: "amber",
    icon: Package,
  },
  "processing": {
    title: "Processing Orders",
    subtitle: "Active orders awaiting delivery partner (includes payment-pending online orders)",
    color: "orange",
    icon: Package,
  },
  "food-on-the-way": {
    title: "Food On The Way Orders",
    subtitle: "Delivery partner accepted — not yet delivered",
    color: "amber",
    icon: Package,
  },
  "delivered": { title: "Delivered Orders", color: "emerald", icon: Package },
  "canceled": { title: "Canceled Orders", color: "rose", icon: Package },
  "restaurant-cancelled": { title: "Restaurant Cancelled Orders", color: "red", icon: Package },
  "payment-failed": { title: "Payment Failed Orders", color: "red", icon: Package },
  "refunded": { title: "Refunded Orders", color: "sky", icon: Package },
  "offline-payments": { title: "Offline Payments", color: "slate", icon: Package },
}

const PAGE_SIZE = 50

const EMPTY_ORDER_FILTERS = {
  paymentStatus: "",
  minAmount: "",
  maxAmount: "",
  fromDate: "",
  toDate: "",
  restaurantId: "",
}

export default function OrdersPage({ statusKey = "all" }) {
  const config = statusConfig[statusKey] || statusConfig["all"]
  const [orders, setOrders] = useState([])
  const [apiPage, setApiPage] = useState(1)
  const [totalOrdersCount, setTotalOrdersCount] = useState(0)
  const [apiTotalPages, setApiTotalPages] = useState(1)
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isTableLoading, setIsTableLoading] = useState(false)
  const hasLoadedOnceRef = useRef(false)
  const [processingRefund, setProcessingRefund] = useState(null)
  const [processingActionOrderId, setProcessingActionOrderId] = useState(null)
  const [deletingOrderId, setDeletingOrderId] = useState(null)
  const [refundModalOpen, setRefundModalOpen] = useState(false)
  const [selectedOrderForRefund, setSelectedOrderForRefund] = useState(null)
  const showLoadingSkeleton = useDelayedLoading(isInitialLoading, { delay: 120, minDuration: 360 })
  const seenOrderIdsRef = useRef(new Set())
  const isFirstLoadRef = useRef(true)
  const fallbackAudioRef = useRef(null)
  const notificationAudioRef = useRef(null)
  const audioContextRef = useRef(null)
  const audioUnlockedRef = useRef(false)
  const socketRef = useRef(null)
  const recentRealtimeOrderRef = useRef(new Map())
  const activeOrderAlertRef = useRef(null)
  const alertLoopTimerRef = useRef(null)
  const alertLoopStartedAtRef = useRef(0)
  const fetchAbortRef = useRef(null)
  const fetchInFlightRef = useRef(false)
  const lastFetchAtRef = useRef(0)
  const socketConnectedRef = useRef(false)
  const apiPageRef = useRef(apiPage)
  const statusKeyRef = useRef(statusKey)
  const searchQueryRef = useRef("")
  const appliedFiltersRef = useRef(EMPTY_ORDER_FILTERS)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("")
  const [draftFilters, setDraftFilters] = useState(EMPTY_ORDER_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_ORDER_FILTERS)
  const [restaurantOptions, setRestaurantOptions] = useState([])
  const ALERT_LOOP_INTERVAL_MS = 4500
  const ALERT_LOOP_MAX_MS = 120000
  const sanitizeNotificationText = useCallback((value) => {
    const raw = String(value || "")
    if (!raw) return ""
    const repaired = (() => {
      if (!/[ðÃÂâ]/.test(raw)) return raw
      try {
        const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff)
        return new TextDecoder("utf-8", { fatal: false }).decode(bytes) || raw
      } catch {
        return raw
      }
    })()
    return repaired
      .replace(/^\s*(?:[\uD800-\uDBFF][\uDC00-\uDFFF]\s*)*\[(user|shop|restaurant|delivery|admin)\]\s*/i, "")
      .replace(/[ÂÃâð][^\s]{0,3}/g, " ")
      .replace(/[^\x20-\x7E\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  }, [])

  const resolveAudioSource = useCallback((source, cacheKey = "admin-alert") => {
    if (!source) return source
    if (!import.meta.env.DEV) return source
    const separator = source.includes("?") ? "&" : "?"
    return `${source}${separator}devcache=${cacheKey}`
  }, [])

  const playDeliveryStyleBuzz = useCallback(async () => {
    const selectedSound = localStorage.getItem("delivery_alert_sound") || "zomato_tone"
    const soundFile = selectedSound === "original"
      ? resolveAudioSource(originalSound, "admin-original")
      : resolveAudioSource(alertSound, "admin-alert")

    try {
      if (!notificationAudioRef.current) {
        notificationAudioRef.current = new Audio(soundFile)
        notificationAudioRef.current.preload = "auto"
        notificationAudioRef.current.volume = 1
      } else if (!notificationAudioRef.current.src.includes(soundFile.split("/").pop())) {
        notificationAudioRef.current.pause()
        notificationAudioRef.current.src = soundFile
        notificationAudioRef.current.load()
      }

      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate([200, 100, 200, 100, 300])
      }

      notificationAudioRef.current.muted = false
      notificationAudioRef.current.volume = 1
      notificationAudioRef.current.currentTime = 0
      await notificationAudioRef.current.play()
      return true
    } catch (_) {
      return false
    }
  }, [resolveAudioSource])

  const playDefaultRing = useCallback(() => {
    playDeliveryStyleBuzz().then((played) => {
      if (played) return

      try {
        if (!fallbackAudioRef.current) {
          fallbackAudioRef.current = new Audio(alertSound)
          fallbackAudioRef.current.preload = "auto"
          fallbackAudioRef.current.volume = 1
        }

        fallbackAudioRef.current.muted = false
        fallbackAudioRef.current.volume = 1
        fallbackAudioRef.current.currentTime = 0
        fallbackAudioRef.current.play().catch(() => {})
      } catch (_) {}

      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (AudioCtx) {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioCtx()
        }
        const ctx = audioContextRef.current
        const playWithContext = async () => {
          if (ctx.state === "suspended") {
            await ctx.resume()
          }

          const beep = (startAt, frequency = 880, duration = 0.2) => {
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.type = "sine"
            osc.frequency.value = frequency
            gain.gain.value = 0.0001
            osc.connect(gain)
            gain.connect(ctx.destination)

            const start = ctx.currentTime + startAt
            osc.start(start)
            gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
            osc.stop(start + duration + 0.02)
          }

          beep(0, 880, 0.2)
          beep(0.26, 880, 0.2)
          beep(0.52, 988, 0.26)

          setTimeout(() => {
            if (ctx.state === "running") {
              ctx.suspend().catch(() => {})
            }
          }, 1200)
        }
        playWithContext().catch(async () => {
          if (fallbackAudioRef.current) {
            fallbackAudioRef.current.currentTime = 0
            await fallbackAudioRef.current.play()
          }
        })
        return
      }
    }).catch((error) => {
      debugWarn("Ring sound could not be played:", error)
    })
  }, [playDeliveryStyleBuzz])

  const stopAlertLoop = useCallback(() => {
    if (alertLoopTimerRef.current) {
      clearInterval(alertLoopTimerRef.current)
      alertLoopTimerRef.current = null
    }
    alertLoopStartedAtRef.current = 0
  }, [])

  const startAlertLoop = useCallback(() => {
    stopAlertLoop()
    alertLoopStartedAtRef.current = Date.now()

    alertLoopTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - alertLoopStartedAtRef.current
      if (elapsed >= ALERT_LOOP_MAX_MS || !activeOrderAlertRef.current) {
        stopAlertLoop()
        return
      }

      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        playDefaultRing()
      }
    }, ALERT_LOOP_INTERVAL_MS)
  }, [playDefaultRing, stopAlertLoop])

  const showBrowserNotification = useCallback(async (title, body, tag) => {
    if (typeof window === "undefined" || typeof Notification === "undefined") return
    if (Notification.permission !== "granted") return

    try {
      const cleanTitle = sanitizeNotificationText(title) || "New update"
      const cleanBody = sanitizeNotificationText(body)
      const options = {
        body: cleanBody,
        tag: tag || undefined,
        renotify: true,
        requireInteraction: true,
        silent: false,
        vibrate: [200, 100, 200, 100, 300],
        icon: "/favicon.ico",
        data: { targetUrl: "/admin/orders/all" },
      }

      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration()
        if (registration) {
          await registration.showNotification(cleanTitle, options)
          return
        }
      }

      const notification = new Notification(cleanTitle, options)
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
    } catch (_) {}
  }, [sanitizeNotificationText])

  // Unlock audio on first user gesture so rings can play reliably later
  useEffect(() => {
    const unlockAudio = async () => {
      if (audioUnlockedRef.current) return

      try {
        if (!fallbackAudioRef.current) {
          fallbackAudioRef.current = new Audio(alertSound)
          fallbackAudioRef.current.preload = "auto"
          fallbackAudioRef.current.volume = 1
        }

        // Prime media element playback permission
        fallbackAudioRef.current.muted = true
        await fallbackAudioRef.current.play()
        fallbackAudioRef.current.pause()
        fallbackAudioRef.current.currentTime = 0
        fallbackAudioRef.current.muted = false

        if (!notificationAudioRef.current) {
          const selectedSound = localStorage.getItem("delivery_alert_sound") || "zomato_tone"
          const soundFile = selectedSound === "original"
            ? resolveAudioSource(originalSound, "admin-original")
            : resolveAudioSource(alertSound, "admin-alert")
          notificationAudioRef.current = new Audio(soundFile)
          notificationAudioRef.current.preload = "auto"
          notificationAudioRef.current.volume = 1
        }
        notificationAudioRef.current.muted = true
        await notificationAudioRef.current.play()
        notificationAudioRef.current.pause()
        notificationAudioRef.current.currentTime = 0
        notificationAudioRef.current.muted = false

        // Prime WebAudio permission
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        if (AudioCtx && !audioContextRef.current) {
          audioContextRef.current = new AudioCtx()
        }
        if (audioContextRef.current?.state === "suspended") {
          await audioContextRef.current.resume()
        }
        if (audioContextRef.current?.state === "running") {
          await audioContextRef.current.suspend()
        }

        audioUnlockedRef.current = true
      } catch {
        // Ignore unlock errors; we'll retry on next gesture implicitly
      }
    }

    window.addEventListener("pointerdown", unlockAudio, { passive: true })
    window.addEventListener("keydown", unlockAudio)
    window.addEventListener("touchstart", unlockAudio, { passive: true })
    document.addEventListener("click", unlockAudio, { passive: true })
    document.addEventListener("touchstart", unlockAudio, { passive: true })

    return () => {
      window.removeEventListener("pointerdown", unlockAudio)
      window.removeEventListener("keydown", unlockAudio)
      window.removeEventListener("touchstart", unlockAudio)
      document.removeEventListener("click", unlockAudio)
      document.removeEventListener("touchstart", unlockAudio)
    }
  }, [])

  useEffect(() => {
    return () => {
      stopAlertLoop()
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close().catch(() => {})
      }
      if (notificationAudioRef.current) {
        notificationAudioRef.current.pause()
        notificationAudioRef.current = null
      }
    }
  }, [stopAlertLoop])

  useEffect(() => {
    if (statusKey !== "all") return
    if (typeof window === "undefined" || typeof Notification === "undefined") return
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {})
    }
  }, [statusKey])

  const extractOrdersFromResponse = useCallback((response) => {
    const rawOrders =
      response?.data?.data?.orders ??
      response?.data?.orders ??
      response?.data?.data?.docs ??
      response?.data?.data
    return Array.isArray(rawOrders) ? rawOrders : []
  }, [])

  const getTotalPagesFromResponse = useCallback((response) => {
    return (
      response?.data?.data?.meta?.totalPages ??
      response?.data?.data?.pagination?.totalPages ??
      response?.data?.data?.pagination?.pages ??
      1
    )
  }, [])

  const getTotalCountFromResponse = useCallback((response) => {
    const total =
      response?.data?.data?.meta?.total ??
      response?.data?.data?.pagination?.total
    return Number.isFinite(Number(total)) ? Number(total) : null
  }, [])

  const buildServerQueryParams = useCallback(() => {
    const filters = appliedFiltersRef.current
    return {
      search: searchQueryRef.current || undefined,
      paymentStatus: filters.paymentStatus
        ? String(filters.paymentStatus).toLowerCase()
        : undefined,
      minAmount: filters.minAmount !== "" ? filters.minAmount : undefined,
      maxAmount: filters.maxAmount !== "" ? filters.maxAmount : undefined,
      startDate: filters.fromDate || undefined,
      endDate: filters.toDate || undefined,
      restaurantId: filters.restaurantId || undefined,
    }
  }, [])

  const fetchOrders = useCallback(async (options = {}) => {
    const {
      silent = false,
      withRingCheck = false,
      page = apiPageRef.current,
      force = false,
    } = options

    if (withRingCheck) {
      if (socketConnectedRef.current) return
      if (fetchInFlightRef.current) return
      if (Date.now() - lastFetchAtRef.current < 4000) return
    }

    fetchAbortRef.current?.abort()
    const controller = new AbortController()
    fetchAbortRef.current = controller
    fetchInFlightRef.current = true

    try {
      if (!silent) {
        if (!hasLoadedOnceRef.current) {
          setIsInitialLoading(true)
        } else {
          setIsTableLoading(true)
        }
      }
      const currentStatusKey = statusKeyRef.current
      const baseParams = {
        status:
          currentStatusKey === "all"
            ? undefined
            : currentStatusKey === "restaurant-cancelled"
              ? "cancelled"
              : currentStatusKey,
        cancelledBy: currentStatusKey === "restaurant-cancelled" ? "restaurant" : undefined,
        ...buildServerQueryParams(),
      }

      const requestPage = withRingCheck ? 1 : page
      const requestLimit = withRingCheck ? 15 : PAGE_SIZE

      const response = await adminAPI.getOrders(
        {
          ...baseParams,
          page: requestPage,
          limit: requestLimit,
        },
        { force: force || !withRingCheck, signal: controller.signal },
      )

      if (controller.signal.aborted) return

      if (!response.data?.success) {
        if (!withRingCheck) {
          debugError("Failed to fetch orders:", response.data)
          if (!silent) toast.error("Failed to fetch orders")
          setOrders([])
          setTotalOrdersCount(0)
          setApiTotalPages(1)
        }
        return
      }

      const nextOrders = extractOrdersFromResponse(response)

      if (withRingCheck && currentStatusKey === "all") {
        const latestOrderIds = new Set(
          nextOrders
            .map((order) => order.id || order._id || order.orderId)
            .filter(Boolean),
        )

        if (!isFirstLoadRef.current) {
          const hasNewOrder = [...latestOrderIds].some(
            (id) => !seenOrderIdsRef.current.has(id),
          )
          if (hasNewOrder) {
            activeOrderAlertRef.current = { orderId: "polling-new-order" }
            playDefaultRing()
            startAlertLoop()
            if (typeof document !== "undefined" && document.visibilityState === "hidden") {
              showBrowserNotification(
                "New order received",
                "A new order arrived",
                `admin-order-poll-${Date.now()}`,
              )
            }
            toast.info("New order received")
            if (apiPageRef.current === 1) {
              setTotalOrdersCount(getTotalCountFromResponse(response) ?? nextOrders.length)
              setApiTotalPages(getTotalPagesFromResponse(response))
              setOrders(nextOrders)
            } else {
              setTotalOrdersCount((prev) => prev + 1)
            }
          }
        }

        latestOrderIds.forEach((id) => seenOrderIdsRef.current.add(id))
        isFirstLoadRef.current = false
        lastFetchAtRef.current = Date.now()
        return
      }

      const total = getTotalCountFromResponse(response) ?? nextOrders.length
      const totalPages = Math.max(1, getTotalPagesFromResponse(response))

      const nextOrderIds = new Set(
        nextOrders
          .map((order) => order.id || order._id || order.orderId)
          .filter(Boolean),
      )

      seenOrderIdsRef.current = nextOrderIds
      isFirstLoadRef.current = false
      setOrders(nextOrders)
      setTotalOrdersCount(total)
      setApiTotalPages(totalPages)
      lastFetchAtRef.current = Date.now()
      hasLoadedOnceRef.current = true
    } catch (error) {
      if (controller.signal.aborted || error?.code === "ERR_CANCELED" || error?.name === "CanceledError") {
        return
      }
      debugError("Error fetching orders:", error)
      if (!silent && !withRingCheck) {
        toast.error(error.response?.data?.message || "Failed to fetch orders")
      }
      if (!withRingCheck) {
        setOrders([])
        setTotalOrdersCount(0)
        setApiTotalPages(1)
      }
    } finally {
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null
      }
      fetchInFlightRef.current = false
      if (!silent) {
        setIsInitialLoading(false)
        setIsTableLoading(false)
      }
    }
  }, [
    extractOrdersFromResponse,
    getTotalPagesFromResponse,
    getTotalCountFromResponse,
    buildServerQueryParams,
    playDefaultRing,
    showBrowserNotification,
    startAlertLoop,
  ])

  const fetchOrdersRef = useRef(fetchOrders)
  fetchOrdersRef.current = fetchOrders

  const normalizedOrders = useMemo(() => {
    const safeOrders = Array.isArray(orders) ? orders : []

    return safeOrders.filter(Boolean).map((order) => {
      const createdAtRaw = order.createdAt || order.created_at || order.orderDate || null
      const createdAtCandidate = createdAtRaw ? new Date(createdAtRaw) : null
      const createdAt =
        createdAtCandidate && !Number.isNaN(createdAtCandidate.getTime())
          ? createdAtCandidate
          : null
      const date = createdAt
        ? createdAt.toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          }).toUpperCase()
        : ""
      const time = createdAt
        ? createdAt.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }).toUpperCase()
        : ""

      const pricing = order.pricing || {}
      const subtotal = Number(pricing.subtotal || 0)
      const deliveryFee = Number(pricing.deliveryFee || 0)
      const deliveryFeeGst = Number(pricing.deliveryFeeGst || 0)
      const platformFee = Number(pricing.platformFee || 0)
      const quickDeliveryFee = Number(pricing.quickDeliveryFee || 0)
      const taxAmount = Number(pricing.tax || 0)
      const discountAmount = Number(pricing.discount || 0)
      const computedTotal = subtotal + deliveryFee + deliveryFeeGst + platformFee + taxAmount - discountAmount
      const totalAmount = Number(
        pricing.total != null ? pricing.total : computedTotal
      )

      const paymentMethod = order.payment?.method || order.paymentMethod || ""
      let paymentType = order.paymentType
      if (!paymentType) {
        if (paymentMethod === "cash" || paymentMethod === "cod") paymentType = "Cash on Delivery"
        else if (paymentMethod === "wallet") paymentType = "Wallet"
        else if (paymentMethod) paymentType = "Online"
        else paymentType = "N/A"
      }

      const backendStatus = String(order.orderStatus || "").toLowerCase()

      const paymentStatusRaw = order.payment?.status || ""
      let paymentStatus = order.paymentStatus
      if (!paymentStatus) {
        const s = String(paymentStatusRaw || "").toLowerCase()
        
        if (s === "refunded") {
          paymentStatus = "Refunded"
        } else if (s === "paid" || s === "authorized" || s === "captured" || s === "settled") {
          paymentStatus = (paymentType === "Cash on Delivery") ? "Collected" : "Paid"
        } else if (paymentType === "Cash on Delivery" && backendStatus === "delivered") {
          paymentStatus = "Collected"
        } else if (s === "failed") {
          paymentStatus = "Failed"
        } else {
          paymentStatus = "Pending"
        }
      }

      let displayStatus = order.orderStatus
      if (backendStatus === "pending_payment") {
        displayStatus = "Pending Payment"
      } else if (!backendStatus || backendStatus === "created" || backendStatus === "confirmed") {
        displayStatus = "Pending"
      } else if (
        backendStatus === "preparing" ||
        backendStatus === "ready_for_pickup" ||
        backendStatus === "reached_pickup"
      ) {
        displayStatus = "Processing"
      } else if (backendStatus === "picked_up") {
        displayStatus = "Food On The Way"
      } else if (backendStatus === "delivered") {
        displayStatus = "Delivered"
      } else if (backendStatus === "cancelled_by_restaurant") {
        displayStatus = "Cancelled by Restaurant"
      } else if (backendStatus === "cancelled_by_user") {
        displayStatus = "Cancelled by User"
      } else if (backendStatus === "cancelled_by_admin") {
        displayStatus = "Canceled"
      }

      const dp = order.dispatch?.deliveryPartnerId
      const deliveryPartnerName =
        order.deliveryPartnerName ||
        dp?.name ||
        ""
      const deliveryPartnerPhone =
        order.deliveryPartnerPhone ||
        dp?.phone ||
        ""

      const items = Array.isArray(order.items)
        ? order.items.map((item) => ({
            quantity: item.quantity || 1,
            name: item.name || item.foodName || item.title || "Item",
            price: item.price || 0,
          }))
        : []

      const customerName = order.customerName || order.userId?.name || "N/A"
      const customerPhone = order.customerPhone || order.userId?.phone || "N/A"
      const restaurant =
        order.restaurant ||
        order.restaurantName ||
        order.restaurantId?.restaurantName ||
        ""

      return {
        ...order,
        id: order._id || order.id,
        orderId: order.orderId || order.id,
        date,
        time,
        customerName,
        customerPhone,
        restaurant,
        items,
        subtotal,
        totalItemAmount: subtotal,
        couponDiscount: discountAmount,
        itemDiscount: 0,
        deliveryCharge: deliveryFee,
        deliveryFeeGst,
        vatTax: taxAmount,
        platformFee,
        quickDeliveryFee,
        pricing,
        totalAmount,
        paymentType,
        paymentStatus,
        orderStatus: displayStatus,
        deliveryPartnerName,
        deliveryPartnerPhone,
        deliveryType: order.deliveryType || "Home Delivery",
        orderOtp: order.deliveryOtp,
        address: order.address || order.customerAddress || order.deliveryAddress,
        refundStatus: order.payment?.refund?.status || (order.payment?.status === 'refunded' ? 'processed' : null)
      }
    })
  }, [orders])

  const {
    isFilterOpen,
    setIsFilterOpen,
    isSettingsOpen,
    setIsSettingsOpen,
    isViewOrderOpen,
    setIsViewOrderOpen,
    selectedOrder,
    visibleColumns,
    handleExport,
    handleViewOrder,
    handlePrintOrder,
    toggleColumn,
    resetColumns,
  } = useOrdersManagement(normalizedOrders, statusKey, config.title, {
    serverSideFiltering: true,
  })

  const activeFiltersCount = useMemo(
    () => Object.values(appliedFilters).filter((value) => value !== "").length,
    [appliedFilters],
  )

  const handleApplyFilters = () => {
    setAppliedFilters({ ...draftFilters })
    setIsFilterOpen(false)
  }

  const handleResetFilters = () => {
    setDraftFilters(EMPTY_ORDER_FILTERS)
    setAppliedFilters(EMPTY_ORDER_FILTERS)
    appliedFiltersRef.current = EMPTY_ORDER_FILTERS
  }

  const displayCount = totalOrdersCount

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim())
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery])

  useEffect(() => {
    searchQueryRef.current = debouncedSearchQuery
  }, [debouncedSearchQuery])

  useEffect(() => {
    appliedFiltersRef.current = appliedFilters
  }, [appliedFilters])

  useEffect(() => {
    const fetchRestaurantOptions = async () => {
      try {
        const response = await adminAPI.getRestaurants({
          status: "approved",
          limit: 1000,
          page: 1,
        })
        const rows =
          response?.data?.data?.restaurants ||
          response?.data?.data?.data ||
          []
        setRestaurantOptions(
          rows
            .map((row) => ({
              id: row._id || row.id,
              name: row.restaurantName || row.name || "Restaurant",
            }))
            .filter((row) => row.id)
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      } catch {
        setRestaurantOptions([])
      }
    }

    fetchRestaurantOptions()
  }, [])

  useEffect(() => {
    apiPageRef.current = apiPage
  }, [apiPage])

  useEffect(() => {
    statusKeyRef.current = statusKey
  }, [statusKey])

  useEffect(() => {
    isFirstLoadRef.current = true
    seenOrderIdsRef.current = new Set()
    hasLoadedOnceRef.current = false
    searchQueryRef.current = ""
    appliedFiltersRef.current = EMPTY_ORDER_FILTERS
    setSearchQuery("")
    setDebouncedSearchQuery("")
    setDraftFilters(EMPTY_ORDER_FILTERS)
    setAppliedFilters(EMPTY_ORDER_FILTERS)
  }, [statusKey])

  useEffect(() => {
    apiPageRef.current = 1
    setApiPage(1)
    fetchOrdersRef.current({ silent: false, withRingCheck: false, page: 1, force: true })
  }, [statusKey, debouncedSearchQuery, appliedFilters])

  useEffect(() => {
    if (apiPage === 1) return
    fetchOrdersRef.current({ silent: false, withRingCheck: false, page: apiPage, force: true })
  }, [apiPage])

  useEffect(() => {
    if (statusKey !== "all") return undefined

    const pollId = setInterval(() => {
      fetchOrdersRef.current({ silent: true, withRingCheck: true })
    }, 12000)

    return () => clearInterval(pollId)
  }, [statusKey])

  useEffect(() => {
    if (statusKey !== "all") return undefined

    const backendUrl = API_BASE_URL.replace(/\/api\/?$/, "")
    // Backend disconnected - do not open Socket.IO (new backend in progress)
    if (!API_BASE_URL || !backendUrl || !backendUrl.startsWith("http")) {
      return undefined
    }

    const socket = io(backendUrl, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    })
    socketRef.current = socket

    const handleIncomingRealtimeOrder = (payload = {}) => {
      const orderId = payload?.orderId || payload?.orderMongoId || ""
      if (!orderId) {
        activeOrderAlertRef.current = payload || { orderId: "socket-new-order" }
        playDefaultRing()
        startAlertLoop()
        toast.info("New order received")
        showBrowserNotification(
          "New order received",
          "A new order arrived",
          `admin-order-socket-${Date.now()}`,
        )
        fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
        return
      }

      const now = Date.now()
      const lastHandledAt = recentRealtimeOrderRef.current.get(orderId) || 0
      if (now - lastHandledAt < 8000) return
      recentRealtimeOrderRef.current.set(orderId, now)

      const title = "New order received"
      const body = payload?.restaurantName
        ? `${payload.restaurantName} • ${orderId}`
        : `Order ${orderId}`

      activeOrderAlertRef.current = payload || { orderId }
      playDefaultRing()
      startAlertLoop()
      toast.info(title, { description: body })
      showBrowserNotification(title, body, `admin-order-${orderId}`)
      fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
    }

    socket.on("connect", () => {
      socketConnectedRef.current = true
      socket.emit("join-admin-orders")
    })
    socket.on("disconnect", () => {
      socketConnectedRef.current = false
    })
    const handleOrderStatusUpdate = () => {
      fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
    }

    socket.on("admin_new_order", handleIncomingRealtimeOrder)
    socket.on("order_status_update", handleOrderStatusUpdate)
    socket.on("play_notification_sound", handleIncomingRealtimeOrder)

    // Background reconciliation polling (25s interval)
    const backgroundPollTimer = setInterval(() => {
      fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
    }, 25000)

    return () => {
      socketConnectedRef.current = false
      clearInterval(backgroundPollTimer)
      socket.off("admin_new_order", handleIncomingRealtimeOrder)
      socket.off("order_status_update", handleOrderStatusUpdate)
      socket.off("play_notification_sound", handleIncomingRealtimeOrder)
      socket.disconnect()
      socketRef.current = null
      fetchAbortRef.current?.abort()
    }
  }, [statusKey, playDefaultRing, showBrowserNotification, startAlertLoop])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (typeof document === "undefined") return
      if (document.visibilityState !== "hidden") return
      if (!activeOrderAlertRef.current) return

      playDefaultRing()
      showBrowserNotification(
        "New order received",
        "A new order arrived",
        `admin-order-hidden-${Date.now()}`,
      )
    }

    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [playDefaultRing, showBrowserNotification])

  const [searchParams] = useSearchParams()
  const orderIdFromUrl = searchParams.get("orderId")

  useEffect(() => {
    if (orderIdFromUrl && normalizedOrders.length > 0) {
      const order = normalizedOrders.find(o => o.id === orderIdFromUrl || o._id === orderIdFromUrl || o.orderId === orderIdFromUrl)
      if (order) {
        handleViewOrder(order)
      }
    }
  }, [orderIdFromUrl, normalizedOrders, handleViewOrder])

  const handleAcceptOrder = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    try {
      setProcessingActionOrderId(order.id || order.orderId)
      const response = await adminAPI.acceptOrder(orderIdToUse)
      if (response.data?.success) {
        toast.success(response.data?.message || `Order ${order.orderId} accepted`)
        await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
      } else {
        toast.error(response.data?.message || "Failed to accept order")
      }
    } catch (error) {
      debugError("Error accepting order:", error)
      toast.error(error.response?.data?.message || "Failed to accept order")
    } finally {
      setProcessingActionOrderId(null)
    }
  }

  const handleRejectOrder = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    const reason = prompt(
      `Enter rejection reason for order ${order.orderId}:`,
      "Order rejected by admin",
    )

    if (reason === null) return

    try {
      setProcessingActionOrderId(order.id || order.orderId)
      const response = await adminAPI.rejectOrder(orderIdToUse, reason)
      if (response.data?.success) {
        toast.success(response.data?.message || `Order ${order.orderId} rejected`)
        await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
      } else {
        toast.error(response.data?.message || "Failed to reject order")
      }
    } catch (error) {
      debugError("Error rejecting order:", error)
      toast.error(error.response?.data?.message || "Failed to reject order")
    } finally {
      setProcessingActionOrderId(null)
    }
  }

  const handleCancelOrder = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    const reason = prompt(
      `Enter cancellation reason for order ${order.orderId}:`,
      "Order cancelled by admin",
    )

    if (reason === null) return

    try {
      setProcessingActionOrderId(order.id || order.orderId)
      const response = await adminAPI.rejectOrder(orderIdToUse, reason)
      if (response.data?.success) {
        toast.success(response.data?.message || `Order ${order.orderId} cancelled`)
        await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
      } else {
        toast.error(response.data?.message || "Failed to cancel order")
      }
    } catch (error) {
      debugError("Error cancelling order:", error)
      toast.error(error.response?.data?.message || "Failed to cancel order")
    } finally {
      setProcessingActionOrderId(null)
    }
  }

  const handleMarkDelivered = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    const confirmed = window.confirm(
      `Mark order ${order.orderId} as delivered? This will complete the order at its current stage.`,
    )
    if (!confirmed) return

    try {
      setProcessingActionOrderId(order.id || order.orderId)
      await adminAPI.markOrderDelivered(orderIdToUse)
      await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
    } catch (error) {
      debugError("Error marking order as delivered:", error)
    } finally {
      setProcessingActionOrderId(null)
    }
  }

  const handleDeassignAndResend = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    const confirmed = window.confirm(
      `Deassign the current delivery partner from order ${order.orderId} and resend it to other eligible delivery partners?`,
    )
    if (!confirmed) return

    try {
      setProcessingActionOrderId(order.id || order.orderId)
      const response = await adminAPI.deassignAndResendOrder(orderIdToUse)
      toast.success(
        response?.data?.message ||
          "Delivery partner deassigned and order dispatch restarted",
      )
      await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
    } catch (error) {
      debugError("Error reassigning order:", error)
      toast.error(
        error?.response?.data?.message || "Failed to deassign and resend order",
      )
      await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
    } finally {
      setProcessingActionOrderId(null)
    }
  }

  const handleResendNotification = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    try {
      setProcessingActionOrderId(order.id || order.orderId)
      const response = await adminAPI.resendDeliveryNotification(orderIdToUse)
      toast.success(
        response?.data?.message ||
          "Notification resent to delivery partners successfully",
      )
      await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
    } catch (error) {
      debugError("Error resending notification:", error)
      toast.error(
        error?.response?.data?.message || "Failed to resend notification",
      )
      await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
    } finally {
      setProcessingActionOrderId(null)
    }
  }

  const handleDeleteOrder = async (order) => {
    const orderIdToUse = order.id || order._id || order.orderId
    if (!orderIdToUse) {
      toast.error("Order ID not found")
      return
    }

    const shouldDelete = confirm(
      `Delete order ${order.orderId} permanently?\n\nThis will remove it from customer and delivery apps as well.`,
    )

    if (!shouldDelete) return

    try {
      setDeletingOrderId(order.id || order.orderId)
      const response = await adminAPI.deleteOrder(orderIdToUse)
      if (response.data?.success) {
        toast.success(response.data?.message || `Order ${order.orderId} deleted`)
        await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
      } else {
        toast.error(response.data?.message || "Failed to delete order")
      }
    } catch (error) {
      debugError("Error deleting order:", error)
      toast.error(error.response?.data?.message || "Failed to delete order")
    } finally {
      setDeletingOrderId(null)
    }
  }

  // Handle refund button click - show modal for wallet payments, confirm dialog for others
  const handleRefund = (order) => {
    const isWalletPayment = order.paymentType === "Wallet" || order.payment?.method === "wallet";
    
    if (isWalletPayment) {
      // Show modal for wallet refunds
      setSelectedOrderForRefund(order)
      setRefundModalOpen(true)
    } else {
      // For non-wallet payments, use the old confirm dialog flow
      const confirmMessage = `Are you sure you want to process refund for order ${order.orderId}?\n\nThis will initiate a Razorpay refund to the customer's original payment method.`;
      
      if (!confirm(confirmMessage)) {
        return
      }
      
      processRefund(order, null) // null amount means use default
    }
  }

  // Process refund with amount
  const processRefund = async (order, refundAmount = null) => {
    // Try using MongoDB _id first (more reliable for route matching), then fallback to orderId string
    // Backend accepts either MongoDB ObjectId (24 chars) or orderId string
    // Using MongoDB _id is more reliable for route matching (no dashes/special chars)
    const orderIdToUse = order.id || order._id || order.orderId
    
    if (!orderIdToUse) {
      debugError('? No orderId found in order object:', order)
      toast.error('Order ID not found. Please refresh the page and try again.')
      return
    }
    
    debugLog('?? Order details for refund:', {
      orderIdString: order.orderId,
      mongoId: order.id,
      orderIdToUse,
      willUse: order.orderId ? 'orderId string' : 'MongoDB _id',
      refundAmount
    })

    try {
      setProcessingRefund(orderIdToUse)
      
      debugLog('?? Processing refund for order:', {
        orderId: order.orderId,
        id: order.id,
        _id: order._id,
        orderIdToUse,
        refundAmount,
        url: `/api/admin/orders/${orderIdToUse}/refund`
      })
      
      // Include refundAmount in request body if provided (ensure it's a number)
      const requestData = refundAmount !== null ? { refundAmount: parseFloat(refundAmount) } : {}
      debugLog('?? Request data being sent:', requestData)
      const response = await adminAPI.processRefund(orderIdToUse, requestData)
      
      if (response.data?.success) {
        const isWalletPayment = order.paymentType === "Wallet" || order.payment?.method === "wallet";
        toast.success(response.data?.message || (isWalletPayment 
          ? `Wallet refund of \u20B9${refundAmount || order.totalAmount} processed successfully for order ${order.orderId}`
          : `Refund sent to the original payment method for order ${order.orderId}`))
        // Update the order in the local state immediately to show "Refunded" status
        setOrders(prevOrders => 
          prevOrders.map(o => 
            (o.id === order.id || o.orderId === order.orderId)
              ? { ...o, refundStatus: 'processed' } // Wallet refunds are instant, so mark as processed
              : o
          )
        )
        // Refresh the orders list to get updated data
        await fetchOrdersRef.current({ silent: true, withRingCheck: false, force: true })
      } else {
        toast.error(response.data?.message || "Failed to process refund")
      }
    } catch (error) {
      debugError("? Error processing refund:", error)
      
      // Log full error details for debugging
      const errorDetails = {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        url: error.config?.url,
        baseURL: error.config?.baseURL,
        fullURL: error.config?.baseURL + error.config?.url,
        orderId: orderIdToUse,
        refundAmount: refundAmount,
        order: {
          id: order.id,
          orderId: order.orderId,
          _id: order._id
        },
        stack: error.stack
      }
      debugError("? Error details:", JSON.stringify(errorDetails, null, 2))
      
      // Show more specific error message
      let errorMessage = "Failed to process refund"
      
      if (error.response) {
        // Server responded with error
        if (error.response.status === 404) {
          errorMessage = `Order not found (ID: ${orderIdToUse}). Please check if the order exists.`
        } else if (error.response.status === 400) {
          errorMessage = error.response.data?.message || "Invalid request. Please check the refund amount."
        } else if (error.response.status === 500) {
          errorMessage = error.response.data?.message || "Server error. Please try again later."
        } else if (error.response.data?.message) {
          errorMessage = error.response.data.message
        } else {
          errorMessage = `Error ${error.response.status}: ${error.response.statusText || "Unknown error"}`
        }
      } else if (error.request) {
        // Request was made but no response received
        errorMessage = "Network error. Please check your internet connection and try again."
      } else {
        // Error in setting up the request
        errorMessage = error.message || "Failed to process refund"
      }
      
      debugError("? Final error message:", errorMessage)
      toast.error(errorMessage)
    } finally {
      setProcessingRefund(null)
      setRefundModalOpen(false)
      setSelectedOrderForRefund(null)
    }
  }

  // Handle refund confirmation from modal
  const handleRefundConfirm = (amount) => {
    if (selectedOrderForRefund) {
      processRefund(selectedOrderForRefund, amount)
    }
  }

  if (showLoadingSkeleton) {
    return (
      <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-slate-50 p-4 lg:p-6">
        <OrdersDashboardSkeleton />
      </div>
    )
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen w-full max-w-full overflow-x-hidden">
      <OrdersTopbar 
        title={config.title} 
        count={displayCount} 
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onFilterClick={() => setIsFilterOpen(true)}
        activeFiltersCount={activeFiltersCount}
        onExport={handleExport}
        onSettingsClick={() => setIsSettingsOpen(true)}
      />
      <FilterPanel
        isOpen={isFilterOpen}
        onClose={() => setIsFilterOpen(false)}
        filters={draftFilters}
        setFilters={setDraftFilters}
        onApply={handleApplyFilters}
        onReset={handleResetFilters}
        restaurantOptions={restaurantOptions}
      />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        visibleColumns={visibleColumns}
        toggleColumn={toggleColumn}
        resetColumns={resetColumns}
        columnsConfig={{
          si: "Serial Number",
          orderId: "Order ID",
          orderDate: "Order Date",
          orderOtp: "Order OTP",
          customer: "Customer Information",
          restaurant: "Restaurant",
          foodItems: "Food Items",
          totalAmount: "Total Amount",
          paymentType: "Payment Type",
          paymentCollectionStatus: "Payment Status",
          orderStatus: "Order Status",
          ...(statusKey === "all"
            ? { deliveryPartner: "Assigned Delivery Partner" }
            : {}),
          actions: "Actions",
        }}
      />
      <ViewOrderDialog
        isOpen={isViewOrderOpen}
        onOpenChange={setIsViewOrderOpen}
        order={selectedOrder}
      />
      <RefundModal
        isOpen={refundModalOpen}
        onOpenChange={setRefundModalOpen}
        order={selectedOrderForRefund}
        onConfirm={handleRefundConfirm}
        isProcessing={processingRefund !== null}
      />
      <OrdersTable 
        orders={normalizedOrders} 
        visibleColumns={visibleColumns}
        isLoading={isTableLoading}
        serverPagination
        totalCount={totalOrdersCount}
        currentPage={apiPage}
        totalPages={apiTotalPages}
        pageSize={PAGE_SIZE}
        onPageChange={setApiPage}
        onViewOrder={handleViewOrder}
        onPrintOrder={handlePrintOrder}
        onRefund={handleRefund}
        onDeleteOrder={statusKey === "all" ? handleDeleteOrder : undefined}
        onAcceptOrder={statusKey === "all" || statusKey === "pending" ? handleAcceptOrder : undefined}
        onRejectOrder={statusKey === "all" || statusKey === "pending" ? handleRejectOrder : undefined}
        onMarkDelivered={handleMarkDelivered}
        onDeassignAndResend={handleDeassignAndResend}
        onResendNotification={handleResendNotification}
        onCancelOrder={
          statusKey === "all" ||
          statusKey === "pending" ||
          statusKey === "processing" ||
          statusKey === "food-on-the-way"
            ? handleCancelOrder
            : undefined
        }
        actionLoadingOrderId={processingActionOrderId}
        deletingOrderId={deletingOrderId}
        showAssignedDeliveryPartner={
          statusKey === "all" ||
          statusKey === "processing" ||
          statusKey === "food-on-the-way"
        }
      />
    </div>
  )
}
