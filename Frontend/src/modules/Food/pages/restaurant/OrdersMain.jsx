import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Printer,
  Volume2,
  VolumeX,
  ChevronDown,
  ChevronUp,
  Minus,
  Plus,
  X,
  AlertCircle,
  Loader2,
  Calendar,
  Clock,
  Users,
  MessageSquare,
  ChevronRight,
  Search,
  Inbox,
  User,
  Lock,
  Unlock,
  Phone,
  Star,
} from "lucide-react";
import { toast } from "sonner";
import { getRestaurantCookingNote } from "@food/utils/orderCookingNote";
import BottomNavOrders from "@food/components/restaurant/BottomNavOrders";
import RestaurantNavbar from "@food/components/restaurant/RestaurantNavbar";
import NewOrderAcceptCard from "@food/components/restaurant/NewOrderAcceptCard";
import { restaurantAPI, diningAPI } from "@food/api";
import { useRestaurantNotifications } from "@food/hooks/useRestaurantNotifications";
import ResendNotificationButton from "@food/components/restaurant/ResendNotificationButton";
import { getOrderAlertKey, setAlertMuted, stopAlert, stopAllAlerts, unlockAlertAudio } from "@food/utils/audioSessionManager";
const debugLog = (...args) => { };
const debugWarn = (...args) => { };
const debugError = (...args) => { };

const STORAGE_KEY = "restaurant_online_status";

const matchesOrderSearch = (order, searchQuery) => {
  if (!searchQuery) return true;
  const q = String(searchQuery).toLowerCase().trim();
  if (!q) return true;
  return (
    String(order.orderId || order.mongoId || "").toLowerCase().includes(q) ||
    String(order.customerName || "").toLowerCase().includes(q) ||
    String(order.itemsSummary || "").toLowerCase().includes(q)
  );
};

// Top filter tabs
const filterTabs = [
  { id: "new", label: "New Orders" },
  { id: "all", label: "All" },
  { id: "preparing", label: "Preparing" },
  { id: "ready", label: "Ready" },
  { id: "out-for-delivery", label: "Out for delivery" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];

const getQueuedOrderKeys = (orderLike = {}) =>
  [
    orderLike?.orderMongoId,
    orderLike?.orderId,
    orderLike?._id,
    orderLike?.id,
    getOrderAlertKey(orderLike),
  ]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter(Boolean);

const isSameQueuedOrder = (a, b) => {
  const aKeys = new Set(getQueuedOrderKeys(a));
  const bKeys = getQueuedOrderKeys(b);
  return bKeys.some((k) => aKeys.has(k));
};

const allOrdersStatusPriority = {
  pending: 0,
  confirmed: 1,
  preparing: 2,
  ready: 3,
  out_for_delivery: 4,
  delivered: 6,
  completed: 6,
  cancelled: 7,
};

const getAllOrdersTimestamp = (order) =>
  order?.cancelledAt ||
  order?.deliveredAt ||
  order?.updatedAt ||
  order?.createdAt ||
  new Date().toISOString();

const transformOrderForList = (order) => ({
  orderId: order.orderId || order._id,
  mongoId: order._id,
  status: order.status || "pending",
  customerName: order.userId?.name || order.customerName || "Customer",
  type: "Home Delivery",
  tableOrToken: null,
  timePlaced: new Date(getAllOrdersTimestamp(order)).toLocaleDateString(
    "en-US",
    {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  ),
  eta: null,
  itemsSummary:
    order.items?.map((item) => `${item.quantity}x ${item.name}`).join(", ") ||
    "No items",
  photoUrl: order.items?.[0]?.image || null,
  photoAlt: order.items?.[0]?.name || "Order",
  note: getRestaurantCookingNote(order),
  paymentMethod: order.paymentMethod || order.payment?.method || null,
  deliveryPartnerId: order.deliveryPartnerId || null,
  dispatchStatus: order.dispatch?.status || null,
  preparingTimestamp: order.tracking?.preparing?.timestamp
    ? new Date(order.tracking.preparing.timestamp)
    : new Date(order.createdAt || Date.now()),
  initialETA: order.estimatedDeliveryTime || 30,
  sortTimestamp: new Date(getAllOrdersTimestamp(order)).getTime(),
});

// Shared short-lived cache to collapse duplicate getOrders() calls across sections
// mounting/polling at nearly the same time.
let sharedOrdersResponse = null;
let sharedOrdersFetchedAt = 0;
let sharedOrdersPromise = null;

const getSharedOrdersResponse = async (maxAgeMs = 1500) => {
  const now = Date.now();
  if (sharedOrdersResponse && now - sharedOrdersFetchedAt <= maxAgeMs) {
    return sharedOrdersResponse;
  }
  if (sharedOrdersPromise) {
    return sharedOrdersPromise;
  }

  sharedOrdersPromise = restaurantAPI
    .getOrders()
    .then((response) => {
      sharedOrdersResponse = response;
      sharedOrdersFetchedAt = Date.now();
      return response;
    })
    .finally(() => {
      sharedOrdersPromise = null;
    });

  return sharedOrdersPromise;
};

// Completed Orders List Component
function CompletedOrders({ onSelectOrder, refreshToken = 0, searchQuery = "" }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const fetchOrders = async () => {
      try {
        const response = await getSharedOrdersResponse();

        if (!isMounted) return;

        if (response.data?.success && response.data.data?.orders) {
          const completedOrders = response.data.data.orders.filter(
            (order) =>
              order.status === "delivered" || order.status === "completed",
          );

          const transformedOrders = completedOrders.map((order) => ({
            orderId: order.orderId || order._id,
            mongoId: order._id,
            status: order.status || "delivered",
            customerName: order.userId?.name || order.customerName || "Customer",
            type: "Home Delivery",
            tableOrToken: null,
            timePlaced: new Date(order.createdAt).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            deliveredAt:
              order.deliveredAt || order.updatedAt || order.createdAt,
            itemsSummary:
              order.items
                ?.map((item) => `${item.quantity}x ${item.name}`)
                .join(", ") || "No items",
            photoUrl: order.items?.[0]?.image || null,
            photoAlt: order.items?.[0]?.name || "Order",
            note: getRestaurantCookingNote(order),
            amount: order.pricing?.total || order.total || 0,
            paymentMethod: order.paymentMethod || order.payment?.method || null,
          }));

          transformedOrders.sort((a, b) => {
            const dateA = new Date(a.deliveredAt);
            const dateB = new Date(b.deliveredAt);
            return dateB - dateA;
          });

          if (isMounted) {
            setOrders(transformedOrders);
            setLoading(false);
          }
        } else {
          if (isMounted) {
            setOrders([]);
            setLoading(false);
          }
        }
      } catch (error) {
        if (!isMounted) return;

        if (error.code !== "ERR_NETWORK" && error.response?.status !== 404) {
          debugError("Error fetching completed orders:", error);
        }

        if (isMounted) {
          setOrders([]);
          setLoading(false);
        }
      }
    };

    fetchOrders();

    return () => {
      isMounted = false;
    };
  }, [refreshToken]);

  if (loading) {
    return (
      <div className="pt-4 pb-6">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold text-black">
            Completed orders
          </h2>
          <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
        </div>
        <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="pt-4 pb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-semibold text-black">Completed orders</h2>
        <span className="text-xs text-gray-500">{orders.filter((o) => matchesOrderSearch(o, searchQuery)).length} total</span>
      </div>
      {orders.filter((o) => matchesOrderSearch(o, searchQuery)).length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm">
          No completed orders yet
        </div>
      ) : (
        <div>
          {orders.filter((o) => matchesOrderSearch(o, searchQuery)).map((order) => {
            const deliveredDate = order.deliveredAt
              ? new Date(order.deliveredAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
              : "N/A";

            return (
              <div
                key={order.orderId || order.mongoId}
                className="w-full bg-white rounded-2xl p-4 mb-3 border border-gray-200">
                <button
                  type="button"
                  onClick={() =>
                    onSelectOrder?.({
                      orderId: order.orderId,
                      status: "Delivered",
                      customerName: order.customerName,
                      type: order.type,
                      tableOrToken: order.tableOrToken,
                      timePlaced: deliveredDate,
                      itemsSummary: order.itemsSummary,
                      paymentMethod: order.paymentMethod,
                    })
                  }
                  className="w-full text-left flex gap-3 items-stretch">
                  <div className="h-20 w-20 rounded-xl overflow-hidden bg-gray-100 flex items-center justify-center flex-shrink-0 my-auto">
                    {order.photoUrl ? (
                      <img
                        src={order.photoUrl}
                        alt={order.photoAlt}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center px-2">
                        <span className="text-[11px] font-medium text-gray-500 text-center leading-tight">
                          {order.photoAlt}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex-1 flex flex-col justify-between min-h-[80px]">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-black leading-tight">
                          Order #{order.orderId}
                        </p>
                        <p className="text-[11px] text-gray-500 mt-1">
                          {order.customerName}
                        </p>
                      </div>

                      <div className="flex flex-col items-end gap-1">
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border border-green-500 text-green-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          Delivered
                        </span>
                        <span className="text-[11px] text-gray-500 text-right">
                          {deliveredDate}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2">
                      <p className="text-xs text-gray-600 line-clamp-1">
                        {order.itemsSummary}
                      </p>
                    </div>

                    <div className="mt-2 flex items-end justify-between gap-2">
                      <div className="flex flex-col gap-1">
                        <p className="text-[11px] text-gray-500">
                          {order.type}
                        </p>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-[11px] text-gray-500">
                          Amount
                        </span>
                        <span className="text-xs font-medium text-black">
                          ₹{order.amount.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Cancelled Orders List Component
function CancelledOrders({ onSelectOrder, refreshToken = 0, searchQuery = "" }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const fetchOrders = async () => {
      try {
        const response = await getSharedOrdersResponse();

        if (!isMounted) return;

        if (response.data?.success && response.data.data?.orders) {
          // Filter cancelled orders (both restaurant and user cancelled)
          const cancelledOrders = response.data.data.orders.filter(
            (order) => order.status === "cancelled",
          );

          const transformedOrders = cancelledOrders.map((order) => ({
            orderId: order.orderId || order._id,
            mongoId: order._id,
            status: order.status || "cancelled",
            customerName: order.userId?.name || order.customerName || "Customer",
            type: "Home Delivery",
            tableOrToken: null,
            timePlaced: new Date(order.createdAt).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            cancelledAt:
              order.cancelledAt || order.updatedAt || order.createdAt,
            cancelledBy: order.cancelledBy || "unknown",
            cancellationReason:
              order.cancellationReason || "No reason provided",
            itemsSummary:
              order.items
                ?.map((item) => `${item.quantity}x ${item.name}`)
                .join(", ") || "No items",
            photoUrl: order.items?.[0]?.image || null,
            photoAlt: order.items?.[0]?.name || "Order",
            note: getRestaurantCookingNote(order),
            amount: order.pricing?.total || order.total || 0,
            paymentMethod: order.paymentMethod || order.payment?.method || null,
          }));

          transformedOrders.sort((a, b) => {
            const dateA = new Date(a.cancelledAt);
            const dateB = new Date(b.cancelledAt);
            return dateB - dateA;
          });

          if (isMounted) {
            setOrders(transformedOrders);
            setLoading(false);
          }
        } else {
          if (isMounted) {
            setOrders([]);
            setLoading(false);
          }
        }
      } catch (error) {
        if (!isMounted) return;

        if (error.code !== "ERR_NETWORK" && error.response?.status !== 404) {
          debugError("Error fetching cancelled orders:", error);
        }

        if (isMounted) {
          setOrders([]);
          setLoading(false);
        }
      }
    };

    fetchOrders();

    return () => {
      isMounted = false;
    };
  }, [refreshToken]);

  if (loading) {
    return (
      <div className="pt-4 pb-6">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold text-black">
            Cancelled orders
          </h2>
          <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
        </div>
        <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="pt-4 pb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-semibold text-black">Cancelled orders</h2>
        <span className="text-xs text-gray-500">{orders.filter((o) => matchesOrderSearch(o, searchQuery)).length} total</span>
      </div>
      {orders.filter((o) => matchesOrderSearch(o, searchQuery)).length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm">
          No cancelled orders yet
        </div>
      ) : (
        <div>
          {orders.filter((o) => matchesOrderSearch(o, searchQuery)).map((order) => {
            const cancelledDate = order.cancelledAt
              ? new Date(order.cancelledAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
              : "N/A";

            const cancelledByText =
              order.cancelledBy === "user"
                ? "Cancelled by User"
                : order.cancelledBy === "restaurant"
                  ? "Cancelled by Restaurant"
                  : "Cancelled";

            return (
              <div
                key={order.orderId || order.mongoId}
                className="w-full bg-white rounded-2xl p-4 mb-3 border border-gray-200">
                <button
                  type="button"
                  onClick={() =>
                    onSelectOrder?.({
                      orderId: order.orderId,
                      status: "Cancelled",
                      customerName: order.customerName,
                      type: order.type,
                      tableOrToken: order.tableOrToken,
                      timePlaced: cancelledDate,
                      itemsSummary: order.itemsSummary,
                      paymentMethod: order.paymentMethod,
                    })
                  }
                  className="w-full text-left flex gap-3 items-stretch">
                  <div className="h-20 w-20 rounded-xl overflow-hidden bg-gray-100 flex items-center justify-center flex-shrink-0 my-auto">
                    {order.photoUrl ? (
                      <img
                        src={order.photoUrl}
                        alt={order.photoAlt}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center px-2">
                        <span className="text-[11px] font-medium text-gray-500 text-center leading-tight">
                          {order.photoAlt}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex-1 flex flex-col justify-between min-h-[80px]">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-black leading-tight">
                          Order #{order.orderId}
                        </p>
                        <p className="text-[11px] text-gray-500 mt-1">
                          {order.customerName}
                        </p>
                      </div>

                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border ${order.cancelledBy === "user"
                            ? "border-orange-500 text-orange-600"
                            : "border-red-500 text-red-600"
                            }`}>
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${order.cancelledBy === "user"
                              ? "bg-orange-500"
                              : "bg-red-500"
                              }`}
                          />
                          {cancelledByText}
                        </span>
                        <span className="text-[11px] text-gray-500 text-right">
                          {cancelledDate}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2">
                      <p className="text-xs text-gray-600 line-clamp-1">
                        {order.itemsSummary}
                      </p>
                      {order.cancellationReason && (
                        <p className="text-[10px] text-red-600 mt-1 line-clamp-1">
                          Reason: {order.cancellationReason}
                        </p>
                      )}
                    </div>

                    <div className="mt-2 flex items-end justify-between gap-2">
                      <div className="flex flex-col gap-1">
                        <p className="text-[11px] text-gray-500">
                          {order.type}
                        </p>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-[11px] text-gray-500">
                          Amount
                        </span>
                        <span className="text-xs font-medium text-black">
                          ₹{order.amount.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Table Bookings List Component
function TableBookings() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    let restaurantEntity = null;

    const resolveRestaurantEntity = async () => {
      if (restaurantEntity) return restaurantEntity;
      const res = await restaurantAPI.getCurrentRestaurant();
      restaurantEntity =
        res.data?.data?.restaurant || res.data?.restaurant || res.data?.data || null;
      return restaurantEntity;
    };

    const fetchBookings = async () => {
      try {
        const restaurant = await resolveRestaurantEntity();
        const restaurantId = restaurant?._id || restaurant?.id;

        if (restaurantId) {
          const response = await diningAPI.getRestaurantBookings(restaurant);
          if (isMounted && response.data.success) {
            setBookings(response.data.data);
          }
        }
      } catch (error) {
        debugError("Error fetching table bookings:", error);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchBookings();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchBookings();
    }, 10000);
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        fetchBookings();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      isMounted = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const handleStatusUpdate = async (bookingId, status) => {
    try {
      const response = await diningAPI.updateBookingStatusRestaurant(bookingId, status);
      if (response.data.success) {
        toast.success(`Booking ${status === "confirmed" ? "confirmed" : "rejected"} successfully`);
        // Force refresh
        setBookings((prev) =>
          prev.map((b) =>
            b._id === bookingId ? { ...b, status: status === "confirmed" ? "confirmed" : "cancelled" } : b
          )
        );
      }
    } catch (error) {
      debugError("Error updating booking status:", error);
      toast.error("Failed to update booking status");
    }
  };

  if (loading)
    return (
      <div className="text-center py-10 text-gray-400">Loading bookings...</div>
    );

  return (
    <div className="pt-4 pb-6 px-1">
      <div className="flex items-baseline justify-between mb-4 px-1">
        <h2 className="text-base font-semibold text-black">Table Bookings</h2>
        <span className="text-xs text-gray-500">{bookings.length} total</span>
      </div>

      {bookings.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-2xl border border-gray-200">
          <p className="text-gray-400 text-sm">No table bookings yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bookings.map((booking) => (
            <div
              key={booking._id}
              className="bg-white rounded-2xl p-4 border border-gray-200 shadow-sm transition-all hover:border-gray-300">
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <h3 className="text-sm font-bold text-gray-900">
                    {booking.user?.name}
                  </h3>
                  <p className="text-[11px] text-gray-500">
                    {booking.user?.phone || "No phone"}
                  </p>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${
                    (booking.status === "confirmed" || booking.status === "accepted")
                      ? "bg-green-100 text-green-700"
                      : booking.status === "pending"
                        ? "bg-amber-100 text-amber-700"
                        : booking.status === "checked-in"
                          ? "bg-orange-100 text-orange-700"
                          : booking.status === "completed"
                            ? "bg-blue-100 text-blue-700"
                            : "bg-gray-100 text-gray-600"
                    }`}>
                  {booking.status === "pending" ? "Request" : (booking.status === "accepted" ? "confirmed" : booking.status)}
                </span>
              </div>

              <div className="flex items-center gap-4 text-[11px] text-gray-600 bg-gray-50 p-2.5 rounded-xl border border-gray-100">
                <div className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-gray-400" />
                  <span>
                    {new Date(booking.date).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-gray-400" />
                  <span>{booking.timeSlot}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5 text-gray-400" />
                  <span>{booking.guests} Guests</span>
                </div>
              </div>

              {booking.specialRequest && (
                <div className="mt-3 p-2 bg-blue-50/50 rounded-lg border border-blue-100/50">
                  <p className="text-[10px] text-blue-700 italic flex items-start gap-1">
                    <MessageSquare className="w-3 h-3 mt-0.5 shrink-0" />
                    <span className="line-clamp-2">
                      {booking.specialRequest}
                    </span>
                  </p>
                </div>
              )}

              {booking.status === "pending" && (
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => handleStatusUpdate(booking._id, "confirmed")}
                    className="flex-1 bg-green-600 text-white py-2 rounded-xl text-xs font-bold hover:bg-green-700 transition-colors">
                    Accept
                  </button>
                  <button
                    onClick={() => handleStatusUpdate(booking._id, "cancelled")}
                    className="flex-1 bg-white border border-red-200 text-red-600 py-2 rounded-xl text-xs font-bold hover:bg-red-50 transition-colors">
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AllOrders({ onSelectOrder, onCancel, searchQuery = "" }) {
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [markingReadyOrderIds, setMarkingReadyOrderIds] = useState({});

  useEffect(() => {
    let isMounted = true;
    let intervalId = null;
    let countdownIntervalId = null;

    const fetchOrders = async () => {
      try {
        const response = await getSharedOrdersResponse();

        if (!isMounted) return;

        if (response.data?.success && response.data.data?.orders) {
          const transformedOrders = response.data.data.orders
            .map(transformOrderForList)
            .sort((a, b) => {
              const priorityDiff =
                (allOrdersStatusPriority[a.status] ?? 999) -
                (allOrdersStatusPriority[b.status] ?? 999);
              if (priorityDiff !== 0) return priorityDiff;
              return b.sortTimestamp - a.sortTimestamp;
            });

          setOrders(transformedOrders);
        } else {
          setOrders([]);
        }
      } catch (error) {
        if (!isMounted) return;

        if (
          error.code !== "ERR_NETWORK" &&
          error.response?.status !== 404 &&
          error.response?.status !== 401
        ) {
          debugError("Error fetching all orders:", error);
        }

        setOrders([]);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchOrders();
    intervalId = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchOrders();
    }, 10000);
    countdownIntervalId = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (isMounted) {
        setCurrentTime(new Date());
      }
    }, 1000);
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        fetchOrders();
        if (isMounted) setCurrentTime(new Date());
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isMounted = false;
      if (intervalId) clearInterval(intervalId);
      if (countdownIntervalId) clearInterval(countdownIntervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const handleMarkReady = async ({ orderId, mongoId }) => {
    const orderKey = mongoId || orderId;
    if (!orderKey || markingReadyOrderIds[orderKey]) return;

    try {
      setMarkingReadyOrderIds((prev) => ({ ...prev, [orderKey]: true }));
      await restaurantAPI.markOrderReady(orderKey);
      setOrders((prev) =>
        prev.map((order) =>
          (order.mongoId || order.orderId) === orderKey
            ? {
              ...order,
              status: "ready",
              eta: null,
              sortTimestamp: Date.now(),
            }
            : order,
        ),
      );
      toast.success("Order marked as ready");
    } catch (error) {
      debugError("Error marking order as ready from All orders:", error);
      toast.error(
        error.response?.data?.message || "Failed to mark order as ready",
      );
    } finally {
      setMarkingReadyOrderIds((prev) => ({ ...prev, [orderKey]: false }));
    }
  };

  if (loading) {
    return (
      <div className="pt-4 pb-6 md:pt-0">
        <div className="flex items-baseline justify-between mb-3 md:mb-5">
          <h2 className="text-base md:text-lg font-bold text-gray-900">All orders</h2>
          <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
        </div>
        <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  const filteredOrders = orders.filter((o) => matchesOrderSearch(o, searchQuery));

  return (
    <div className="pt-4 pb-6 md:pt-0">
      <div className="flex items-baseline justify-between mb-3 md:mb-5">
        <div className="flex items-center gap-2">
          <h2 className="text-base md:text-lg font-bold text-gray-900">All orders</h2>
          <span className="text-xs md:text-sm font-semibold text-gray-500">({filteredOrders.length})</span>
        </div>
        <button
          type="button"
          onClick={() => navigate("/food/restaurant/orders/all")}
          className="text-sm font-semibold text-blue-600 hidden md:block hover:text-blue-700 transition-colors"
        >
          Full History &gt;
        </button>
      </div>
      {filteredOrders.length === 0 ? (
        <div className="md:bg-white md:rounded-2xl md:border md:border-gray-100/80 md:shadow-sm flex flex-col items-center justify-center py-16 md:min-h-[400px]">
          <div className="w-16 h-16 bg-slate-50/80 rounded-full flex items-center justify-center mb-4 border border-gray-100 hidden md:flex">
            <Inbox className="w-6 h-6 text-slate-300" strokeWidth={1.5} />
          </div>
          <h3 className="text-base md:text-lg font-bold text-gray-500 md:text-gray-900">There is no live order</h3>
          <p className="text-sm text-gray-400 mt-1 hidden md:block">There are no orders here right now.</p>
        </div>
      ) : (
        <div>
          {filteredOrders.map((order) => {
            const normalizedStatus = String(order.status || "").toLowerCase();
            let etaDisplay = order.eta;

            if (normalizedStatus === "preparing" && order.preparingTimestamp) {
              const elapsedMs = currentTime - order.preparingTimestamp;
              const elapsedMinutes = Math.floor(elapsedMs / 60000);
              const remainingMinutes = Math.max(
                0,
                order.initialETA - elapsedMinutes,
              );

              if (remainingMinutes <= 0) {
                const remainingSeconds = Math.max(
                  0,
                  Math.floor(order.initialETA * 60 - elapsedMs / 1000),
                );
                etaDisplay =
                  remainingSeconds > 0 ? `${remainingSeconds} secs` : "0 mins";
              } else {
                etaDisplay = `${remainingMinutes} mins`;
              }
            }

            return (
              <OrderCard
                key={order.orderId || order.mongoId}
                {...order}
                eta={etaDisplay}
                onSelect={onSelectOrder}
                onCancel={
                  normalizedStatus === "preparing" ? onCancel : undefined
                }
                onMarkReady={
                  normalizedStatus === "preparing" ? handleMarkReady : undefined
                }
                isMarkingReady={Boolean(
                  markingReadyOrderIds[order.mongoId || order.orderId],
                )}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function OrdersMain() {
  const navigate = useNavigate();
  const [activeFilter, setActiveFilter] = useState("new");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const contentRef = useRef(null);
  const filterBarRef = useRef(null);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);
  const touchStartY = useRef(0);
  const isSwiping = useRef(false);
  const mouseStartX = useRef(0);
  const mouseEndX = useRef(0);
  const isMouseDown = useRef(false);

  // New orders queue (replaces single popup)
  const [pendingNewOrders, setPendingNewOrders] = useState([]);
  const [ordersRefreshToken, setOrdersRefreshToken] = useState(0);
  const requestOrdersRefresh = () => setOrdersRefreshToken((t) => t + 1);
  const [isMuted, setIsMuted] = useState(false);
  const [showRejectPopup, setShowRejectPopup] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [orderToReject, setOrderToReject] = useState(null);
  const [showCancelPopup, setShowCancelPopup] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [orderToCancel, setOrderToCancel] = useState(null);
  const queuedOrderKeysRef = useRef(new Set()); // Track orders already in New Orders queue
  const [restaurantStatus, setRestaurantStatus] = useState({
    isActive: null,
    rejectionReason: null,
    onboarding: null,
    isLoading: true,
  });
  const [isReverifying, setIsReverifying] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState("Offline");
  const isMutedRef = useRef(isMuted);

  const markOrderAsQueued = (orderLike) => {
    for (const k of getQueuedOrderKeys(orderLike)) {
      queuedOrderKeysRef.current.add(k);
    }
  };

  const hasOrderBeenQueued = (orderLike) => {
    const keys = getQueuedOrderKeys(orderLike);
    return keys.some((k) => queuedOrderKeysRef.current.has(k));
  };

  const unmarkOrderAsQueued = (orderLike) => {
    for (const k of getQueuedOrderKeys(orderLike)) {
      queuedOrderKeysRef.current.delete(k);
    }
  };

  const getOrderCountdownSeconds = (orderLike) => {
    const deadlineRaw = orderLike?.acceptanceDeadlineAt;
    if (!deadlineRaw) return 240;
    const deadlineMs = new Date(deadlineRaw).getTime();
    if (!Number.isFinite(deadlineMs)) return 240;
    return Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
  };

  const normalizeIncomingOrder = (orderLike = {}) => ({
    ...orderLike,
    orderId: orderLike.orderId || orderLike.id,
    orderMongoId:
      orderLike.orderMongoId || orderLike._id || orderLike.mongoId,
    items: orderLike.items || [],
    total:
      orderLike.total ??
      orderLike.pricing?.total ??
      orderLike.payment?.amountDue ??
      0,
    note: getRestaurantCookingNote(orderLike),
    paymentMethod:
      orderLike.paymentMethod || orderLike.payment?.method || null,
    payment: orderLike.payment,
    acceptanceWindowSeconds: orderLike.acceptanceWindowSeconds || null,
    acceptanceDeadlineAt: orderLike.acceptanceDeadlineAt || null,
    createdAt: orderLike.createdAt,
    scheduledAt: orderLike.scheduledAt,
    sendCutlery: orderLike.sendCutlery,
  });

  const enqueueNewOrder = (rawOrder, { switchToTab = true } = {}) => {
    if (!rawOrder) return false;

    const scheduledAt = rawOrder.scheduledAt
      ? new Date(rawOrder.scheduledAt).getTime()
      : null;
    const isFutureScheduled =
      scheduledAt && scheduledAt > Date.now() + 30 * 60000;
    if (isFutureScheduled) {
      toast.info(
        `New scheduled order received for ${new Date(scheduledAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
      );
      requestOrdersRefresh();
      return false;
    }

    const order = normalizeIncomingOrder(rawOrder);
    if (hasOrderBeenQueued(order)) return false;

    const remaining = getOrderCountdownSeconds(order);
    if (remaining <= 0) {
      requestOrdersRefresh();
      return false;
    }

    markOrderAsQueued(order);
    setPendingNewOrders((prev) => {
      if (prev.some((o) => isSameQueuedOrder(o, order))) return prev;
      return [order, ...prev];
    });

    if (switchToTab) {
      setActiveFilter((current) => (current === "new" ? current : "new"));
    }
    requestOrdersRefresh();
    return true;
  };

  const removeQueuedOrder = (orderLike) => {
    unmarkOrderAsQueued(orderLike);
    setPendingNewOrders((prev) =>
      prev.filter((o) => !isSameQueuedOrder(o, orderLike)),
    );
  };

  // Restaurant notifications hook for real-time orders
  const { newOrder, clearNewOrder } = useRestaurantNotifications();

  const rejectReasons = [
    "Restaurant is too busy",
    "Item not available",
    "Outside delivery area",
    "Kitchen closing soon",
    "Technical issue",
    "Other reason",
  ];

  // Sync online/offline status for desktop header toggle
  useEffect(() => {
    try {
      const savedStatus = localStorage.getItem(STORAGE_KEY);
      if (savedStatus !== null) {
        setOnlineStatus(JSON.parse(savedStatus) ? "Online" : "Offline");
      }
    } catch {
      // Keep default
    }

    const handleStatusChange = (event) => {
      const isOnline =
        event.detail?.isEffectivelyOnline ?? event.detail?.isOnline ?? false;
      setOnlineStatus(isOnline ? "Online" : "Offline");
    };

    window.addEventListener("restaurantStatusChanged", handleStatusChange);
    return () => {
      window.removeEventListener("restaurantStatusChanged", handleStatusChange);
    };
  }, []);

  // Fetch restaurant verification status
  useEffect(() => {
    const fetchRestaurantStatus = async () => {
      try {
        const response = await restaurantAPI.getCurrentRestaurant();
        const restaurant =
          response?.data?.data?.restaurant || response?.data?.restaurant;
        if (restaurant) {
          setRestaurantStatus({
            isActive: restaurant.isActive,
            rejectionReason: restaurant.rejectionReason || null,
            onboarding: restaurant.onboarding || null,
            isLoading: false,
          });

          try {
            if (restaurant.operationalStatus) {
              setOnlineStatus(
                restaurant.operationalStatus.isEffectivelyOnline
                  ? "Online"
                  : "Offline",
              );
              if (
                typeof restaurant.operationalStatus.isEffectivelyOnline ===
                "boolean"
              ) {
                localStorage.setItem(
                  STORAGE_KEY,
                  JSON.stringify(
                    Boolean(restaurant.operationalStatus.isEffectivelyOnline),
                  ),
                );
              }
            } else {
              const savedStatus = localStorage.getItem(STORAGE_KEY);
              if (savedStatus !== null) {
                setOnlineStatus(JSON.parse(savedStatus) ? "Online" : "Offline");
              } else {
                setOnlineStatus(
                  restaurant.isAcceptingOrders ? "Online" : "Offline",
                );
              }
            }
          } catch {
            setOnlineStatus(
              restaurant.operationalStatus?.isEffectivelyOnline
                ? "Online"
                : restaurant.isAcceptingOrders
                  ? "Online"
                  : "Offline",
            );
          }

          // Keep logged-in users in app flow; onboarding route is guest-only.
        }
      } catch (error) {
        // Only log error if it's not a network/timeout error (backend might be down/slow)
        if (
          error.code !== "ERR_NETWORK" &&
          error.code !== "ECONNABORTED" &&
          !error.message?.includes("timeout")
        ) {
          debugError("Error fetching restaurant status:", error);
        }
        // Set loading to false so UI doesn't stay in loading state
        setRestaurantStatus((prev) => ({ ...prev, isLoading: false }));
      }
    };

    fetchRestaurantStatus();

    // Listen for restaurant profile updates
    const handleProfileRefresh = () => {
      fetchRestaurantStatus();
    };

    window.addEventListener("restaurantProfileRefresh", handleProfileRefresh);

    return () => {
      window.removeEventListener(
        "restaurantProfileRefresh",
        handleProfileRefresh,
      );
    };
  }, [navigate]);

  // Handle reverify (resubmit for approval)
  const handleReverify = async () => {
    try {
      setIsReverifying(true);
      await restaurantAPI.reverify();

      // Refresh restaurant status
      const response = await restaurantAPI.getCurrentRestaurant();
      const restaurant =
        response?.data?.data?.restaurant || response?.data?.restaurant;
      if (restaurant) {
        setRestaurantStatus({
          isActive: restaurant.isActive,
          rejectionReason: restaurant.rejectionReason || null,
          onboarding: restaurant.onboarding || null,
          isLoading: false,
        });
      }

      // Trigger profile refresh event
      window.dispatchEvent(new Event("restaurantProfileRefresh"));

      alert(
        "Restaurant reverified successfully! Verification will be done in 24 hours.",
      );
    } catch (error) {
      // Don't log network/timeout errors (backend might be down)
      if (
        error.code !== "ERR_NETWORK" &&
        error.code !== "ECONNABORTED" &&
        !error.message?.includes("timeout")
      ) {
        debugError("Error reverifying restaurant:", error);
      }

      // Handle 401 Unauthorized errors (token expired/invalid)
      if (error.response?.status === 401) {
        const errorMessage =
          error.response?.data?.message ||
          "Your session has expired. Please login again.";
        alert(errorMessage);
        // The axios interceptor should handle redirecting to login
        // But if it doesn't, we can manually redirect
        if (!error.response?.data?.message?.includes("inactive")) {
          // Only redirect if it's not an "inactive" error (which we handle differently)
          setTimeout(() => {
            window.location.href = "/restaurant/login";
          }, 1500);
        }
      } else {
        // Other errors (400, 500, etc.)
        const errorMessage =
          error.response?.data?.message ||
          "Failed to reverify restaurant. Please try again.";
        alert(errorMessage);
      }
    } finally {
      setIsReverifying(false);
    }
  };

  // Lenis fights the restaurant layout scroll containers on desktop — keep native scroll.
  // (Mobile lists still scroll normally inside the page.)

  // Queue new orders from socket (custom event survives concurrent overwrites of hook state)
  useEffect(() => {
    const handleIncoming = (orderData) => {
      if (!orderData) return;
      enqueueNewOrder(orderData, { switchToTab: true });
      clearNewOrder(orderData);
    };

    const onCustomEvent = (event) => {
      handleIncoming(event?.detail);
    };

    window.addEventListener("restaurant:new_order", onCustomEvent);
    return () => {
      window.removeEventListener("restaurant:new_order", onCustomEvent);
    };
  }, [clearNewOrder]);

  // Fallback if custom event not fired but hook state updates
  useEffect(() => {
    if (!newOrder) return;
    enqueueNewOrder(newOrder, { switchToTab: true });
    clearNewOrder(newOrder);
  }, [newOrder, clearNewOrder]);

  // Handle order cancellation / external accept while in New Orders queue
  useEffect(() => {
    const handleOrderHandledExternally = (event) => {
      const { orderId, orderMongoId, status } = event.detail || {};
      const matching = pendingNewOrders.find((order) =>
        isSameQueuedOrder(order, { orderId, orderMongoId, _id: orderMongoId }),
      );

      if (!matching) return;

      debugLog(
        "?? Queued order was handled externally:",
        orderId || orderMongoId,
        "new status:",
        status,
      );
      removeQueuedOrder(matching);
      stopAlert(matching);
      clearNewOrder(matching);

      if (status?.includes("cancelled") || status?.includes("rejected")) {
        toast.info(`Order #${orderId || ""} was cancelled/rejected`, {
          description: "Request has been removed.",
          duration: 5000,
        });
      } else if (status === "confirmed" || status === "preparing") {
        toast.success(`Order #${orderId || ""} was accepted by Admin`, {
          duration: 5000,
        });
      }
      requestOrdersRefresh();
    };

    window.addEventListener(
      "restaurantOrderCancelled",
      handleOrderHandledExternally,
    );
    window.addEventListener(
      "restaurantOrderHandledExternally",
      handleOrderHandledExternally,
    );
    return () => {
      window.removeEventListener(
        "restaurantOrderCancelled",
        handleOrderHandledExternally,
      );
      window.removeEventListener(
        "restaurantOrderHandledExternally",
        handleOrderHandledExternally,
      );
    };
  }, [pendingNewOrders, clearNewOrder]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Unlock shared restaurant alert audio on first gesture (session owns playback).
  useEffect(() => {
    const unlockAudio = () => {
      void unlockAlertAudio();
    };

    window.addEventListener("pointerdown", unlockAudio, {
      once: true,
      passive: true,
    });
    window.addEventListener("keydown", unlockAudio, { once: true });

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  // Hydrate New Orders queue from API (all confirmed, not only the first)
  useEffect(() => {
    const syncConfirmedOrdersIntoQueue = async () => {
      try {
        const response = await getSharedOrdersResponse();
        if (response.data?.success && response.data.data?.orders) {
          const now = Date.now();
          const apiOrders = response.data.data.orders || [];

          // Drop queued orders only when API shows they left the new/confirmed state
          setPendingNewOrders((prev) =>
            prev.filter((queued) => {
              const match = apiOrders.find((o) => isSameQueuedOrder(o, queued));
              if (!match) return true; // keep — may be newer than shared cache

              const stillNew =
                (match.status === "confirmed" && !match.scheduledAt) ||
                (match.scheduledAt &&
                  (match.status === "created" || match.status === "confirmed") &&
                  new Date(match.scheduledAt).getTime() <= now + 30 * 60000);

              if (!stillNew) {
                unmarkOrderAsQueued(queued);
                stopAlert(queued);
                return false;
              }
              return true;
            }),
          );

          const targetOrders = apiOrders.filter((order) => {
            if (hasOrderBeenQueued(order)) return false;

            const isConfirmed = order.status === "confirmed";
            if (isConfirmed && !order.scheduledAt) return true;

            if (
              order.scheduledAt &&
              (order.status === "created" || order.status === "confirmed")
            ) {
              const scheduledTime = new Date(order.scheduledAt).getTime();
              if (scheduledTime <= now + 30 * 60000) return true;
            }

            return false;
          });

          // Newest first
          const sorted = [...targetOrders].sort((a, b) => {
            const aTime = new Date(a.createdAt || 0).getTime();
            const bTime = new Date(b.createdAt || 0).getTime();
            return bTime - aTime;
          });

          for (const orderToQueue of sorted) {
            const orderForQueue = {
              orderId: orderToQueue.orderId,
              orderMongoId: orderToQueue._id,
              restaurantId: orderToQueue.restaurantId,
              restaurantName: orderToQueue.restaurantName,
              items: orderToQueue.items || [],
              total: orderToQueue.pricing?.total || 0,
              customerAddress: orderToQueue.address,
              status: orderToQueue.status,
              createdAt: orderToQueue.createdAt,
              scheduledAt: orderToQueue.scheduledAt,
              estimatedDeliveryTime: orderToQueue.estimatedDeliveryTime || 30,
              note: getRestaurantCookingNote(orderToQueue),
              sendCutlery: orderToQueue.sendCutlery,
              paymentMethod:
                orderToQueue.paymentMethod ||
                orderToQueue.payment?.method ||
                null,
              payment: orderToQueue.payment,
              acceptanceWindowSeconds:
                orderToQueue.acceptanceWindowSeconds || null,
              acceptanceDeadlineAt: orderToQueue.acceptanceDeadlineAt || null,
            };

            enqueueNewOrder(orderForQueue, { switchToTab: false });
          }
        }
      } catch (error) {
        if (error.response?.status !== 401) {
          debugError("Error syncing new orders queue:", error);
        }
      }
    };

    syncConfirmedOrdersIntoQueue();
    const intervalId = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      syncConfirmedOrdersIntoQueue();
    }, 30000);
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        syncConfirmedOrdersIntoQueue();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Keep mute preference in sync with the shared alert session (no second Audio player).
  useEffect(() => {
    setAlertMuted(isMuted);
  }, [isMuted]);

  // Handle accept order from New Orders card
  const handleAcceptQueuedOrder = async (orderToAccept, prepTime = 11) => {
    if (!orderToAccept?.orderMongoId && !orderToAccept?.orderId) {
      throw new Error("Missing order id");
    }

    // Immediately silence ringing on accept click
    try {
      stopAlert(orderToAccept);
      if (pendingNewOrders.length <= 1) {
        stopAllAlerts();
      }
    } catch {}

    try {
      const orderId = orderToAccept.orderMongoId || orderToAccept.orderId;
      await restaurantAPI.acceptOrder(orderId, prepTime);
      debugLog("? Order accepted:", orderId);
      toast.success("Order accepted successfully");
      stopAlert(orderToAccept);
      if (pendingNewOrders.length <= 1) {
        stopAllAlerts();
      }
      removeQueuedOrder(orderToAccept);
      clearNewOrder(orderToAccept);
      sharedOrdersResponse = null;
      sharedOrdersFetchedAt = 0;
      requestOrdersRefresh();
      setActiveFilter("preparing");
    } catch (error) {
      debugError("? Error accepting order:", error);
      const errorMessage =
        error.response?.data?.message ||
        error.message ||
        "Failed to accept order. Please try again.";

      if (error.response?.status === 400) {
        toast.error(errorMessage);
      } else if (error.response?.status === 404) {
        toast.error(
          "Order not found. It may have been cancelled or already processed.",
        );
        removeQueuedOrder(orderToAccept);
        clearNewOrder(orderToAccept);
      } else {
        toast.error(errorMessage);
      }
      throw error;
    }
  };

  const handleRejectQueuedClick = (order) => {
    // Immediately silence ringing as soon as Decline is clicked
    try {
      stopAlert(order);
      if (pendingNewOrders.length <= 1) {
        stopAllAlerts();
      }
    } catch {}
    setOrderToReject(order);
    setShowRejectPopup(true);
  };

  const handleRejectConfirm = async () => {
    if (!rejectReason || !orderToReject) return;

    try {
      stopAlert(orderToReject);
      if (pendingNewOrders.length <= 1) {
        stopAllAlerts();
      }
    } catch {}

    if (orderToReject?.orderMongoId || orderToReject?.orderId) {
      try {
        const orderId = orderToReject.orderMongoId || orderToReject.orderId;
        await restaurantAPI.rejectOrder(orderId, rejectReason);
        debugLog("? Order rejected:", orderId);
        requestOrdersRefresh();
      } catch (error) {
        debugError("? Error rejecting order:", error);
        alert("Failed to reject order. Please try again.");
        return;
      }
    }

    stopAlert(orderToReject);
    if (pendingNewOrders.length <= 1) {
      stopAllAlerts();
    }
    removeQueuedOrder(orderToReject);
    clearNewOrder(orderToReject);
    setShowRejectPopup(false);
    setOrderToReject(null);
    setRejectReason("");
  };

  const handleRejectCancel = () => {
    setShowRejectPopup(false);
    setOrderToReject(null);
    setRejectReason("");
  };

  const handleQueuedOrderExpired = (order) => {
    // Keep card visible with expired UI; just refresh list in case backend cancelled it.
    requestOrdersRefresh();
  };

  const handlePrintOrder = async (orderToPrint) => {
    if (!orderToPrint) {
      debugWarn("No order data available for PDF generation");
      return;
    }

    try {
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);
      const doc = new jsPDF();

      doc.setFont("helvetica", "bold");
      doc.setFontSize(20);
      doc.text("Order Receipt", 105, 20, { align: "center" });

      doc.setFontSize(14);
      doc.setFont("helvetica", "normal");
      doc.text(orderToPrint.restaurantName || "Restaurant", 105, 30, {
        align: "center",
      });

      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text(`Order ID: ${orderToPrint.orderId || "N/A"}`, 20, 45);
      doc.setFont("helvetica", "normal");

      const orderDate = orderToPrint.createdAt
        ? new Date(orderToPrint.createdAt).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : new Date().toLocaleString("en-GB");

      doc.text(`Date: ${orderDate}`, 20, 52);

      if (orderToPrint.customerAddress) {
        doc.setFont("helvetica", "bold");
        doc.text("Delivery Address:", 20, 62);
        doc.setFont("helvetica", "normal");
        const addressText =
          [
            orderToPrint.customerAddress.street,
            orderToPrint.customerAddress.city,
            orderToPrint.customerAddress.state,
          ]
            .filter(Boolean)
            .join(", ") || "Address not available";
        const addressLines = doc.splitTextToSize(addressText, 170);
        doc.text(addressLines, 20, 69);
      }

      let yPos = 85;
      if (orderToPrint.items && orderToPrint.items.length > 0) {
        doc.setFont("helvetica", "bold");
        doc.text("Items:", 20, yPos);
        yPos += 8;

        const tableData = orderToPrint.items.map((item) => [
          item.name || "Item",
          item.quantity || 1,
          `₹${(item.price || 0).toFixed(2)}`,
          `₹${((item.price || 0) * (item.quantity || 1)).toFixed(2)}`,
        ]);

        autoTable(doc, {
          startY: yPos,
          head: [["Item", "Qty", "Price", "Total"]],
          body: tableData,
          theme: "striped",
          headStyles: {
            fillColor: [0, 0, 0],
            textColor: 255,
            fontStyle: "bold",
          },
          styles: { fontSize: 9 },
        });
      }

      doc.save(`order-${orderToPrint.orderId || "receipt"}.pdf`);
    } catch (error) {
      debugError("Error generating PDF:", error);
      toast.error("Failed to generate receipt");
    }
  };

  // Handle cancel order (for preparing orders)
  const handleCancelClick = (order) => {
    setOrderToCancel(order);
    setShowCancelPopup(true);
  };

  const handleCancelConfirm = async () => {
    if (!cancelReason.trim() || !orderToCancel) return;

    try {
      const orderId = orderToCancel.mongoId || orderToCancel.orderId;
      await restaurantAPI.rejectOrder(orderId, cancelReason.trim());
      toast.success("Order cancelled successfully");
      requestOrdersRefresh();
      setShowCancelPopup(false);
      setOrderToCancel(null);
      setCancelReason("");
    } catch (error) {
      debugError("? Error cancelling order:", error);
      toast.error(error.response?.data?.message || "Failed to cancel order");
    }
  };

  const handleCancelPopupClose = () => {
    setShowCancelPopup(false);
    setOrderToCancel(null);
    setCancelReason("");
  };

  // Toggle mute
  const toggleMute = () => {
    setIsMuted((prev) => {
      const next = !prev;
      setAlertMuted(next);
      return next;
    });
  };

  // Handle swipe gestures with smooth animations
  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    touchEndX.current = e.touches[0].clientX;
    isSwiping.current = false;
  };

  const handleTouchMove = (e) => {
    if (!isSwiping.current) {
      const deltaX = Math.abs(e.touches[0].clientX - touchStartX.current);
      const deltaY = Math.abs(e.touches[0].clientY - touchStartY.current);

      // Determine if this is a horizontal swipe
      if (deltaX > deltaY && deltaX > 10) {
        isSwiping.current = true;
      }
    }

    if (isSwiping.current) {
      touchEndX.current = e.touches[0].clientX;
    }
  };

  const handleTouchEnd = () => {
    if (!isSwiping.current) {
      touchStartX.current = 0;
      touchEndX.current = 0;
      return;
    }

    const swipeDistance = touchStartX.current - touchEndX.current;
    const minSwipeDistance = 50;
    const swipeVelocity = Math.abs(swipeDistance);

    if (swipeVelocity > minSwipeDistance && !isTransitioning) {
      const currentIndex = filterTabs.findIndex(
        (tab) => tab.id === activeFilter,
      );
      let newIndex = currentIndex;

      if (swipeDistance > 0 && currentIndex < filterTabs.length - 1) {
        // Swipe left - go to next filter (right side)
        newIndex = currentIndex + 1;
      } else if (swipeDistance < 0 && currentIndex > 0) {
        // Swipe right - go to previous filter (left side)
        newIndex = currentIndex - 1;
      }

      if (newIndex !== currentIndex) {
        setIsTransitioning(true);

        // Smooth transition with animation
        setTimeout(() => {
          setActiveFilter(filterTabs[newIndex].id);
          scrollToFilter(newIndex);

          // Reset transition state after animation
          setTimeout(() => {
            setIsTransitioning(false);
          }, 300);
        }, 50);
      }
    }

    // Reset touch positions
    touchStartX.current = 0;
    touchEndX.current = 0;
    touchStartY.current = 0;
    isSwiping.current = false;
  };

  // Scroll filter bar to show active button with smooth animation
  const scrollToFilter = (index) => {
    if (filterBarRef.current) {
      const buttons = filterBarRef.current.querySelectorAll("button");
      if (buttons[index]) {
        const button = buttons[index];
        const container = filterBarRef.current;
        const buttonLeft = button.offsetLeft;
        const buttonWidth = button.offsetWidth;
        const containerWidth = container.offsetWidth;
        const scrollLeft = buttonLeft - containerWidth / 2 + buttonWidth / 2;

        container.scrollTo({
          left: scrollLeft,
          behavior: "smooth",
        });
      }
    }
  };

  // Scroll to active filter on change with smooth animation
  useEffect(() => {
    const index = filterTabs.findIndex((tab) => tab.id === activeFilter);
    if (index >= 0) {
      // Use requestAnimationFrame for smoother scrolling
      requestAnimationFrame(() => {
        scrollToFilter(index);
      });
    }
  }, [activeFilter]);

  const handleSelectOrder = (order) => {
    setSelectedOrder(order);
    // Bottom sheet is mobile-only; desktop uses the right detail pane
    const isDesktop =
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 768px)").matches;
    setIsSheetOpen(!isDesktop);
  };

  const renderContent = () => {
    switch (activeFilter) {
      case "new":
        return (
          <div className="pt-4 pb-6">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-base font-semibold text-black">New orders</h2>
              <span className="text-xs text-gray-500">
                {pendingNewOrders.length} pending
              </span>
            </div>
            {pendingNewOrders.length === 0 ? (
              <div className="text-center py-12 text-gray-500 text-sm">
                No new orders waiting for acceptance
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {pendingNewOrders.map((order) => (
                  <NewOrderAcceptCard
                    key={
                      order.orderMongoId ||
                      order.orderId ||
                      order._id ||
                      getOrderAlertKey(order)
                    }
                    order={order}
                    isMuted={isMuted}
                    onToggleMute={toggleMute}
                    onPrint={handlePrintOrder}
                    onAccept={handleAcceptQueuedOrder}
                    onReject={handleRejectQueuedClick}
                    onExpired={handleQueuedOrderExpired}
                  />
                ))}
              </AnimatePresence>
            )}
          </div>
        );
      case "all":
        return (
          <AllOrders
            onSelectOrder={handleSelectOrder}
            onCancel={handleCancelClick}
            searchQuery={searchQuery}
          />
        );
      case "preparing":
        return (
          <PreparingOrders
            onSelectOrder={handleSelectOrder}
            onCancel={handleCancelClick}
            refreshToken={ordersRefreshToken}
            onStatusChanged={requestOrdersRefresh}
            searchQuery={searchQuery}
          />
        );
      case "ready":
        return (
          <ReadyOrders
            onSelectOrder={handleSelectOrder}
            refreshToken={ordersRefreshToken}
            searchQuery={searchQuery}
          />
        );
      case "out-for-delivery":
        return (
          <OutForDeliveryOrders
            onSelectOrder={handleSelectOrder}
            refreshToken={ordersRefreshToken}
            searchQuery={searchQuery}
          />
        );
      case "completed":
        return (
          <CompletedOrders
            onSelectOrder={handleSelectOrder}
            refreshToken={ordersRefreshToken}
            searchQuery={searchQuery}
          />
        );
      case "cancelled":
        return (
          <CancelledOrders
            onSelectOrder={handleSelectOrder}
            refreshToken={ordersRefreshToken}
            searchQuery={searchQuery}
          />
        );
      default:
        return <EmptyState />;
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-gray-100 md:bg-slate-50 md:overflow-hidden overflow-x-hidden">
      {/* Restaurant Navbar - Mobile only */}
      <div className="sticky top-0 z-50 bg-white md:hidden">
        <RestaurantNavbar showNotifications={true} />
      </div>

      {/* Desktop Header */}
      <div className="hidden md:flex items-center justify-between px-6 pt-5 pb-3 bg-white">
        <div>
          <h1 className="text-xl font-bold text-gray-900 tracking-tight">Live orders</h1>
          <p className="text-xs text-gray-500 mt-0.5">Manage incoming and active orders</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/food/restaurant/status")}
            className={`flex items-center gap-1.5 px-3 py-2 border rounded-xl hover:opacity-80 transition-all ${
              onlineStatus === "Online"
                ? "bg-green-50 border-green-100"
                : "bg-gray-50 border-gray-200"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                onlineStatus === "Online" ? "bg-green-500 animate-pulse" : "bg-gray-400"
              }`}
            />
            <span
              className={`text-[12px] font-bold ${
                onlineStatus === "Online" ? "text-green-700" : "text-gray-600"
              }`}
            >
              {onlineStatus}
            </span>
            <ChevronRight
              className={`w-3.5 h-3.5 ${
                onlineStatus === "Online" ? "text-green-500" : "text-gray-400"
              }`}
            />
          </button>
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search orders, menu..."
              className="pl-11 pr-4 py-2.5 bg-white border border-gray-100 rounded-full text-sm w-80 focus:outline-none focus:border-gray-300 shadow-[0_2px_10px_rgba(0,0,0,0.02)] transition-shadow"
            />
          </div>
        </div>
      </div>

      {/* Top Filter Bar */}
      <div className="sticky top-[56px] md:static z-40 pb-2 md:pb-3 bg-white/80 md:bg-white backdrop-blur-md md:backdrop-blur-none border-b border-gray-100/50 md:border-gray-100 md:px-6">
        <div
          ref={filterBarRef}
          className="flex gap-2.5 overflow-x-auto scrollbar-hide px-4 md:px-0 py-3 md:py-2"
          style={{
            scrollbarWidth: "none",
            msOverflowStyle: "none",
            WebkitOverflowScrolling: "touch",
          }}>
          <style>{`
            .scrollbar-hide::-webkit-scrollbar {
              display: none;
            }
          `}</style>
          {filterTabs.map((tab, index) => {
            const isActive = activeFilter === tab.id;

            return (
              <motion.button
                key={tab.id}
                onClick={() => {
                  if (!isTransitioning) {
                    setIsTransitioning(true);
                    setActiveFilter(tab.id);
                    scrollToFilter(index);
                    setTimeout(() => setIsTransitioning(false), 300);
                  }
                }}
                className={`shrink-0 px-4 py-2 md:px-5 md:py-2.5 rounded-xl md:rounded-full font-semibold md:font-medium text-[13px] whitespace-nowrap relative transition-all duration-300 ${isActive ? "text-white md:text-white" : "text-gray-500 hover:text-gray-900 bg-gray-50 md:bg-white md:border md:border-gray-100/50 md:hover:bg-gray-50"
                  }`}
                style={isActive ? { color: "var(--module-theme-color, #2563EB)" } : undefined}
                whileTap={{ scale: 0.96 }}>
                {isActive && (
                  <motion.div
                    layoutId="activeFilterBackground"
                    className="absolute inset-0 rounded-xl md:rounded-full -z-10"
                    style={{
                      backgroundColor: "rgba(var(--module-theme-rgb, 37,99,235), 0.16)",
                      boxShadow: "0 2px 8px rgba(var(--module-theme-rgb, 37,99,235), 0.10)",
                    }}
                    initial={false}
                    transition={{
                      type: "spring",
                      stiffness: 400,
                      damping: 30,
                    }}
                  />
                )}
                <span className="relative z-10">
                  {tab.label}
                  {tab.id === "new" && pendingNewOrders.length > 0
                    ? ` (${pendingNewOrders.length})`
                    : ""}
                </span>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Main Layout Area */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row md:gap-6 px-4 md:px-6 pt-0 md:pt-6 pb-24 md:pb-6 md:overflow-hidden">
        {/* Left Column - Scrollable Content */}
        <div
          ref={contentRef}
          className="flex-1 min-w-0 min-h-0 overflow-y-auto content-scroll md:pr-1"
          style={{ overscrollBehavior: "contain" }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onMouseDown={(e) => {
            mouseStartX.current = e.clientX;
            mouseEndX.current = e.clientX;
            isMouseDown.current = true;
            isSwiping.current = false;
          }}
          onMouseMove={(e) => {
            if (isMouseDown.current) {
              if (!isSwiping.current) {
                const deltaX = Math.abs(e.clientX - mouseStartX.current);
                if (deltaX > 10) {
                  isSwiping.current = true;
                }
              }
              if (isSwiping.current) {
                mouseEndX.current = e.clientX;
              }
            }
          }}
          onMouseUp={() => {
            if (isMouseDown.current && isSwiping.current) {
              const swipeDistance = mouseStartX.current - mouseEndX.current;
              const minSwipeDistance = 50;

              if (
                Math.abs(swipeDistance) > minSwipeDistance &&
                !isTransitioning
              ) {
                const currentIndex = filterTabs.findIndex(
                  (tab) => tab.id === activeFilter,
                );
                let newIndex = currentIndex;

                if (swipeDistance > 0 && currentIndex < filterTabs.length - 1) {
                  newIndex = currentIndex + 1;
                } else if (swipeDistance < 0 && currentIndex > 0) {
                  newIndex = currentIndex - 1;
                }

                if (newIndex !== currentIndex) {
                  setIsTransitioning(true);
                  setTimeout(() => {
                    setActiveFilter(filterTabs[newIndex].id);
                    scrollToFilter(newIndex);
                    setTimeout(() => setIsTransitioning(false), 300);
                  }, 50);
                }
              }
            }

            isMouseDown.current = false;
            isSwiping.current = false;
            mouseStartX.current = 0;
            mouseEndX.current = 0;
          }}
          onMouseLeave={() => {
            isMouseDown.current = false;
            isSwiping.current = false;
          }}>
          <style>{`
            .content-scroll {
              scrollbar-width: thin;
              -ms-overflow-style: auto;
            }
          `}</style>

          {/* Verification Pending Card */}
          {!restaurantStatus.isLoading &&
            !restaurantStatus.isActive &&
            restaurantStatus.onboarding?.completedSteps === 4 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: 0.1 }}
                className={`mt-4 mb-4 rounded-2xl shadow-sm px-6 py-4 ${restaurantStatus.rejectionReason
                  ? "bg-white border border-red-200"
                  : "bg-white border border-yellow-200"
                  }`}>
                {restaurantStatus.rejectionReason ? (
                  <>
                    <div className="flex items-start gap-3 mb-3">
                      <div className="flex-shrink-0 rounded-full p-2 bg-red-100">
                        <AlertCircle className="w-5 h-5 text-red-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-bold text-red-600 mb-2">
                          Denied Verification
                        </h3>
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
                          <p className="text-xs font-semibold text-red-800 mb-2">
                            Reason for Rejection:
                          </p>
                          <div className="text-xs text-red-700 space-y-1">
                            {restaurantStatus.rejectionReason
                              .split("\n")
                              .filter((line) => line.trim()).length > 1 ? (
                              <ul className="space-y-1 list-disc list-inside">
                                {restaurantStatus.rejectionReason
                                  .split("\n")
                                  .map(
                                    (point, index) =>
                                      point.trim() && (
                                        <li key={index}>{point.trim()}</li>
                                      ),
                                  )}
                              </ul>
                            ) : (
                              <p className="text-red-700">
                                {restaurantStatus.rejectionReason}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <p className="text-sm text-gray-700 mb-3">
                      Please correct the above issues and click "Reverify" to
                      resubmit your request for approval.
                    </p>
                    <button
                      onClick={handleReverify}
                      disabled={isReverifying}
                      className="w-full px-6 py-2.5 bg-blue-600 text-white rounded-lg font-semibold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                      {isReverifying ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Submitting...
                        </>
                      ) : (
                        "Reverify"
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-bold text-gray-900 mb-1">
                      Verification Done in 24 Hours
                    </h3>
                    <p className="text-sm text-gray-600">
                      Your account is under verification. You'll be notified once
                      approved.
                    </p>
                  </>
                )}
              </motion.div>
            )}

          <div className="min-h-full flex flex-col">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeFilter}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}>
                {renderContent()}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Desktop Details Pane */}
        <div className="hidden md:flex flex-col bg-white rounded-2xl border border-gray-100/80 shadow-sm overflow-hidden w-[380px] lg:w-[420px] shrink-0 h-full">
          {selectedOrder ? (
            <div className="flex-1 overflow-y-auto p-4 md:p-5 flex flex-col">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div>
                  <p className="text-[13px] font-bold text-black">
                    Order #{selectedOrder.orderId}
                  </p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {selectedOrder.customerName}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {selectedOrder.type}
                    {selectedOrder.tableOrToken
                      ? ` • ${selectedOrder.tableOrToken}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border ${selectedOrder.status === "Ready" || String(selectedOrder.status).toLowerCase() === "ready"
                        ? "border-green-500 text-green-600"
                        : "border-gray-800 text-gray-900"
                      }`}>
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${selectedOrder.status === "Ready" || String(selectedOrder.status).toLowerCase() === "ready"
                          ? "bg-green-500"
                          : "bg-gray-800"
                        }`}
                    />
                    {String(selectedOrder.status || "")
                      .replace(/_/g, " ")
                      .replace(/\b\w/g, (c) => c.toUpperCase())}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {selectedOrder.timePlaced}
                  </span>
                  {(String(selectedOrder.status).toLowerCase() === "preparing" ||
                    String(selectedOrder.status).toLowerCase() === "ready") &&
                    !selectedOrder.deliveryPartnerId && (
                      <div className="mt-1">
                        <ResendNotificationButton
                          orderId={selectedOrder.orderId}
                          mongoId={selectedOrder.mongoId}
                          onSuccess={() => {}}
                        />
                      </div>
                    )}
                </div>
              </div>

              <div className="border-t border-gray-100 my-3" />

              <div className="mb-3">
                <p className="text-[11px] font-semibold text-gray-700 mb-1">Items</p>
                <p className="text-xs text-gray-800 leading-relaxed">
                  {selectedOrder.itemsSummary}
                </p>
              </div>

              {selectedOrder.note?.trim() ? (
                <div className="mb-3 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500 mb-1">
                    Cooking Requests
                  </p>
                  <p className="text-xs text-blue-800 italic">"{selectedOrder.note.trim()}"</p>
                </div>
              ) : null}

              <div className="flex items-center justify-between text-xs text-gray-500 mb-4 bg-gray-50 p-3 rounded-xl border border-gray-100">
                {String(selectedOrder.status).toLowerCase() !== "ready" && selectedOrder.eta && (
                  <span className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase font-bold text-gray-400">ETA</span>
                    <span className="font-bold text-gray-900 text-sm">
                      {selectedOrder.eta}
                    </span>
                  </span>
                )}
                {(() => {
                  const raw = selectedOrder.paymentMethod;
                  const normalized =
                    raw != null ? String(raw).toLowerCase().trim() : "";
                  const isCod = normalized === "cash" || normalized === "cod";
                  return (
                    <span className="flex flex-col gap-1 text-right ml-auto">
                      <span className="text-[10px] uppercase font-bold text-gray-400">Payment</span>
                      <span
                        className={`font-bold text-sm ${isCod ? "text-amber-600" : "text-gray-900"}`}>
                        {isCod ? "Cash on Delivery" : "Paid online"}
                      </span>
                    </span>
                  );
                })()}
              </div>

              {selectedOrder.deliveryPartnerId && typeof selectedOrder.deliveryPartnerId === "object" && (
                <div className="mb-2 pt-3 border-t border-gray-100 mt-auto">
                  <p className="text-[11px] font-bold text-gray-700 mb-2">Delivery Partner details</p>
                  <div className="bg-slate-50 border border-slate-100 rounded-2xl p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-green-50 rounded-full flex items-center justify-center shrink-0">
                        <User className="w-5 h-5 text-green-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-gray-900 truncate">
                          {selectedOrder.deliveryPartnerId.name}
                        </p>
                        {selectedOrder.deliveryPartnerId.rating > 0 && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                            <span className="text-xs font-semibold text-gray-600">
                              {selectedOrder.deliveryPartnerId.rating}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="border-t border-gray-200/60 pt-2 flex flex-col gap-2">
                      {selectedOrder.deliveryPartnerId.phone === "Hidden until photo upload" || !selectedOrder.deliveryPartnerId.phone ? (
                        <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200/50 rounded-xl p-2.5">
                          <Lock className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="text-[11px] font-bold text-amber-800">Phone Hidden</p>
                            <p className="text-[10px] text-amber-700 leading-tight mt-0.5">
                              Phone number will be shown once rider arrives at your shop and uploads photo.
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between bg-green-50 border border-green-200/50 rounded-xl p-2.5">
                          <div className="flex items-start gap-1.5">
                            <Unlock className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-[11px] font-bold text-green-800">Phone Unlocked</p>
                              <p className="text-xs font-bold text-gray-900 mt-0.5">{selectedOrder.deliveryPartnerId.phone}</p>
                            </div>
                          </div>
                          <a
                            href={`tel:${selectedOrder.deliveryPartnerId.phone}`}
                            className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 bg-green-600 text-white text-[11px] font-bold rounded-lg shadow-sm hover:bg-green-700 transition-colors shrink-0"
                          >
                            <Phone className="w-3 h-3" />
                            Call
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center h-full">
              <div className="w-20 h-20 bg-slate-50/80 rounded-full flex items-center justify-center mb-6 border border-gray-100">
                <Inbox className="w-8 h-8 text-slate-300" strokeWidth={1.5} />
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">No order selected</h3>
              <p className="text-sm text-gray-500 max-w-[250px]">
                Select an order from the list to view detailed information, items, and status
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Reject Order Popup */}
      <AnimatePresence>
        {showRejectPopup && (
          <>
            <motion.div
              className="fixed inset-0 z-[10001] bg-black/60 flex items-center justify-center p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={handleRejectCancel}>
              <motion.div
                className="w-[95%] max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="px-4 py-4 border-b border-gray-200">
                  <h3 className="text-lg font-bold text-gray-900">
                    Reject Order {orderToReject?.orderId || "#Order"}
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Please select a reason for rejecting this order
                  </p>
                </div>

                {/* Content */}
                <div className="px-4 py-4 max-h-[60vh] overflow-y-auto">
                  <div className="space-y-2">
                    {rejectReasons.map((reason) => (
                      <button
                        key={reason}
                        onClick={() => setRejectReason(reason)}
                        className={`w-full text-left p-4 rounded-lg border-2 transition-all ${rejectReason === reason
                          ? "border-black bg-black/5"
                          : "border-gray-200 bg-white hover:border-gray-300"
                          }`}>
                        <div className="flex items-center justify-between">
                          <span
                            className={`text-sm font-medium ${rejectReason === reason
                              ? "text-black"
                              : "text-gray-900"
                              }`}>
                            {reason}
                          </span>
                          {rejectReason === reason && (
                            <div className="w-5 h-5 rounded-full bg-black flex items-center justify-center">
                              <svg
                                className="w-3 h-3 text-white"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24">
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={3}
                                  d="M5 13l4 4L19 7"
                                />
                              </svg>
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Footer */}
                <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 flex gap-3">
                  <button
                    onClick={handleRejectCancel}
                    className="flex-1 bg-white border-2 border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm hover:bg-gray-50 transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleRejectConfirm}
                    disabled={!rejectReason}
                    className={`flex-1 py-3 rounded-lg font-semibold text-sm transition-colors ${rejectReason
                      ? "!bg-black !text-white"
                      : "bg-gray-200 text-gray-400 cursor-not-allowed"
                      }`}>
                    Confirm Rejection
                  </button>
                </div>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Cancel Order Popup */}
      <AnimatePresence>
        {showCancelPopup && orderToCancel && (
          <>
            <motion.div
              className="fixed inset-0 z-[10001] bg-black/60 flex items-center justify-center p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={handleCancelPopupClose}>
              <motion.div
                className="w-[95%] max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="px-4 py-4 border-b border-gray-200">
                  <h3 className="text-lg font-bold text-gray-900">
                    Cancel Order {orderToCancel.orderId || "#Order"}
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Please provide a reason for cancelling this order
                  </p>
                </div>

                {/* Content */}
                <div className="px-4 py-4">
                  <div className="space-y-3">
                    {rejectReasons.map((reason) => (
                      <button
                        key={reason}
                        type="button"
                        onClick={() => setCancelReason(reason)}
                        className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors ${cancelReason === reason
                          ? "border-red-500 bg-red-50"
                          : "border-gray-200 hover:border-gray-300"
                          }`}>
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${cancelReason === reason
                              ? "border-red-500 bg-red-500"
                              : "border-gray-300"
                              }`}>
                            {cancelReason === reason && (
                              <svg
                                className="w-3 h-3 text-white"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24">
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={3}
                                  d="M5 13l4 4L19 7"
                                />
                              </svg>
                            )}
                          </div>
                          <span
                            className={`text-sm font-medium ${cancelReason === reason
                              ? "text-red-700"
                              : "text-gray-700"
                              }`}>
                            {reason}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Footer */}
                <div className="px-4 py-4 bg-gray-50 border-t border-gray-200 flex gap-3">
                  <button
                    onClick={handleCancelPopupClose}
                    className="flex-1 bg-white border-2 border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm hover:bg-gray-50 transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleCancelConfirm}
                    disabled={!cancelReason}
                    className={`flex-1 py-3 rounded-lg font-semibold text-sm transition-colors ${cancelReason
                      ? "!bg-red-600 !text-white hover:bg-red-700"
                      : "bg-gray-200 text-gray-400 cursor-not-allowed"
                      }`}>
                    Confirm Cancellation
                  </button>
                </div>
              </motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Bottom Sheet for Order Details (mobile only) */}
      <AnimatePresence>
        {isSheetOpen && selectedOrder && (
          <motion.div
            className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSheetOpen(false)}>
            <motion.div
              className="w-full max-w-md mx-auto max-h-[90vh] overflow-y-auto bg-white rounded-t-3xl p-4 pb-[calc(1.25rem+env(safe-area-inset-bottom)+6rem)] shadow-lg"
              initial={{ y: 80 }}
              animate={{ y: 0 }}
              exit={{ y: 80 }}
              transition={{ duration: 0.25 }}
              onClick={(e) => e.stopPropagation()}>
              {/* Drag handle */}
              <div className="flex justify-center mb-3">
                <div className="h-1 w-10 rounded-full bg-gray-300" />
              </div>

              <div className="flex items-start justify-between gap-2 mb-2">
                <div>
                  <p className="text-sm font-semibold text-black">
                    Order #{selectedOrder.orderId}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {selectedOrder.customerName}
                  </p>
                  <p className="text-[11px] text-gray-500 mt-1">
                    {selectedOrder.type}
                    {selectedOrder.tableOrToken
                      ? ` • ${selectedOrder.tableOrToken}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border ${selectedOrder.status === "Ready"
                      ? "border-green-500 text-green-600"
                      : "border-gray-800 text-gray-900"
                      }`}>
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${selectedOrder.status === "Ready"
                        ? "bg-green-500"
                        : "bg-gray-800"
                        }`}
                    />
                    {selectedOrder.status}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {selectedOrder.timePlaced}
                  </span>
                  {/* Delivery Resend Button - Only for preparing/ready orders with no partner */}
                  {(String(selectedOrder.status).toLowerCase() === "preparing" ||
                    String(selectedOrder.status).toLowerCase() === "ready") &&
                    !selectedOrder.deliveryPartnerId && (
                      <div className="mt-1">
                        <ResendNotificationButton
                          orderId={selectedOrder.orderId}
                          mongoId={selectedOrder.mongoId}
                          onSuccess={() => setIsSheetOpen(false)}
                        />
                      </div>
                    )}
                </div>
              </div>

              <div className="border-t border-gray-100 my-3" />

              <div className="mb-3">
                <p className="text-xs font-medium text-gray-700 mb-1">Items</p>
                <p className="text-xs text-gray-600">
                  {selectedOrder.itemsSummary}
                </p>
              </div>

              {selectedOrder.note?.trim() ? (
                <div className="mb-3 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-blue-500 mb-1">
                    Cooking Requests
                  </p>
                  <p className="text-xs text-blue-800 italic">"{selectedOrder.note.trim()}"</p>
                </div>
              ) : null}

              <div className="flex items-center justify-between text-[11px] text-gray-500 mb-4">
                {/* Hide ETA for ready orders */}
                {selectedOrder.status !== "ready" && selectedOrder.eta && (
                  <span>
                    ETA:{" "}
                    <span className="font-medium text-black">
                      {selectedOrder.eta}
                    </span>
                  </span>
                )}
                {(() => {
                  const raw = selectedOrder.paymentMethod;
                  const normalized =
                    raw != null ? String(raw).toLowerCase().trim() : "";
                  const isCod = normalized === "cash" || normalized === "cod";
                  return (
                    <span>
                      Payment:{" "}
                      <span
                        className={`font-medium ${isCod ? "text-amber-700" : "text-black"}`}>
                        {isCod ? "Cash on Delivery" : "Paid online"}
                      </span>
                    </span>
                  );
                })()}
              </div>

              <button
                className="w-full bg-black text-white py-2.5 rounded-xl text-sm font-medium"
                onClick={() => setIsSheetOpen(false)}>
                Close
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom Navigation - Sticky */}
      <BottomNavOrders />
    </div>
  );
}


// Order Card Component
function OrderCard({
  orderId,
  mongoId,
  status,
  customerName,
  type,
  tableOrToken,
  timePlaced,
  eta,
  itemsSummary,
  note,
  paymentMethod,
  photoUrl,
  photoAlt,
  deliveryPartnerId,
  dispatchStatus,
  onSelect,
  onCancel,
  onMarkReady,
  isMarkingReady = false,
}) {
  const normalizedStatus = String(status || "").toLowerCase();
  const isReady = normalizedStatus === "ready";
  const isPreparing = normalizedStatus === "preparing";
  const statusLabel = String(status || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="w-full bg-white rounded-2xl border border-gray-200 mb-3 overflow-hidden shadow-sm md:hover:border-gray-300 md:transition-colors">
      {/* ── Header strip ── */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2 gap-2">
        {/* Left: order id + customer */}
        <div className="flex items-center gap-2 min-w-0">
          {isPreparing && onCancel && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCancel({ orderId, mongoId, customerName }); }}
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-red-50 text-red-500 active:bg-red-100 transition-colors"
              title="Cancel Order">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="min-w-0">
            <p className="text-sm font-bold text-gray-900 truncate">Order #{orderId}</p>
            <p className="text-[11px] text-gray-500 truncate">{customerName}</p>
          </div>
        </div>

        {/* Right: status badge + time */}
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${
            isReady
              ? "bg-green-50 border border-green-400 text-green-700"
              : isPreparing
                ? "bg-amber-50 border border-amber-400 text-amber-700"
                : "bg-gray-100 border border-gray-300 text-gray-700"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              isReady ? "bg-green-500" : isPreparing ? "bg-amber-500" : "bg-gray-500"
            }`} />
            {statusLabel}
          </span>
          <span className="text-[10px] text-gray-400">{timePlaced}</span>
        </div>
      </div>

      {/* ── Body: photo + items ── */}
      <div
        onClick={() => onSelect?.({ orderId, mongoId, status, customerName, type, tableOrToken, timePlaced, eta, itemsSummary, note, paymentMethod, deliveryPartnerId })}
        className="flex items-center gap-3 px-3 pb-3 cursor-pointer">
        {/* Food image */}
        <div className="w-16 h-16 rounded-xl overflow-hidden bg-gray-100 shrink-0">
          {photoUrl ? (
            <img src={photoUrl} alt={photoAlt} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center px-1">
              <span className="text-[10px] font-medium text-gray-400 text-center leading-tight">{photoAlt}</span>
            </div>
          )}
        </div>

        {/* Items + delivery type */}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-800 line-clamp-2 leading-snug">{itemsSummary}</p>
          <p className="text-[11px] text-gray-400 mt-1">{type}{tableOrToken ? ` · ${tableOrToken}` : ""}</p>
        </div>
      </div>

      {note?.trim() ? (
        <div className="mx-3 mb-3 rounded-xl border border-blue-100 bg-blue-50/90 px-3 py-2.5">
          <p className="text-[10px] font-black uppercase tracking-widest text-blue-500 mb-1">
            Cooking Requests
          </p>
          <p className="text-xs font-semibold text-blue-900 leading-snug line-clamp-3">
            {note.trim()}
          </p>
        </div>
      ) : null}

      {/* ── Footer action row ── */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100 bg-gray-50/60">
        {/* Delivery assignment pill + resend */}
        <div className="flex items-center gap-2 flex-wrap">
          {(isPreparing || isReady || normalizedStatus === "confirmed") && (
            <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold ${
              deliveryPartnerId
                ? "bg-green-100 text-green-700 border border-green-300"
                : "bg-orange-100 text-orange-700 border border-orange-300"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${deliveryPartnerId ? "bg-green-500" : "bg-orange-400"}`} />
              {deliveryPartnerId ? "Assigned" : "Not Assigned"}
            </span>
          )}
          {dispatchStatus !== "accepted" && (isPreparing || isReady || normalizedStatus === "confirmed") && (
            <ResendNotificationButton orderId={orderId} mongoId={mongoId} onSuccess={onSelect} />
          )}
        </div>

        {/* Mark Ready + ETA */}
        <div className="flex items-center gap-2 shrink-0">
          {isPreparing && onMarkReady && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMarkReady({ orderId, mongoId, customerName }); }}
              disabled={isMarkingReady}
              className="h-8 px-3 rounded-lg text-[11px] font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm"
              style={{
                background:
                  "linear-gradient(135deg, rgba(var(--module-theme-rgb,37,99,235),0.96), var(--module-theme-color,#2563EB))",
                boxShadow:
                  "0 8px 16px -10px rgba(var(--module-theme-rgb,37,99,235),0.85)",
              }}>
              {isMarkingReady ? "Marking…" : "Mark Ready"}
            </button>
          )}
          {!isReady && eta && (
            <div className="flex items-baseline gap-0.5">
              <span className="text-[10px] text-gray-400">ETA</span>
              <span className="text-[11px] font-bold text-gray-800">{eta}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Preparing Orders List
function PreparingOrders({
  onSelectOrder,
  onCancel,
  refreshToken = 0,
  onStatusChanged,
  searchQuery = "",
}) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [markingReadyOrderIds, setMarkingReadyOrderIds] = useState({});

  useEffect(() => {
    let isMounted = true;

    const fetchOrders = async () => {
      try {
        // Fetch all orders and filter for 'preparing' status on frontend
        const response = await getSharedOrdersResponse();

        if (!isMounted) return;

        if (response.data?.success && response.data.data?.orders) {
          // Filter orders with 'preparing' status only
          // 'confirmed' orders should only appear in popup notification, not in preparing list
          // After accepting, order status changes to 'preparing' and then appears here
          const preparingOrders = response.data.data.orders.filter(
            (order) => order.status === "preparing",
          );

          const transformedOrders = preparingOrders.map((order) => {
            const initialETA = order.estimatedDeliveryTime || 30; // in minutes
            const preparingTimestamp = order.tracking?.preparing?.timestamp
              ? new Date(order.tracking.preparing.timestamp)
              : new Date(order.createdAt); // Fallback to createdAt if preparing timestamp not available

            return {
              orderId: order.orderId || order._id,
              mongoId: order._id,
              status: order.status || "preparing",
              customerName: order.userId?.name || "Customer",
              type:
                order.deliveryFleet === "standard"
                  ? "Home Delivery"
                  : "Express Delivery",
              tableOrToken: null,
              timePlaced: new Date(order.createdAt).toLocaleTimeString(
                "en-US",
                { hour: "2-digit", minute: "2-digit" },
              ),
              initialETA, // Store initial ETA in minutes
              preparingTimestamp, // Store when order started preparing
              itemsSummary:
                order.items
                  ?.map((item) => `${item.quantity}x ${item.name}`)
                  .join(", ") || "No items",
              photoUrl: order.items?.[0]?.image || null,
              photoAlt: order.items?.[0]?.name || "Order",
              note: getRestaurantCookingNote(order),
              deliveryPartnerId: order.deliveryPartnerId || null,
              dispatchStatus: order.dispatch?.status || null,
              paymentMethod:
                order.paymentMethod || order.payment?.method || null,
            };
          });

          if (isMounted) {
            setOrders(transformedOrders);
            setLoading(false);
          }
        } else {
          if (isMounted) {
            setOrders([]);
            setLoading(false);
          }
        }
      } catch (error) {
        if (!isMounted) return;

        // Don't log network errors, 404, or 401 errors
        // 401 is handled by axios interceptor (token refresh/redirect)
        // 404 means no orders found (normal)
        // ERR_NETWORK means backend is down (expected in dev)
        if (
          error.code !== "ERR_NETWORK" &&
          error.response?.status !== 404 &&
          error.response?.status !== 401
        ) {
          debugError("Error fetching preparing orders:", error);
        }

        if (isMounted) {
          setOrders([]);
          setLoading(false);
        }
      }
    };

    fetchOrders();

    // Update countdown every second
    const countdownIntervalId = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (isMounted) {
        setCurrentTime(new Date());
      }
    }, 1000);
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        if (isMounted) setCurrentTime(new Date());
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isMounted = false;
      if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshToken]); // Re-fetch only when parent requests it

  // Track which orders have been marked as ready to avoid duplicate API calls
  const markedReadyOrdersRef = useRef(new Set());

  // Auto-mark orders as ready when ETA reaches 0
  useEffect(() => {
    if (!currentTime || orders.length === 0) return;

    const checkAndMarkReady = async () => {
      for (const order of orders) {
        const orderKey = order.mongoId || order.orderId;

        // Skip if already marked as ready
        if (markedReadyOrdersRef.current.has(orderKey)) {
          continue;
        }

        // Calculate remaining ETA
        const elapsedMs = currentTime - order.preparingTimestamp;
        const elapsedMinutes = Math.floor(elapsedMs / 60000);
        const remainingMinutes = Math.max(0, order.initialETA - elapsedMinutes);

        // If ETA has reached 0 (or slightly past), mark as ready
        if (remainingMinutes <= 0 && order.status === "preparing") {
          const elapsedSeconds = Math.floor(elapsedMs / 1000);
          const totalETASeconds = order.initialETA * 60;

          // Mark as ready when ETA time has elapsed (with 2 second buffer)
          if (elapsedSeconds >= totalETASeconds - 2) {
            try {
              debugLog(
                `?? Auto-marking order ${order.orderId} as ready (ETA reached 0)`,
              );
              markedReadyOrdersRef.current.add(orderKey); // Mark as processing
              await restaurantAPI.markOrderReady(
                order.mongoId || order.orderId,
              );
              debugLog(`? Order ${order.orderId} marked as ready`);
              onStatusChanged?.();
              // Order will be removed from preparing list on next fetch
            } catch (error) {
              const status = error.response?.status;
              const msg = (
                error.response?.data?.message ||
                error.message ||
                ""
              ).toLowerCase();
              // If 400 and message says order cannot be marked ready (e.g. already ready),
              // treat as idempotent - backend cron or another client already marked it.
              if (
                status === 400 &&
                (msg.includes("cannot be marked as ready") ||
                  msg.includes("current status"))
              ) {
                // Keep in markedReadyOrdersRef so we don't retry; order will disappear on next fetch
              } else {
                debugError(
                  `? Failed to auto-mark order ${order.orderId} as ready:`,
                  error,
                );
                markedReadyOrdersRef.current.delete(orderKey);
              }
              // Don't show error toast - it will retry on next check (for non-idempotent errors)
            }
          }
        }
      }
    };

    // Check every 2 seconds for orders that need to be marked ready
    const readyCheckInterval = setInterval(checkAndMarkReady, 2000);

    return () => {
      clearInterval(readyCheckInterval);
    };
  }, [currentTime, orders]);

  // Clear marked orders when orders list changes (orders moved to ready)
  useEffect(() => {
    const currentOrderKeys = new Set(orders.map((o) => o.mongoId || o.orderId));
    // Remove keys that are no longer in the preparing orders list
    for (const key of markedReadyOrdersRef.current) {
      if (!currentOrderKeys.has(key)) {
        markedReadyOrdersRef.current.delete(key);
      }
    }
  }, [orders]);

  const handleMarkReady = async ({ orderId, mongoId, customerName }) => {
    const orderKey = mongoId || orderId;
    if (!orderKey || markingReadyOrderIds[orderKey]) return;

    try {
      setMarkingReadyOrderIds((prev) => ({ ...prev, [orderKey]: true }));
      await restaurantAPI.markOrderReady(orderKey);
      setOrders((prev) =>
        prev.filter((order) => (order.mongoId || order.orderId) !== orderKey),
      );
      toast.success(
        `Order ${orderId} marked ready${customerName ? ` for ${customerName}` : ""}`,
      );
      onStatusChanged?.();
    } catch (error) {
      const status = error.response?.status;
      const message =
        error.response?.data?.message || "Failed to mark order as ready";
      if (
        status === 400 &&
        String(message).toLowerCase().includes("current status")
      ) {
        setOrders((prev) =>
          prev.filter((order) => (order.mongoId || order.orderId) !== orderKey),
        );
        toast.success(`Order ${orderId} is already ready`);
        onStatusChanged?.();
      } else {
        toast.error(message);
      }
    } finally {
      setMarkingReadyOrderIds((prev) => {
        const next = { ...prev };
        delete next[orderKey];
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="pt-4 pb-6">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold text-black">
            Preparing orders
          </h2>
          <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
        </div>
        <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="pt-4 pb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-semibold text-black">Preparing orders</h2>
        <span className="text-xs text-gray-500">{orders.filter((o) => matchesOrderSearch(o, searchQuery)).length} active</span>
      </div>
      {orders.filter((o) => matchesOrderSearch(o, searchQuery)).length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm">
          No orders in preparation
        </div>
      ) : (
        <div>
          {orders.filter((o) => matchesOrderSearch(o, searchQuery)).map((order) => {
            // Calculate remaining ETA (countdown)
            const elapsedMs = currentTime - order.preparingTimestamp;
            const elapsedMinutes = Math.floor(elapsedMs / 60000);
            const remainingMinutes = Math.max(
              0,
              order.initialETA - elapsedMinutes,
            );

            // Format ETA display
            let etaDisplay = "";
            if (remainingMinutes <= 0) {
              const remainingSeconds = Math.max(
                0,
                Math.floor(order.initialETA * 60 - elapsedMs / 1000),
              );
              if (remainingSeconds > 0) {
                etaDisplay = `${remainingSeconds} secs`;
              } else {
                etaDisplay = "0 mins";
              }
            } else {
              etaDisplay = `${remainingMinutes} mins`;
            }

            return (
              <OrderCard
                key={order.orderId || order.mongoId}
                {...order}
                eta={etaDisplay}
                onSelect={onSelectOrder}
                onCancel={onCancel}
                onMarkReady={handleMarkReady}
                isMarkingReady={Boolean(
                  markingReadyOrderIds[order.mongoId || order.orderId],
                )}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// Ready Orders List
function ReadyOrders({ onSelectOrder, refreshToken = 0, searchQuery = "" }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const fetchOrders = async () => {
      try {
        // Fetch all orders and filter for 'ready' status on frontend
        const response = await getSharedOrdersResponse();

        if (!isMounted) return;

        if (response.data?.success && response.data.data?.orders) {
          // Filter orders with 'ready' status
          const readyOrders = response.data.data.orders.filter(
            (order) => order.status === "ready",
          );

          const transformedOrders = readyOrders.map((order) => ({
            orderId: order.orderId || order._id,
            mongoId: order._id,
            status: order.status || "ready",
            customerName: order.userId?.name || "Customer",
            type:
              order.deliveryFleet === "standard"
                ? "Home Delivery"
                : "Express Delivery",
            tableOrToken: null,
            timePlaced: new Date(order.createdAt).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            eta: null, // Don't show ETA for ready orders
            itemsSummary:
              order.items
                ?.map((item) => `${item.quantity}x ${item.name}`)
                .join(", ") || "No items",
            photoUrl: order.items?.[0]?.image || null,
            photoAlt: order.items?.[0]?.name || "Order",
            note: getRestaurantCookingNote(order),
            paymentMethod: order.paymentMethod || order.payment?.method || null,
            deliveryPartnerId: order.deliveryPartnerId || null,
            dispatchStatus: order.dispatch?.status || null,
          }));

          if (isMounted) {
            setOrders(transformedOrders);
            setLoading(false);
          }
        } else {
          if (isMounted) {
            setOrders([]);
            setLoading(false);
          }
        }
      } catch (error) {
        if (!isMounted) return;

        // Don't log network errors repeatedly - they're expected if backend is down
        if (error.code !== "ERR_NETWORK" && error.response?.status !== 404) {
          debugError("Error fetching ready orders:", error);
        }

        if (isMounted) {
          setOrders([]);
          setLoading(false);
        }
      }
    };

    fetchOrders();

    return () => {
      isMounted = false;
    };
  }, [refreshToken]); // Re-fetch only when parent requests it

  if (loading) {
    return (
      <div className="pt-4 pb-6">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold text-black">
            Ready for pickup
          </h2>
          <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
        </div>
        <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="pt-4 pb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-semibold text-black">Ready for pickup</h2>
        <span className="text-xs text-gray-500">{orders.filter((o) => matchesOrderSearch(o, searchQuery)).length} active</span>
      </div>
      {orders.filter((o) => matchesOrderSearch(o, searchQuery)).length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm">
          No orders ready for pickup
        </div>
      ) : (
        <div>
          {orders.filter((o) => matchesOrderSearch(o, searchQuery)).map((order) => (
            <OrderCard
              key={order.orderId || order.mongoId}
              {...order}
              onSelect={onSelectOrder}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Out for Delivery Orders List
const OutForDeliveryOrders = ({ onSelectOrder, refreshToken = 0, searchQuery = "" }) => {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const fetchOrders = async () => {
      try {
        // Fetch all orders and filter for 'out_for_delivery' status on frontend
        const response = await getSharedOrdersResponse();

        if (!isMounted) return;

        if (response.data?.success && response.data.data?.orders) {
          // Filter orders with 'out_for_delivery' status
          const outForDeliveryOrders = response.data.data.orders.filter(
            (order) => order.status === "out_for_delivery",
          );

          const transformedOrders = outForDeliveryOrders.map((order) => ({
            orderId: order.orderId || order._id,
            mongoId: order._id,
            status: order.status || "out_for_delivery",
            customerName: order.userId?.name || "Customer",
            type:
              order.deliveryFleet === "standard"
                ? "Home Delivery"
                : "Express Delivery",
            tableOrToken: null,
            timePlaced: new Date(order.createdAt).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            eta: null,
            itemsSummary:
              order.items
                ?.map((item) => `${item.quantity}x ${item.name}`)
                .join(", ") || "No items",
            photoUrl: order.items?.[0]?.image || null,
            photoAlt: order.items?.[0]?.name || "Order",
            note: getRestaurantCookingNote(order),
            paymentMethod: order.paymentMethod || order.payment?.method || null,
            deliveryPartnerId: order.deliveryPartnerId || null,
            dispatchStatus: order.dispatch?.status || null,
          }));

          if (isMounted) {
            setOrders(transformedOrders);
            setLoading(false);
          }
        } else {
          if (isMounted) {
            setOrders([]);
            setLoading(false);
          }
        }
      } catch (error) {
        if (!isMounted) return;

        // Don't log network errors repeatedly - they're expected if backend is down
        if (error.code !== "ERR_NETWORK" && error.response?.status !== 404) {
          debugError("Error fetching out for delivery orders:", error);
        }

        if (isMounted) {
          setOrders([]);
          setLoading(false);
        }
      }
    };

    fetchOrders();

    return () => {
      isMounted = false;
    };
  }, [refreshToken]); // Re-fetch only when parent requests it

  if (loading) {
    return (
      <div className="pt-4 pb-6">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold text-black">
            Out for delivery
          </h2>
          <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
        </div>
        <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="pt-4 pb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-semibold text-black">Out for delivery</h2>
        <span className="text-xs text-gray-500">{orders.filter((o) => matchesOrderSearch(o, searchQuery)).length} active</span>
      </div>
      {orders.filter((o) => matchesOrderSearch(o, searchQuery)).length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm">
          No orders out for delivery
        </div>
      ) : (
        <div>
          {orders.filter((o) => matchesOrderSearch(o, searchQuery)).map((order) => (
            <OrderCard
              key={order.orderId || order.mongoId}
              {...order}
              onSelect={onSelectOrder}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Empty State Component
function EmptyState({ message = "Temporarily closed" }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] py-12">
      {/* Store Illustration */}
      <div className="mb-6">
        <svg
          width="200"
          height="200"
          viewBox="0 0 200 200"
          className="text-gray-300"
          fill="none"
          xmlns="http://www.w3.org/2000/svg">
          {/* Storefront */}
          <rect
            x="40"
            y="80"
            width="120"
            height="80"
            stroke="currentColor"
            strokeWidth="2"
            fill="white"
          />
          {/* Awning */}
          <path
            d="M30 80 L100 50 L170 80"
            stroke="currentColor"
            strokeWidth="2"
            fill="white"
          />
          {/* Doors */}
          <rect
            x="60"
            y="100"
            width="30"
            height="60"
            stroke="currentColor"
            strokeWidth="2"
            fill="white"
          />
          <rect
            x="110"
            y="100"
            width="30"
            height="60"
            stroke="currentColor"
            strokeWidth="2"
            fill="white"
          />
          {/* Laptop */}
          <rect
            x="70"
            y="140"
            width="40"
            height="25"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="white"
          />
          <text
            x="85"
            y="155"
            fontSize="8"
            fill="currentColor"
            textAnchor="middle">
            CLOSED
          </text>
          {/* Sign */}
          <rect
            x="80"
            y="170"
            width="40"
            height="20"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="white"
          />
        </svg>
      </div>

      {/* Message */}
      <h2 className="text-lg font-semibold text-gray-600 mb-4 text-center">
        {message}
      </h2>

      {/* View Status Button */}
      <button className="bg-black text-white px-6 py-3 rounded-lg font-medium hover:bg-gray-800 transition-colors">
        View status
      </button>
    </div>
  );
}
