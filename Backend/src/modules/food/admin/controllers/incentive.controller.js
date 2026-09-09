import { FoodRainIncentiveSettings, FoodDeliveryIncentiveSlab } from '../models/foodDeliveryIncentive.model.js';
import { sendResponse, sendError } from '../../../../utils/response.js';

// --- Rain Incentive Settings ---

export const getRainIncentiveSettings = async (req, res, next) => {
    try {
        let settings = await FoodRainIncentiveSettings.findOne({ key: 'global' });
        if (!settings) {
            settings = await FoodRainIncentiveSettings.create({ key: 'global' });
        }
        return sendResponse(res, 200, 'Rain incentive settings retrieved successfully', settings);
    } catch (err) {
        next(err);
    }
};

export const updateRainIncentiveSettings = async (req, res, next) => {
    try {
        const { isEnabled, incentiveType, incentiveValue } = req.body;
        const updateData = {
            isEnabled: Boolean(isEnabled),
            incentiveType: ['FIXED', 'PERCENTAGE'].includes(incentiveType) ? incentiveType : 'FIXED',
            incentiveValue: Number(incentiveValue) || 0,
            updatedBy: {
                adminId: req.user._id,
                at: new Date()
            }
        };

        const settings = await FoodRainIncentiveSettings.findOneAndUpdate(
            { key: 'global' },
            updateData,
            { new: true, upsert: true }
        );
        return sendResponse(res, 200, 'Rain incentive settings updated successfully', settings);
    } catch (err) {
        next(err);
    }
};


// --- Weekly Incentive Slabs ---

export const getIncentiveSlabs = async (req, res, next) => {
    try {
        const slabs = await FoodDeliveryIncentiveSlab.find().sort({ deliveriesRequired: 1 });
        return sendResponse(res, 200, 'Incentive slabs retrieved successfully', slabs);
    } catch (err) {
        next(err);
    }
};

export const createIncentiveSlab = async (req, res, next) => {
    try {
        const { slabName, deliveriesRequired, extraIncentive, isActive } = req.body;
        const slab = await FoodDeliveryIncentiveSlab.create({
            slabName,
            deliveriesRequired: Number(deliveriesRequired),
            extraIncentive: Number(extraIncentive),
            isActive: Boolean(isActive),
            createdBy: req.user._id,
            updatedBy: req.user._id
        });
        return sendResponse(res, 201, 'Incentive slab created successfully', slab);
    } catch (err) {
        if (err.code === 11000) {
            return sendError(res, 400, 'A slab with this deliveriesRequired value already exists');
        }
        next(err);
    }
};

export const updateIncentiveSlab = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { slabName, deliveriesRequired, extraIncentive, isActive } = req.body;
        
        const slab = await FoodDeliveryIncentiveSlab.findByIdAndUpdate(
            id,
            {
                slabName,
                deliveriesRequired: Number(deliveriesRequired),
                extraIncentive: Number(extraIncentive),
                isActive: isActive !== undefined ? Boolean(isActive) : true,
                updatedBy: req.user._id
            },
            { new: true, runValidators: true }
        );

        if (!slab) {
            return sendError(res, 404, 'Incentive slab not found');
        }

        return sendResponse(res, 200, 'Incentive slab updated successfully', slab);
    } catch (err) {
        if (err.code === 11000) {
            return sendError(res, 400, 'A slab with this deliveriesRequired value already exists');
        }
        next(err);
    }
};

export const deleteIncentiveSlab = async (req, res, next) => {
    try {
        const { id } = req.params;
        const slab = await FoodDeliveryIncentiveSlab.findByIdAndDelete(id);
        
        if (!slab) {
            return sendError(res, 404, 'Incentive slab not found');
        }

        return sendResponse(res, 200, 'Incentive slab deleted successfully', null);
    } catch (err) {
        next(err);
    }
};
