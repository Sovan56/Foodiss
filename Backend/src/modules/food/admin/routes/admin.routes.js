import express from 'express';
import { AuthError } from '../../../../core/auth/errors.js';
import * as adminController from '../controllers/admin.controller.js';
import * as incentiveController from '../controllers/incentive.controller.js';
import * as foodApprovalController from '../controllers/foodApproval.controller.js';
import * as addonsApprovalController from '../controllers/addonsApproval.controller.js';
import * as businessSettingsController from '../controllers/businessSettings.controller.js';
import * as feedbackExperienceController from '../controllers/feedbackExperience.controller.js';
import * as notificationBroadcastController from '../controllers/notificationBroadcast.controller.js';
import * as diningAdminController from '../../dining/controllers/diningAdmin.controller.js';
import * as orderController from '../../orders/controllers/order.controller.js';
import { listUserCartsAdminController, getUserCartPricingAdminController } from '../controllers/userCartAdmin.controller.js';
import { getAdminPageController, upsertAdminPageController } from '../controllers/pageContent.controller.js';
import { upload } from '../../../../middleware/upload.js';
import {
    downloadBulkMenuTemplateController,
    uploadAdminBulkMenuController,
} from '../../restaurant/controllers/bulkUpload.controller.js';
import { FoodAdmin } from '../../../../core/admin/admin.model.js';
import { requireAdminPermission, requireAnyAdminPermission } from '../../../../core/roles/adminPermission.middleware.js';

const router = express.Router();

// ----- Public Business Settings (No Admin Required) -----
router.get('/business-settings/public', businessSettingsController.getBusinessSettings);
router.get('/power-scanning/public', businessSettingsController.getPowerScanningSettings);
router.get('/fee-settings/public', adminController.getFeeSettings);
router.get('/restaurant-onboarding-settings/public', adminController.getRestaurantOnboardingSettings);
router.get('/feature-settings/public', adminController.getFeatureSettings);


const requireAdmin = (req, _res, next) => {
    const user = req.user;
    if (!user || user.role !== 'ADMIN') {
        return next(new AuthError('Admin access required'));
    }
    return next();
};

router.use(requireAdmin);
router.use(async (req, _res, next) => {
    try {
        const admin = await FoodAdmin.findById(req.user?.userId)
            .select('adminType permissions isActive isDeleted')
            .lean();
        req.adminAccess = admin;
        return next();
    } catch (error) {
        return next(error);
    }
});

const resolveSectionFromRequest = (path = '', method = '') => {
    if (path.startsWith('/sub-admins')) return 'sub_admin_management';
    if (path === '/customers' && String(method).toUpperCase() === 'GET') return null;
    if (path.startsWith('/customers') || path.startsWith('/support-tickets')) return 'customer_management';
    if (path === '/zones' && String(method).toUpperCase() === 'GET') return null;
    if (/^\/zones\/[^/]+$/.test(path) && String(method).toUpperCase() === 'GET') return null;
    if (path === '/restaurants' && String(method).toUpperCase() === 'GET') return null;
    if (/^\/restaurants\/[^/]+$/.test(path) && String(method).toUpperCase() === 'GET') return null;
    if (/^\/restaurants\/[^/]+\/analytics$/.test(path) && String(method).toUpperCase() === 'GET') return null;
    if (path === '/orders' && String(method).toUpperCase() === 'GET') return null;
    if (path === '/orders/user-carts' && String(method).toUpperCase() === 'GET') return null;
    if (
        path.startsWith('/restaurants') ||
        path.startsWith('/restaurant-settings') ||
        path.startsWith('/restaurant-onboarding-settings') ||
        path.startsWith('/zones')
    ) return 'restaurant_management';
    if (path.startsWith('/categories') || path.startsWith('/addons') || path.startsWith('/foods')) return 'food_management';
    if (path.startsWith('/offers')) return 'promotions_management';
    if (path.startsWith('/orders') || path.startsWith('/order-detect-delivery')) return 'order_management';
    if (path.startsWith('/delivery')) return 'delivery_management';
    if (path.startsWith('/withdrawals')) return 'transaction_management';
    if (path.startsWith('/feedback-experiences')) return 'report_management';
    if (path.startsWith('/reports')) return 'report_management';
    if (path.startsWith('/feature-settings') || path.startsWith('/business-settings') || path.startsWith('/power-scanning') || path.startsWith('/notifications')) return 'system_settings';
    if (path.startsWith('/pages-social-media')) return 'pages_social_media';
    if (path.startsWith('/sidebar-badges') || path.startsWith('/dashboard-stats')) return 'dashboard';
    return null;
};

const resolveActionByMethod = (method = '') => {
    const normalized = String(method).toUpperCase();
    if (normalized === 'GET') return 'view';
    if (normalized === 'POST') return 'create';
    if (normalized === 'DELETE') return 'delete';
    if (normalized === 'PATCH' || normalized === 'PUT') return 'edit';
    return 'view';
};

router.use((req, res, next) => {
    const section = resolveSectionFromRequest(req.path, req.method);
    if (!section) return next();
    const action = resolveActionByMethod(req.method);
    return requireAdminPermission(section, action)(req, res, next);
});

router.use('/sub-admins', requireAdminPermission('sub_admin_management', 'view'));
router.use(
    '/customers',
    requireAnyAdminPermission([
        { section: 'customer_management', action: 'view' },
        { section: 'report_management', action: 'view' },
    ])
);
router.use('/support-tickets', requireAdminPermission('customer_management', 'view'));
router.use('/restaurant-settings', requireAdminPermission('restaurant_management', 'view'));
router.use('/restaurant-onboarding-settings', requireAdminPermission('restaurant_management', 'view'));
router.use('/categories', requireAdminPermission('food_management', 'view'));
router.use('/addons', requireAdminPermission('food_management', 'view'));
router.use('/foods', requireAdminPermission('food_management', 'view'));
router.use('/offers', requireAdminPermission('promotions_management', 'view'));
router.use('/delivery', requireAdminPermission('delivery_management', 'view'));
router.use('/withdrawals', requireAdminPermission('transaction_management', 'view'));
router.use('/reports', requireAdminPermission('report_management', 'view'));
router.use('/feature-settings', requireAdminPermission('system_settings', 'view'));
router.use('/business-settings', requireAdminPermission('system_settings', 'view'));
router.use('/power-scanning', requireAdminPermission('system_settings', 'view'));
router.use('/notifications', requireAdminPermission('system_settings', 'view'));
router.use('/pages-social-media', requireAdminPermission('pages_social_media', 'view'));
router.use('/sidebar-badges', requireAdminPermission('dashboard', 'view'));

router.post('/sub-admins', requireAdminPermission('sub_admin_management', 'create'), adminController.createSubAdmin);
router.get('/sub-admins', adminController.listSubAdmins);
router.get('/sub-admins/permission-catalog', adminController.getAdminPermissionCatalog);
router.get('/sub-admins/:id', adminController.getSubAdminDetails);
router.patch('/sub-admins/:id', requireAdminPermission('sub_admin_management', 'edit'), adminController.updateSubAdminProfile);
router.patch('/sub-admins/:id/permissions', requireAdminPermission('sub_admin_management', 'edit'), adminController.updateSubAdminPermissions);
router.patch('/sub-admins/:id/status', requireAdminPermission('sub_admin_management', 'edit'), adminController.updateSubAdminStatus);
router.delete('/sub-admins/:id', requireAdminPermission('sub_admin_management', 'delete'), adminController.deleteSubAdmin);

// ----- Broadcast Notifications -----
router.post('/notifications/broadcast', notificationBroadcastController.createBroadcastNotificationController);
router.get('/notifications/broadcast', notificationBroadcastController.getBroadcastNotificationsController);
router.delete('/notifications/broadcast/:id', notificationBroadcastController.deleteBroadcastNotificationController);

// ----- Customers -----
router.get(
    '/customers',
    requireAnyAdminPermission([
        { section: 'customer_management', action: 'view' },
        { section: 'report_management', action: 'view' },
    ]),
    adminController.getCustomers
);
router.get('/customers/:id', adminController.getCustomerById);
router.patch('/customers/:id/status', adminController.updateCustomerStatus);

// ----- Safety / Emergency Reports -----
router.get('/safety-emergency-reports', adminController.getSafetyEmergencyReports);
router.put('/safety-emergency-reports/:id/status', adminController.updateSafetyEmergencyStatus);
router.put('/safety-emergency-reports/:id/priority', adminController.updateSafetyEmergencyPriority);
router.delete('/safety-emergency-reports/:id', adminController.deleteSafetyEmergencyReport);

// ----- Support Tickets (users) -----
router.get('/support-tickets/stats', adminController.getFoodSupportTicketStatsController);
router.get('/support-tickets', adminController.getSupportTicketsController);
router.patch('/support-tickets/:id', adminController.updateSupportTicketController);
router.get('/global-search', adminController.globalSearch);
router.get('/restaurants/complaints/stats', adminController.getRestaurantComplaintStatsController);
router.get('/restaurants/complaints', adminController.getRestaurantComplaints);
router.patch('/restaurants/complaints/:id', adminController.updateRestaurantComplaint);

// ----- Restaurants -----
router.get(
    '/restaurants',
    requireAnyAdminPermission([
        { section: 'restaurant_management', action: 'view' },
        { section: 'point_of_sale', action: 'view' },
        { section: 'report_management', action: 'view' },
        { section: 'banner_management', action: 'view' },
    ]),
    adminController.getRestaurants
);
router.get('/dashboard-stats', adminController.getDashboardStats);
router.get('/reports/restaurants', adminController.getRestaurantReport);
router.get('/reports/transactions', adminController.getTransactionReport);
router.get('/reports/tax', adminController.getTaxReport);
router.get('/reports/tax/:id', adminController.getTaxReportDetail);
router.get('/restaurants/pending', adminController.getPendingRestaurants);
router.get('/restaurants/unregistered', adminController.getUnregisteredRestaurants);
router.delete('/restaurants/unregistered/:id', adminController.deleteUnregisteredRestaurant);
router.get('/restaurant-onboarding-settings', adminController.getRestaurantOnboardingSettings);
router.patch('/restaurant-onboarding-settings', adminController.updateRestaurantOnboardingSettings);
router.get('/feature-settings', adminController.getFeatureSettings);
router.patch('/feature-settings/:key', adminController.updateFeatureSetting);
router.get('/restaurants/reviews', adminController.getRestaurantReviews);
router.get(
    '/restaurants/:id',
    requireAnyAdminPermission([
        { section: 'restaurant_management', action: 'view' },
        { section: 'point_of_sale', action: 'view' },
        { section: 'report_management', action: 'view' },
        { section: 'banner_management', action: 'view' },
    ]),
    adminController.getRestaurantById
);
router.get(
    '/restaurants/:id/analytics',
    requireAnyAdminPermission([
        { section: 'restaurant_management', action: 'view' },
        { section: 'point_of_sale', action: 'view' },
        { section: 'report_management', action: 'view' },
        { section: 'banner_management', action: 'view' },
    ]),
    adminController.getRestaurantAnalytics
);
router.get('/restaurants/:id/menu', adminController.getRestaurantMenuById);
router.post('/restaurants', adminController.createRestaurant);
router.patch('/restaurants/:id', adminController.updateRestaurantById);
router.patch('/restaurants/:id/status', adminController.updateRestaurantStatus);
router.patch('/restaurants/:id/location', adminController.updateRestaurantLocation);
router.patch('/restaurants/:id/menu', adminController.updateRestaurantMenuById);
router.patch('/restaurants/:id/approve', adminController.approveRestaurant);
router.patch('/restaurants/:id/reject', adminController.rejectRestaurant);
router.delete('/restaurants/:id', adminController.deleteRestaurant);


// ----- Restaurant Commission -----
router.get('/restaurant-commissions/bootstrap', adminController.getRestaurantCommissionBootstrap);
router.get('/restaurant-commissions', adminController.getRestaurantCommissions);
router.post('/restaurant-commissions', adminController.createRestaurantCommission);
router.get('/restaurant-commissions/:id', adminController.getRestaurantCommissionById);
router.patch('/restaurant-commissions/:id', adminController.updateRestaurantCommission);
router.delete('/restaurant-commissions/:id', adminController.deleteRestaurantCommission);
router.patch('/restaurant-commissions/:id/toggle', adminController.toggleRestaurantCommissionStatus);

// ----- Categories -----
router.get('/categories', adminController.getCategories);
router.post('/categories', adminController.createCategory);
router.patch('/categories/:id', adminController.updateCategory);
router.delete('/categories/:id', adminController.deleteCategory);
router.patch('/categories/:id/toggle', adminController.toggleCategoryStatus);
router.patch('/categories/:id/approve', adminController.approveCategory);
router.patch('/categories/:id/reject', adminController.rejectCategory);
router.patch('/categories/:id/make-global', adminController.makeCategoryGlobal);

// ----- Restaurant Add-ons Approval -----
router.get('/addons', addonsApprovalController.getRestaurantAddons);
router.patch('/addons/:id', addonsApprovalController.updateRestaurantAddon);
router.patch('/addons/:id/approve', addonsApprovalController.approveRestaurantAddon);
router.patch('/addons/:id/reject', addonsApprovalController.rejectRestaurantAddon);

// ----- Foods -----
router.get('/foods', adminController.getFoods);
router.get('/foods/bulk-upload/template', downloadBulkMenuTemplateController);
router.post('/foods/bulk-upload', upload.single('file'), uploadAdminBulkMenuController);
router.post('/foods/bulk-delete', adminController.bulkDeleteFoodItems);
router.post('/foods', adminController.createFood);
router.patch('/foods/:id', adminController.updateFood);
router.delete('/foods/:id', adminController.deleteFood);
// Food approval queue (pending items created by restaurants)
router.get('/foods/pending-approvals', foodApprovalController.getPendingFoodApprovals);
router.patch('/foods/:id/approve', foodApprovalController.approveFoodItemController);
router.patch('/foods/:id/reject', foodApprovalController.rejectFoodItemController);
router.post('/foods/bulk-approve', adminController.bulkApproveFoodItems);


// ----- Offers & Coupons -----
router.get('/offers', adminController.getAllOffers);
router.post('/offers', adminController.createAdminOffer);
router.patch('/offers/:id/cart-visibility', adminController.updateAdminOfferCartVisibility);
router.delete('/offers/:id', adminController.deleteAdminOffer);

// ----- Feedback Experience (Admin) -----
router.get('/feedback-experiences', feedbackExperienceController.getFeedbackExperiences);
router.delete('/feedback-experiences/:id', feedbackExperienceController.deleteFeedbackExperience);

// ----- Fee Settings -----
router.get('/fee-settings', adminController.getFeeSettings);
router.put('/fee-settings', adminController.createOrUpdateFeeSettings);

// ----- Referral Settings -----
router.get('/referral-settings', adminController.getReferralSettings);
router.put('/referral-settings', adminController.createOrUpdateReferralSettings);

// ----- Business Settings -----
router.get('/business-settings/public', businessSettingsController.getBusinessSettings); // Public endpoint
router.get('/business-settings', businessSettingsController.getBusinessSettings);
router.patch('/business-settings', upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'favicon', maxCount: 1 },
    { name: 'restaurantLogo', maxCount: 1 },
    { name: 'restaurantFavicon', maxCount: 1 },
    { name: 'deliveryLogo', maxCount: 1 },
    { name: 'deliveryFavicon', maxCount: 1 }
]), businessSettingsController.updateBusinessSettings);
router.get('/power-scanning', businessSettingsController.getPowerScanningSettings);
router.patch('/power-scanning', businessSettingsController.updatePowerScanningSettings);

// ----- Restaurant Settings -----
router.get('/restaurant-settings/order-acceptance', businessSettingsController.getOrderAcceptanceSettings);
router.patch('/restaurant-settings/order-acceptance', businessSettingsController.updateOrderAcceptanceSettings);

// ----- Delivery Cash Limit -----
router.get('/delivery-cash-limit', adminController.getDeliveryCashLimit);
router.patch('/delivery-cash-limit', adminController.updateDeliveryCashLimit);

// ----- Delivery Emergency Help -----
router.get('/delivery-emergency-help', adminController.getEmergencyHelp);
router.put('/delivery-emergency-help', adminController.createOrUpdateEmergencyHelp);

// ----- Withdrawals (admin) -----
router.get('/withdrawals', adminController.getWithdrawals);
router.patch('/withdrawals/:id', adminController.updateWithdrawalStatus);
router.get('/delivery/withdrawals', adminController.getDeliveryWithdrawals);
router.patch('/delivery/withdrawals/:id', adminController.updateDeliveryWithdrawalStatus);
router.get('/delivery/cash-limit-settlements', adminController.getCashLimitSettlements);

// ----- Delivery partners & general -----
router.get('/delivery/join-requests', adminController.getDeliveryJoinRequests);
router.get('/delivery/wallets', adminController.getDeliveryWallets);
router.patch('/delivery/wallets', adminController.updateDeliveryBoyWallet);
router.get('/delivery/bonus-transactions', adminController.getDeliveryPartnerBonusTransactions);
router.get('/delivery/earnings', adminController.getDeliveryEarnings);
router.post('/delivery/bonus', adminController.addDeliveryPartnerBonus);
router.get('/delivery/commission-rules', adminController.getDeliveryCommissionRules);
router.post('/delivery/commission-rules', adminController.createDeliveryCommissionRule);
router.patch('/delivery/commission-rules/:id', adminController.updateDeliveryCommissionRule);
router.delete('/delivery/commission-rules/:id', adminController.deleteDeliveryCommissionRule);
router.patch('/delivery/commission-rules/:id/status', adminController.toggleDeliveryCommissionRuleStatus);
router.get('/delivery/reviews', adminController.getDeliverymanReviews);
router.get('/contact-messages', adminController.getContactMessages);
router.get('/delivery/earning-addons', adminController.getEarningAddons);
router.post('/delivery/earning-addons', adminController.createEarningAddon);
router.patch('/delivery/earning-addons/:id', adminController.updateEarningAddon);
router.delete('/delivery/earning-addons/:id', adminController.deleteEarningAddon);
router.patch('/delivery/earning-addons/:id/status', adminController.toggleEarningAddonStatus);
router.get('/delivery/zone-surges', adminController.getZoneDeliverySurges);
router.post('/delivery/zone-surges', adminController.createZoneDeliverySurge);
router.patch('/delivery/zone-surges/:id', adminController.updateZoneDeliverySurge);
router.delete('/delivery/zone-surges/:id', adminController.deleteZoneDeliverySurge);
router.patch('/delivery/zone-surges/:id/status', adminController.toggleZoneDeliverySurgeStatus);
router.get('/delivery/earning-addon-history', adminController.getEarningAddonHistory);
router.post('/delivery/earning-addon-history/:id/credit', adminController.creditEarningToWallet);
router.post('/delivery/earning-addon-history/:id/cancel', adminController.cancelEarningAddonHistory);
router.post('/delivery/earning-addon-completions/check', adminController.checkEarningAddonCompletions);
router.get('/delivery/support-tickets/stats', adminController.getSupportTicketStats);
router.get('/delivery/support-tickets', adminController.getSupportTickets);
router.patch('/delivery/support-tickets/:id', adminController.updateSupportTicket);
router.get('/delivery/order-emergency-requests', adminController.getOrderEmergencyRequests);
router.get('/delivery/order-emergency-requests/:id', adminController.getOrderEmergencyRequest);
router.patch('/delivery/order-emergency-requests/:id', adminController.updateOrderEmergencyRequest);
router.patch(
    '/delivery/order-emergency-requests/:id/deassign-resend',
    requireAdminPermission('delivery_management', 'edit'),
    adminController.deassignAndResendOrderEmergencyRequest
);
router.get('/delivery/partners', adminController.getDeliveryPartners);
router.get('/delivery/:id', adminController.getDeliveryPartnerById);
router.patch('/delivery/:id/approve', adminController.approveDeliveryPartner);
router.patch('/delivery/:id/reject', adminController.rejectDeliveryPartner);
router.delete('/delivery/:id', adminController.deleteDeliveryPartner);

// ----- Zones -----
router.get(
    '/zones',
    requireAnyAdminPermission([
        { section: 'dashboard', action: 'view' },
        { section: 'restaurant_management', action: 'view' },
        { section: 'point_of_sale', action: 'view' },
        { section: 'food_management', action: 'view' },
        { section: 'delivery_management', action: 'view' },
        { section: 'report_management', action: 'view' },
    ]),
    adminController.getZones
);
router.get(
    '/zones/:id',
    requireAnyAdminPermission([
        { section: 'dashboard', action: 'view' },
        { section: 'restaurant_management', action: 'view' },
        { section: 'point_of_sale', action: 'view' },
        { section: 'food_management', action: 'view' },
        { section: 'delivery_management', action: 'view' },
        { section: 'report_management', action: 'view' },
    ]),
    adminController.getZoneById
);
router.post('/zones', adminController.createZone);
router.patch('/zones/:id', adminController.updateZone);
router.delete('/zones/:id', adminController.deleteZone);

// ----- Dining -----
router.get('/dining/categories', diningAdminController.getDiningCategories);
router.post('/dining/categories', diningAdminController.createDiningCategory);
router.patch('/dining/categories/:id', diningAdminController.updateDiningCategory);
router.delete('/dining/categories/:id', diningAdminController.deleteDiningCategory);
router.get('/dining/restaurants', diningAdminController.getDiningRestaurants);
router.patch('/dining/restaurants/:restaurantId', diningAdminController.updateDiningRestaurant);

// ----- Orders -----
router.get(
    '/orders',
    requireAnyAdminPermission([
        { section: 'order_management', action: 'view' },
        { section: 'report_management', action: 'view' },
    ]),
    orderController.listOrdersAdminController
);
router.get(
    '/orders/user-carts',
    requireAnyAdminPermission([
        { section: 'order_management', action: 'view' },
        { section: 'report_management', action: 'view' },
    ]),
    listUserCartsAdminController
);
router.get(
    '/orders/user-carts/:cartId/pricing',
    requireAnyAdminPermission([
        { section: 'order_management', action: 'view' },
        { section: 'report_management', action: 'view' },
    ]),
    getUserCartPricingAdminController
);
router.get('/orders/:orderId', orderController.getOrderByIdAdminController);
router.patch('/orders/:orderId/accept', orderController.acceptOrderAdminController);
router.patch('/orders/:orderId/reject', orderController.rejectOrderAdminController);
router.patch(
    '/orders/:orderId/mark-delivered',
    requireAdminPermission('order_management', 'edit'),
    orderController.markOrderDeliveredAdminController
);
router.patch(
    '/orders/:orderId/deassign-resend',
    requireAdminPermission('order_management', 'edit'),
    adminController.deassignAndResendOrder
);
router.post(
    '/orders/:orderId/resend-notification',
    requireAdminPermission('order_management', 'edit'),
    orderController.resendDeliveryNotificationAdminController
);
router.post('/orders/:orderId/refund', orderController.processRefundAdminController);
router.delete('/orders/:orderId', orderController.deleteOrderAdminController);

// ----- CMS Pages (About + legal) -----
router.get('/pages-social-media/:key', getAdminPageController);
router.put('/pages-social-media/:key', upsertAdminPageController);

router.get('/sidebar-badges', adminController.getSidebarBadges);
router.get('/notifications/fssai-expired', adminController.getExpiredFssaiNotifications);

// Incentive Routes
router.get('/incentive/settings/rain', requireAdminPermission('system_settings', 'view'), incentiveController.getRainIncentiveSettings);
router.put('/incentive/settings/rain', requireAdminPermission('system_settings', 'edit'), incentiveController.updateRainIncentiveSettings);
router.get('/incentive/slabs', requireAdminPermission('system_settings', 'view'), incentiveController.getIncentiveSlabs);
router.post('/incentive/slabs', requireAdminPermission('system_settings', 'edit'), incentiveController.createIncentiveSlab);
router.put('/incentive/slabs/:id', requireAdminPermission('system_settings', 'edit'), incentiveController.updateIncentiveSlab);
router.delete('/incentive/slabs/:id', requireAdminPermission('system_settings', 'edit'), incentiveController.deleteIncentiveSlab);

export default router;
