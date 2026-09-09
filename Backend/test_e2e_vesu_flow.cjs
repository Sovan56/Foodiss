const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const API_BASE = 'http://localhost:5000/api/v1/food';
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'secret';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/foodiss';

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function logStep(stepNum, title) {
    console.log(`\n${colors.bright}${colors.cyan}========================================================================${colors.reset}`);
    console.log(`${colors.bright}${colors.yellow}>>> [STEP ${stepNum}]: ${title}${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}========================================================================${colors.reset}`);
}

function logSuccess(msg, data) {
    console.log(`${colors.green}✔ ${msg}${colors.reset}`);
    if (data) console.log(colors.dim, JSON.stringify(data, null, 2), colors.reset);
}

function logInfo(msg) {
    console.log(`${colors.blue}ℹ ${msg}${colors.reset}`);
}

function logWarn(msg) {
    console.log(`${colors.yellow}⚠ ${msg}${colors.reset}`);
}

function logError(msg, err) {
    console.error(`${colors.red}✖ ${msg}${colors.reset}`);
    if (err && err.response) {
        console.error(colors.red, `Status: ${err.response.status}`, err.response.data, colors.reset);
    } else if (err) {
        console.error(colors.red, err.message || err, colors.reset);
    }
}

async function runTest() {
    console.log(`\n${colors.bright}${colors.magenta}************************************************************************`);
    console.log(`   END-TO-END WORKFLOW INTEGRATION TEST: SURAT RESTRO 2 (VESU, SURAT)   `);
    console.log(`************************************************************************${colors.reset}\n`);

    logInfo(`Connecting to MongoDB at: ${MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
    await mongoose.connect(MONGO_URI);
    logSuccess('MongoDB connected successfully');

    const db = mongoose.connection.db;

    // -------------------------------------------------------------
    // PHASE 1: PREREQUISITES & DATA PREPARATION
    // -------------------------------------------------------------
    logStep(1, 'Data Setup & Verification (Restaurant, Menu, Rider, Customer, Admin)');

    // 1.1 Ensure Cash Limit is sufficient for COD
    const cashLimitCol = db.collection('food_delivery_cash_limits');
    await cashLimitCol.updateOne(
        { isActive: true },
        { $set: { deliveryCashLimit: 10000, isActive: true, updatedAt: new Date() } },
        { upsert: true }
    );
    logSuccess('Configured Global Delivery Cash Limit (₹10,000) for COD orders');

    // 1.2 Setup "Surat Restro 2"
    const restaurantCol = db.collection('food_restaurants');
    const targetRestroId = new mongoose.Types.ObjectId('6a9c00f12bc2e21633e1bf41');
    let restaurant = await restaurantCol.findOne({ _id: targetRestroId });

    if (!restaurant) {
        // Fallback: search by name
        restaurant = await restaurantCol.findOne({
            $or: [{ restaurantName: /Surat Restro 2/i }, { name: /Surat Restro 2/i }]
        });
    }

    if (!restaurant) {
        throw new Error('Restaurant "Surat Restro 2" not found in food_restaurants collection!');
    }

    const restroId = restaurant._id;
    const restroName = restaurant.restaurantName || restaurant.name || 'Surat Restro 2';
    logInfo(`Found Restaurant: "${restroName}" (ID: ${restroId})`);

    // Ensure restaurant is active, open, and accepting orders in Vesu
    await restaurantCol.updateOne(
        { _id: restroId },
        {
            $set: {
                status: 'approved',
                isActive: true,
                isAcceptingOrders: true,
                area: 'Vesu',
                city: 'Surat',
                openingTime: '00:00',
                closingTime: '23:59',
                openDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
                location: {
                    type: 'Point',
                    coordinates: [72.78101, 21.141979] // Vesu, Surat
                }
            }
        }
    );
    logSuccess(`Updated "${restroName}" to Approved, Active 24/7, Location: [72.78101, 21.141979] (Vesu)`);

    // 1.3 Ensure at least 1 approved food item exists for Surat Restro 2
    const foodItemsCol = db.collection('food_items');
    let foodItem = await foodItemsCol.findOne({ restaurantId: restroId, isAvailable: true, approvalStatus: 'approved' });

    if (!foodItem) {
        const insertRes = await foodItemsCol.insertOne({
            restaurantId: restroId,
            name: 'Surati Special Paneer Thali',
            description: 'Authentic Surati paneer with butter rotis, dal, rice, and sweet.',
            price: 250,
            otherPrice: 320,
            foodType: 'Veg',
            isVeg: true,
            isAvailable: true,
            approvalStatus: 'approved',
            createdAt: new Date(),
            updatedAt: new Date()
        });
        foodItem = await foodItemsCol.findOne({ _id: insertRes.insertedId });
        logSuccess(`Created active food item: "${foodItem.name}" - ₹${foodItem.price}`);
    } else {
        logSuccess(`Existing food item found: "${foodItem.name}" - ₹${foodItem.price} (ID: ${foodItem._id})`);
    }

    // 1.4 Setup Delivery Partner (Rider) in Vesu
    const ridersCol = db.collection('food_delivery_partners');
    let rider = await ridersCol.findOne({ phone: '9100000001' });

    if (!rider) {
        const riderRes = await ridersCol.insertOne({
            name: 'Vesu Express Rider',
            fullName: 'Vesu Express Rider',
            phone: '9100000001',
            status: 'approved',
            availabilityStatus: 'online',
            isEligibleForOrders: true,
            cashBalance: 0,
            lastLocation: { type: 'Point', coordinates: [72.78200, 21.14300] },
            lastLat: 21.14300,
            lastLng: 72.78200,
            lastLocationAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date()
        });
        rider = await ridersCol.findOne({ _id: riderRes.insertedId });
        logSuccess(`Created Delivery Partner: "${rider.name}" (ID: ${rider._id})`);
    } else {
        await ridersCol.updateOne(
            { _id: rider._id },
            {
                $set: {
                    status: 'approved',
                    availabilityStatus: 'online',
                    isEligibleForOrders: true,
                    lastLocation: { type: 'Point', coordinates: [72.78200, 21.14300] },
                    lastLat: 21.14300,
                    lastLng: 72.78200,
                    lastLocationAt: new Date()
                }
            }
        );
        logSuccess(`Updated Delivery Partner "${rider.name}" to Approved, Online in Vesu [72.782, 21.143]`);
    }

    // Clear any stale active trip locks for this rider to ensure clean test
    const ordersCol = db.collection('food_orders');
    await ordersCol.updateMany(
        {
            'dispatch.deliveryPartnerId': rider._id,
            orderStatus: { $in: ['assigned', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up'] }
        },
        { $set: { orderStatus: 'cancelled_by_admin' } }
    );

    // 1.5 Setup Customer in Vesu
    const usersCol = db.collection('food_users');
    let customer = await usersCol.findOne({ phone: '9876543210' });

    const vesuAddress = {
        label: 'Home',
        name: 'Surat Test Customer',
        street: 'VIP Road, Near Vesu Canal',
        city: 'Surat',
        state: 'Gujarat',
        zipCode: '395007',
        phone: '9876543210',
        location: {
            type: 'Point',
            coordinates: [72.78400, 21.14400] // Vesu, Surat (~400m from restaurant)
        },
        isDefault: true
    };

    if (!customer) {
        const userRes = await usersCol.insertOne({
            name: 'Surat Test Customer',
            phone: '9876543210',
            role: 'USER',
            isActive: true,
            addresses: [vesuAddress],
            createdAt: new Date(),
            updatedAt: new Date()
        });
        customer = await usersCol.findOne({ _id: userRes.insertedId });
        logSuccess(`Created Test Customer: "${customer.name}" (ID: ${customer._id})`);
    } else {
        await usersCol.updateOne(
            { _id: customer._id },
            { $set: { isActive: true, role: 'USER', addresses: [vesuAddress] } }
        );
        logSuccess(`Updated Test Customer: "${customer.name}" with Vesu address [72.784, 21.144]`);
    }

    // 1.6 Setup Admin in food_admins
    const adminCol = db.collection('food_admins');
    let admin = await adminCol.findOne({ isActive: true, isDeleted: false });
    if (!admin) {
        const adminRes = await adminCol.insertOne({
            name: 'Super Admin',
            email: 'admin@foodiss.com',
            password: 'hashed_password_test',
            phone: '9999999999',
            role: 'ADMIN',
            adminType: 'super_admin',
            isActive: true,
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date()
        });
        admin = await adminCol.findOne({ _id: adminRes.insertedId });
        logSuccess(`Created Admin Account in food_admins: ID ${admin._id}`);
    } else {
        logSuccess(`Found Active Admin Account in food_admins: ID ${admin._id}`);
    }

    // 1.7 Generate JWT Access Tokens
    const customerToken = jwt.sign({ userId: customer._id.toString(), role: 'USER' }, JWT_SECRET, { expiresIn: '2h' });
    const restaurantToken = jwt.sign({ userId: restroId.toString(), role: 'RESTAURANT' }, JWT_SECRET, { expiresIn: '2h' });
    const riderToken = jwt.sign({ userId: rider._id.toString(), role: 'DELIVERY_PARTNER' }, JWT_SECRET, { expiresIn: '2h' });
    const adminToken = jwt.sign({ userId: admin._id.toString(), role: 'ADMIN', adminType: 'super_admin' }, JWT_SECRET, { expiresIn: '2h' });
    logSuccess('Generated authenticated JWT Bearer tokens for all 4 roles');

    // -------------------------------------------------------------
    // PHASE 2: CART CALCULATION & ORDER PLACEMENT
    // -------------------------------------------------------------
    logStep(2, 'Customer: Cart Pricing Calculation & Order Placement (COD)');

    const orderItem = {
        itemId: foodItem._id.toString(),
        name: foodItem.name,
        price: foodItem.price,
        quantity: 1,
        isVeg: true
    };

    // Calculate pricing
    logInfo('Calling POST /api/v1/food/orders/calculate ...');
    const calcRes = await axios.post(
        `${API_BASE}/orders/calculate`,
        {
            restaurantId: restroId.toString(),
            items: [orderItem],
            deliveryAddress: {
                street: vesuAddress.street,
                city: vesuAddress.city,
                state: vesuAddress.state,
                location: vesuAddress.location
            }
        },
        { headers: { Authorization: `Bearer ${customerToken}` } }
    );

    const pricing = calcRes.data.data.pricing || calcRes.data.data;
    logSuccess('Order pricing calculated successfully:', {
        subtotal: pricing.subtotal,
        deliveryFee: pricing.deliveryFee,
        tax: pricing.tax,
        total: pricing.total
    });

    // Place order
    logInfo('Calling POST /api/v1/food/orders (COD) ...');
    const orderPayload = {
        restaurantId: restroId.toString(),
        restaurantName: restroName,
        items: [orderItem],
        address: {
            street: vesuAddress.street,
            city: vesuAddress.city,
            state: vesuAddress.state,
            zipCode: vesuAddress.zipCode,
            phone: vesuAddress.phone,
            location: vesuAddress.location
        },
        pricing: {
            subtotal: pricing.subtotal,
            tax: pricing.tax || 0,
            packagingFee: pricing.packagingFee || 0,
            deliveryFee: pricing.deliveryFee || 0,
            platformFee: pricing.platformFee || 0,
            discount: pricing.discount || 0,
            total: pricing.total
        },
        paymentMethod: 'cash',
        note: 'Deliver at gate in Vesu, Surat'
    };

    const placeRes = await axios.post(`${API_BASE}/orders`, orderPayload, {
        headers: { Authorization: `Bearer ${customerToken}` }
    });

    const orderData = placeRes.data.data.order;
    const orderId = orderData._id.toString();
    const orderCode = orderData.orderId || orderData.order_id || orderId;

    logSuccess(`Order Placed Successfully!`, {
        orderMongoId: orderId,
        orderCode: orderCode,
        status: orderData.orderStatus,
        paymentMethod: orderData.paymentMethod || orderData.payment?.method,
        total: orderData.pricing?.total
    });

    // -------------------------------------------------------------
    // PHASE 3: ADMIN VISIBILITY & REVIEW
    // -------------------------------------------------------------
    logStep(3, 'Admin Panel: Verify Order Inspection');

    logInfo(`Calling GET /api/v1/food/admin/orders/${orderId} ...`);
    const adminRes = await axios.get(`${API_BASE}/admin/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
    });

    const adminOrderView = adminRes.data.data.order;
    logSuccess('Admin verified order successfully:', {
        id: adminOrderView._id,
        restaurant: adminOrderView.restaurantName,
        status: adminOrderView.orderStatus,
        customerAddress: adminOrderView.address?.street
    });

    // -------------------------------------------------------------
    // PHASE 4: RESTAURANT ORDER ACCEPTANCE & PREPARATION
    // -------------------------------------------------------------
    logStep(4, 'Restaurant ("Surat Restro 2"): Accept & Prepare Order');

    logInfo(`PATCH /api/v1/food/restaurant/orders/${orderId}/status -> confirmed`);
    const confirmRes = await axios.patch(
        `${API_BASE}/restaurant/orders/${orderId}/status`,
        { orderStatus: 'confirmed', note: 'Surat Restro 2 accepted the order' },
        { headers: { Authorization: `Bearer ${restaurantToken}` } }
    );
    logSuccess(`Restaurant confirmed order. Current status: ${confirmRes.data.data.order.orderStatus}`);

    logInfo(`PATCH /api/v1/food/restaurant/orders/${orderId}/status -> preparing`);
    const prepRes = await axios.patch(
        `${API_BASE}/restaurant/orders/${orderId}/status`,
        { orderStatus: 'preparing', note: 'Preparing Surati Special Paneer Thali' },
        { headers: { Authorization: `Bearer ${restaurantToken}` } }
    );
    logSuccess(`Restaurant preparing order. Current status: ${prepRes.data.data.order.orderStatus}`);

    // Wait 1 second for background dispatch / assignment processing
    await new Promise((r) => setTimeout(r, 1000));

    // -------------------------------------------------------------
    // PHASE 5: DELIVERY PARTNER ASSIGNMENT & ACCEPTANCE
    // -------------------------------------------------------------
    logStep(5, 'Delivery Partner (Vesu): View & Accept Order');

    logInfo(`Calling GET /api/v1/food/delivery/orders/available ...`);
    const availRes = await axios.get(`${API_BASE}/delivery/orders/available`, {
        headers: { Authorization: `Bearer ${riderToken}` }
    });
    logSuccess(`Rider queried available orders. Found ${availRes.data.data.orders?.length || 0} orders.`);

    logInfo(`Calling PATCH /api/v1/food/delivery/orders/${orderId}/accept ...`);
    const acceptRes = await axios.patch(
        `${API_BASE}/delivery/orders/${orderId}/accept`,
        {},
        { headers: { Authorization: `Bearer ${riderToken}` } }
    );
    logSuccess('Rider accepted order successfully:', {
        orderId: acceptRes.data.data.order?._id || orderId,
        dispatchStatus: acceptRes.data.data.order?.dispatch?.status || 'accepted',
        assignedRider: rider.name
    });

    // -------------------------------------------------------------
    // PHASE 6: RESTAURANT READY & RIDER PICKUP FLOW
    // -------------------------------------------------------------
    logStep(6, 'Restaurant Ready for Pickup & Rider Pickup');

    logInfo(`Restaurant: PATCH /api/v1/food/restaurant/orders/${orderId}/status -> ready_for_pickup`);
    await axios.patch(
        `${API_BASE}/restaurant/orders/${orderId}/status`,
        { orderStatus: 'ready_for_pickup', note: 'Food packed and ready on counter' },
        { headers: { Authorization: `Bearer ${restaurantToken}` } }
    );
    logSuccess('Restaurant marked order as ready_for_pickup');

    logInfo(`Rider: PATCH /api/v1/food/delivery/orders/${orderId}/reached-pickup`);
    const reachedPickupRes = await axios.patch(
        `${API_BASE}/delivery/orders/${orderId}/reached-pickup`,
        {},
        { headers: { Authorization: `Bearer ${riderToken}` } }
    );
    logSuccess('Rider marked reached-pickup. Current delivery phase: at_pickup');

    logInfo(`Rider: PATCH /api/v1/food/delivery/orders/${orderId}/confirm-pickup`);
    const pickupRes = await axios.patch(
        `${API_BASE}/delivery/orders/${orderId}/confirm-pickup`,
        {},
        { headers: { Authorization: `Bearer ${riderToken}` } }
    );
    logSuccess('Rider picked up order! Order status is now picked_up (En route to Vesu customer)');

    // -------------------------------------------------------------
    // PHASE 7: RIDER DROP ARRIVAL & DELIVERY OTP VERIFICATION
    // -------------------------------------------------------------
    logStep(7, 'Rider Drop Arrival & Secure Customer OTP Handover');

    logInfo(`Rider: PATCH /api/v1/food/delivery/orders/${orderId}/reached-drop`);
    await axios.patch(
        `${API_BASE}/delivery/orders/${orderId}/reached-drop`,
        {},
        { headers: { Authorization: `Bearer ${riderToken}` } }
    );
    logSuccess('Rider reached customer location in Vesu');

    // Retrieve generated secret delivery OTP from DB
    const dbOrderWithOtp = await ordersCol.findOne(
        { _id: new mongoose.Types.ObjectId(orderId) },
        { projection: { deliveryOtp: 1, orderStatus: 1, deliveryVerification: 1 } }
    );
    const dropOtp = String(dbOrderWithOtp?.deliveryOtp || '').trim();
    logInfo(`System generated customer Delivery Handover OTP: [${colors.bright}${colors.yellow}${dropOtp}${colors.reset}]`);

    // Test Negative Case: invalid OTP
    logInfo('Testing Security: Rider attempts completion with INVALID OTP "9999" ...');
    try {
        await axios.patch(
            `${API_BASE}/delivery/orders/${orderId}/complete`,
            { otp: '9999' },
            { headers: { Authorization: `Bearer ${riderToken}` } }
        );
        throw new Error('SECURITY VIOLATION: Order should NOT have completed with invalid OTP!');
    } catch (err) {
        if (err.response && err.response.status === 400) {
            logSuccess('Security check passed: Invalid OTP was correctly rejected (400 Bad Request)');
        } else {
            throw err;
        }
    }

    // Positive Case: complete with real customer OTP
    logInfo(`Rider submits valid OTP "${dropOtp}" to complete delivery ...`);
    const completeRes = await axios.patch(
        `${API_BASE}/delivery/orders/${orderId}/complete`,
        { otp: dropOtp },
        { headers: { Authorization: `Bearer ${riderToken}` } }
    );

    const deliveredOrder = completeRes.data.data.order;
    logSuccess('Order successfully DELIVERED!', {
        status: deliveredOrder.orderStatus,
        deliveredAt: deliveredOrder.deliveryState?.deliveredAt,
        isDropOtpVerified: deliveredOrder.deliveryVerification?.dropOtp?.verified
    });

    // -------------------------------------------------------------
    // PHASE 8: CUSTOMER REVIEW & RATING SUBMISSION
    // -------------------------------------------------------------
    logStep(8, 'Customer: Submit Food & Delivery Ratings/Review');

    const reviewPayload = {
        restaurantRating: 5,
        deliveryPartnerRating: 5,
        restaurantComment: 'Incredible taste from Surat Restro 2, food was hot and delicious!',
        deliveryPartnerComment: 'Very courteous and swift delivery in Vesu!'
    };

    logInfo(`Calling PATCH /api/v1/food/orders/${orderId}/ratings ...`);
    const ratingRes = await axios.patch(
        `${API_BASE}/orders/${orderId}/ratings`,
        reviewPayload,
        { headers: { Authorization: `Bearer ${customerToken}` } }
    );
    logSuccess('Ratings submitted successfully by customer:', reviewPayload);

    // -------------------------------------------------------------
    // PHASE 9: FINAL DATABASE VERIFICATION & AUDIT ASSERTIONS
    // -------------------------------------------------------------
    logStep(9, 'Final Verification & Audit Assertions');

    const finalOrder = await ordersCol.findOne({ _id: new mongoose.Types.ObjectId(orderId) });
    const finalRestro = await restaurantCol.findOne({ _id: restroId });
    const finalRider = await ridersCol.findOne({ _id: rider._id });

    console.log('\n--- AUDIT SUMMARY ---');
    console.log(`1. Final Order Status:       ${finalOrder.orderStatus} (Expected: delivered)`);
    console.log(`2. Payment Status:           ${finalOrder.payment?.status} (Expected: paid)`);
    console.log(`3. Drop OTP Verified:        ${finalOrder.deliveryVerification?.dropOtp?.verified} (Expected: true)`);
    console.log(`4. Restaurant Rating Given:  ${finalOrder.ratings?.restaurant?.rating} ★`);
    console.log(`5. Restaurant Review:        "${finalOrder.ratings?.restaurant?.comment}"`);
    console.log(`6. Delivery Rating Given:    ${finalOrder.ratings?.deliveryPartner?.rating} ★`);
    console.log(`7. Delivery Partner Review:  "${finalOrder.ratings?.deliveryPartner?.comment}"`);
    console.log(`8. Status History Entries:   ${finalOrder.statusHistory?.length || 0} transitions recorded`);
    console.log(`9. Restaurant Overall Score: ${finalRestro.rating} ★ (${finalRestro.totalRatings} total reviews)`);
    console.log(`10. Rider Overall Score:     ${finalRider.rating} ★ (${finalRider.totalRatings} total reviews)`);

    // Assertions
    if (finalOrder.orderStatus !== 'delivered') throw new Error('Assertion failed: orderStatus !== delivered');
    if (finalOrder.payment?.status !== 'paid') throw new Error('Assertion failed: payment.status !== paid');
    if (!finalOrder.deliveryVerification?.dropOtp?.verified) throw new Error('Assertion failed: dropOtp not verified');
    if (finalOrder.ratings?.restaurant?.rating !== 5) throw new Error('Assertion failed: restaurant rating !== 5');
    if (finalOrder.ratings?.deliveryPartner?.rating !== 5) throw new Error('Assertion failed: rider rating !== 5');

    console.log(`\n${colors.bright}${colors.green}************************************************************************`);
    console.log(`   ALL 9 TEST PHASES PASSED WITH ZERO ERRORS! FULL LIFECYCLE VERIFIED   `);
    console.log(`************************************************************************${colors.reset}\n`);

    await mongoose.disconnect();
}

runTest().catch((err) => {
    logError('Integration Test Encountered a Failure:', err);
    mongoose.disconnect().finally(() => process.exit(1));
});
