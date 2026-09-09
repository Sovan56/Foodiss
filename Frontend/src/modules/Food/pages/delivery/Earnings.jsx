import React, { useState, useEffect, useCallback } from "react";
import { deliveryAPI } from "@/services/api/index.js";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, TrendingUp, CloudRain, Target, ChevronRight,
  Bike, Trophy, CheckCircle, Lock
} from "lucide-react";

const formatCurrency = (amount) => `₹${(Number(amount) || 0).toFixed(0)}`;

export default function Earnings() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState("week");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  const fetchEarnings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await deliveryAPI.getEarnings({ period });
      if (res.data?.data) {
        setData(res.data.data);
      }
    } catch (error) {
      console.error("Failed to fetch earnings:", error);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchEarnings();
  }, [fetchEarnings]);

  const summary = data?.summary || {};
  const slabProgress = data?.slabProgress;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-br from-emerald-600 to-teal-700 text-white">
        <div className="flex items-center gap-3 px-4 py-4">
          <button onClick={() => navigate(-1)} className="p-1">
            <ArrowLeft size={22} />
          </button>
          <h1 className="text-lg font-semibold">My Earnings</h1>
        </div>

        {/* Period Tabs */}
        <div className="flex gap-1 px-4 pb-2">
          {[
            { key: "today", label: "Today" },
            { key: "week", label: "This Week" },
            { key: "month", label: "This Month" },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setPeriod(tab.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                period === tab.key
                  ? "bg-white text-emerald-700"
                  : "bg-white/20 text-white/80"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Total Earnings Card */}
        <div className="px-4 py-6 text-center">
          {loading ? (
            <div className="animate-pulse">
              <div className="h-10 bg-white/20 rounded-lg w-40 mx-auto mb-2"></div>
              <div className="h-4 bg-white/20 rounded w-24 mx-auto"></div>
            </div>
          ) : (
            <>
              <p className="text-4xl font-bold">{formatCurrency(summary.totalEarnings)}</p>
              <p className="text-white/70 text-sm mt-1">
                {summary.totalOrders || 0} deliveries completed
              </p>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4 space-y-4 -mt-2">
        {/* Earnings Breakdown */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Breakdown</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
                  <Bike size={16} className="text-emerald-600" />
                </div>
                <span className="text-gray-700 font-medium">Delivery Earnings</span>
              </div>
              <span className="font-semibold text-gray-900">{formatCurrency(summary.orderEarning)}</span>
            </div>
            {(summary.rainIncentive > 0) && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                    <CloudRain size={16} className="text-blue-600" />
                  </div>
                  <span className="text-gray-700 font-medium">Rain Bonus</span>
                </div>
                <span className="font-semibold text-blue-600">+{formatCurrency(summary.rainIncentive)}</span>
              </div>
            )}
            {(summary.incentive > 0 && summary.incentive !== summary.rainIncentive) && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
                    <Trophy size={16} className="text-amber-600" />
                  </div>
                  <span className="text-gray-700 font-medium">Other Incentives</span>
                </div>
                <span className="font-semibold text-amber-600">+{formatCurrency(summary.incentive)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Weekly Slab Progress */}
        {slabProgress && slabProgress.slabs && slabProgress.slabs.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-4 border-b border-gray-50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Target size={18} className="text-purple-600" />
                  <h3 className="font-semibold text-gray-900">Weekly Targets</h3>
                </div>
                <div className="bg-purple-100 text-purple-700 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                  {slabProgress.weeklyDeliveries} Done
                </div>
              </div>
            </div>
            <div className="p-4 space-y-3">
              {slabProgress.slabs.map((slab) => (
                <div
                  key={slab._id}
                  className={`p-3 rounded-xl border transition-all ${
                    slab.isUnlocked
                      ? "bg-emerald-50 border-emerald-200"
                      : "bg-gray-50 border-gray-100"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {slab.isUnlocked ? (
                        <CheckCircle size={16} className="text-emerald-600" />
                      ) : (
                        <Lock size={16} className="text-gray-400" />
                      )}
                      <span className={`font-medium text-sm ${slab.isUnlocked ? "text-emerald-700" : "text-gray-700"}`}>
                        {slab.slabName}
                      </span>
                    </div>
                    <span className={`text-sm font-semibold ${slab.isUnlocked ? "text-emerald-600" : "text-gray-500"}`}>
                      +{formatCurrency(slab.extraIncentive)}
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full transition-all duration-500 ${
                        slab.isUnlocked ? "bg-emerald-500" : "bg-purple-500"
                      }`}
                      style={{ width: `${slab.progress}%` }}
                    ></div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {slab.isUnlocked
                      ? "✅ Unlocked!"
                      : `${slabProgress.weeklyDeliveries}/${slab.deliveriesRequired} deliveries`}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Links */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <button
            onClick={() => navigate("/food/delivery/trip-history")}
            className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center">
                <TrendingUp size={16} className="text-gray-600" />
              </div>
              <span className="text-gray-700 font-medium">Trip History</span>
            </div>
            <ChevronRight size={18} className="text-gray-400" />
          </button>
        </div>
      </div>
    </div>
  );
}
