import mongoose from 'mongoose';

// --- Rain Incentive Settings ---
const rainIncentiveSettingsSchema = new mongoose.Schema(
    {
        key: { type: String, default: 'global', unique: true },
        isEnabled: { type: Boolean, default: false },
        incentiveType: { type: String, enum: ['FIXED', 'PERCENTAGE'], default: 'FIXED' },
        incentiveValue: { type: Number, default: 0 },
        updatedBy: {
            adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodAdmin' },
            at: { type: Date }
        }
    },
    { collection: 'food_rain_incentive_settings', timestamps: true }
);

export const FoodRainIncentiveSettings = mongoose.model('FoodRainIncentiveSettings', rainIncentiveSettingsSchema);


// --- Weekly Incentive Slab ---
const deliveryIncentiveSlabSchema = new mongoose.Schema(
    {
        slabName: { type: String, required: true, trim: true },
        deliveriesRequired: { type: Number, required: true, min: 1 },
        extraIncentive: { type: Number, required: true, min: 0 },
        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodAdmin' },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodAdmin' }
    },
    { collection: 'food_delivery_incentive_slabs', timestamps: true }
);

// Prevent duplicate slabs with same deliveriesRequired
deliveryIncentiveSlabSchema.index({ deliveriesRequired: 1 }, { unique: true });

export const FoodDeliveryIncentiveSlab = mongoose.model('FoodDeliveryIncentiveSlab', deliveryIncentiveSlabSchema);
