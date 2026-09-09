import React, { useState, useEffect } from "react";
import { adminAPI } from "../../../../../services/api/index.js";
import { Settings, CloudRain, Trash2, Plus, Edit2, CheckCircle } from "lucide-react";
import { toast } from "sonner";

export default function DeliveryIncentives() {
  const [rainSettings, setRainSettings] = useState({ isEnabled: false, incentiveType: "FIXED", incentiveValue: 0 });
  const [slabs, setSlabs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingRain, setSavingRain] = useState(false);
  
  const [isSlabModalOpen, setIsSlabModalOpen] = useState(false);
  const [currentSlab, setCurrentSlab] = useState(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [rainRes, slabsRes] = await Promise.all([
        adminAPI.getRainIncentiveSettings(),
        adminAPI.getIncentiveSlabs()
      ]);
      if (rainRes.data?.data) {
        setRainSettings(rainRes.data.data);
      }
      if (slabsRes.data?.data) {
        setSlabs(slabsRes.data.data);
      }
    } catch (error) {
      toast.error("Failed to fetch incentive settings");
    } finally {
      setLoading(false);
    }
  };

  const handleRainSave = async () => {
    setSavingRain(true);
    try {
      await adminAPI.updateRainIncentiveSettings({
        isEnabled: rainSettings.isEnabled,
        incentiveType: rainSettings.incentiveType,
        incentiveValue: Number(rainSettings.incentiveValue)
      });
      toast.success("Rain settings updated successfully");
    } catch (error) {
      toast.error("Failed to update rain settings");
    } finally {
      setSavingRain(false);
    }
  };

  const handleSlabSubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = {
      slabName: formData.get("slabName"),
      deliveriesRequired: Number(formData.get("deliveriesRequired")),
      extraIncentive: Number(formData.get("extraIncentive")),
      isActive: formData.get("isActive") === "on",
    };

    try {
      if (currentSlab) {
        await adminAPI.updateIncentiveSlab(currentSlab._id, data);
        toast.success("Slab updated");
      } else {
        await adminAPI.createIncentiveSlab(data);
        toast.success("Slab created");
      }
      setIsSlabModalOpen(false);
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to save slab");
    }
  };

  const handleDeleteSlab = async (id) => {
    if (!window.confirm("Are you sure you want to delete this slab?")) return;
    try {
      await adminAPI.deleteIncentiveSlab(id);
      toast.success("Slab deleted");
      fetchData();
    } catch (error) {
      toast.error("Failed to delete slab");
    }
  };

  if (loading) return <div className="p-8">Loading...</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Delivery Incentives & Rain</h1>
        <p className="text-gray-500">Manage extra earnings for delivery partners during rain and weekly milestones.</p>
      </div>

      {/* Rain Incentives Section */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 border-b border-gray-100 bg-blue-50/50 flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg text-blue-600">
            <CloudRain size={24} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Rain Detection Incentive</h2>
            <p className="text-sm text-gray-500">Automatically adds bonus to delivery earning if it rains.</p>
          </div>
        </div>
        
        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between p-4 rounded-xl border border-gray-100 bg-gray-50">
            <div>
              <p className="font-medium text-gray-900">Enable Rain Detection</p>
              <p className="text-sm text-gray-500">Toggle on to check weather during order placement</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                className="sr-only peer"
                checked={rainSettings.isEnabled}
                onChange={(e) => setRainSettings({ ...rainSettings, isEnabled: e.target.checked })}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {rainSettings.isEnabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Incentive Type</label>
                <select 
                  value={rainSettings.incentiveType}
                  onChange={(e) => setRainSettings({ ...rainSettings, incentiveType: e.target.value })}
                  className="w-full border-gray-300 rounded-lg shadow-sm focus:border-blue-500 focus:ring-blue-500 h-10 px-3 border"
                >
                  <option value="FIXED">Fixed Amount (₹)</option>
                  <option value="PERCENTAGE">Percentage of Base Fee (%)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Incentive Value</label>
                <div className="relative rounded-lg shadow-sm">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <span className="text-gray-500 sm:text-sm">
                      {rainSettings.incentiveType === 'FIXED' ? '₹' : '%'}
                    </span>
                  </div>
                  <input 
                    type="number"
                    value={rainSettings.incentiveValue}
                    onChange={(e) => setRainSettings({ ...rainSettings, incentiveValue: e.target.value })}
                    className="w-full pl-8 border-gray-300 rounded-lg focus:border-blue-500 focus:ring-blue-500 h-10 border"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button 
              onClick={handleRainSave}
              disabled={savingRain}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
            >
              {savingRain ? 'Saving...' : 'Save Rain Settings'}
            </button>
          </div>
        </div>
      </div>

      {/* Weekly Slabs Section */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-6 border-b border-gray-100 bg-emerald-50/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-100 rounded-lg text-emerald-600">
              <Settings size={24} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Weekly Delivery Slabs</h2>
              <p className="text-sm text-gray-500">Reward riders for hitting delivery targets every week.</p>
            </div>
          </div>
          <button 
            onClick={() => {
              setCurrentSlab(null);
              setIsSlabModalOpen(true);
            }}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors"
          >
            <Plus size={18} />
            Add Slab
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="p-4 font-medium text-gray-500">Slab Name</th>
                <th className="p-4 font-medium text-gray-500">Required Deliveries (Weekly)</th>
                <th className="p-4 font-medium text-gray-500">Extra Incentive (₹)</th>
                <th className="p-4 font-medium text-gray-500">Status</th>
                <th className="p-4 font-medium text-gray-500 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {slabs.map((slab) => (
                <tr key={slab._id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="p-4 font-medium text-gray-900">{slab.slabName}</td>
                  <td className="p-4 text-gray-600">{slab.deliveriesRequired} Deliveries</td>
                  <td className="p-4 text-emerald-600 font-semibold">+₹{slab.extraIncentive}</td>
                  <td className="p-4">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                      slab.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {slab.isActive && <CheckCircle size={14} />}
                      {slab.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button 
                        onClick={() => {
                          setCurrentSlab(slab);
                          setIsSlabModalOpen(true);
                        }}
                        className="p-2 text-gray-400 hover:text-blue-600 bg-gray-50 hover:bg-blue-50 rounded-lg transition-colors"
                      >
                        <Edit2 size={16} />
                      </button>
                      <button 
                        onClick={() => handleDeleteSlab(slab._id)}
                        className="p-2 text-gray-400 hover:text-red-600 bg-gray-50 hover:bg-red-50 rounded-lg transition-colors"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {slabs.length === 0 && (
                <tr>
                  <td colSpan="5" className="p-8 text-center text-gray-500">
                    No slabs configured yet. Click "Add Slab" to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Slab Modal */}
      {isSlabModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-xl">
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">
                {currentSlab ? 'Edit Slab' : 'Create New Slab'}
              </h3>
              <button 
                onClick={() => setIsSlabModalOpen(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSlabSubmit} className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Slab Name</label>
                <input 
                  type="text" 
                  name="slabName" 
                  required
                  defaultValue={currentSlab?.slabName || ""}
                  placeholder="e.g. Bronze, Silver, Goal 1"
                  className="w-full border-gray-300 rounded-lg focus:border-emerald-500 focus:ring-emerald-500 h-10 px-3 border"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Weekly Deliveries Required</label>
                <input 
                  type="number" 
                  name="deliveriesRequired"
                  required 
                  min="1"
                  defaultValue={currentSlab?.deliveriesRequired || ""}
                  className="w-full border-gray-300 rounded-lg focus:border-emerald-500 focus:ring-emerald-500 h-10 px-3 border"
                />
                <p className="text-xs text-gray-500 mt-1">Exact number of deliveries needed in a week (Mon-Sun) to unlock this reward.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Extra Incentive Amount (₹)</label>
                <input 
                  type="number" 
                  name="extraIncentive" 
                  required
                  min="0"
                  defaultValue={currentSlab?.extraIncentive || ""}
                  className="w-full border-gray-300 rounded-lg focus:border-emerald-500 focus:ring-emerald-500 h-10 px-3 border"
                />
              </div>
              <div className="flex items-center gap-3 pt-2">
                <input 
                  type="checkbox" 
                  name="isActive" 
                  id="isActive"
                  defaultChecked={currentSlab ? currentSlab.isActive : true}
                  className="w-4 h-4 text-emerald-600 border-gray-300 rounded focus:ring-emerald-500"
                />
                <label htmlFor="isActive" className="text-sm font-medium text-gray-700">Active</label>
              </div>
              
              <div className="flex items-center justify-end gap-3 pt-6">
                <button 
                  type="button"
                  onClick={() => setIsSlabModalOpen(false)}
                  className="px-4 py-2 text-gray-700 font-medium hover:bg-gray-50 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg transition-colors"
                >
                  {currentSlab ? 'Save Changes' : 'Create Slab'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
