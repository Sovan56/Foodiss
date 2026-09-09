require('dotenv').config();
const mongoose = require('mongoose');

async function openRestaurant() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;
    
    // The restaurant ID from the error logs
    const restaurantId = "6a7eca1796271a00ee1a5f87";
    
    const result = await db.collection('food_restaurants').updateOne(
      { _id: new mongoose.Types.ObjectId(restaurantId) },
      { 
        $set: { 
          isActive: true, 
          isAcceptingOrders: true,
          openDays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
          openingTime: '00:00',
          closingTime: '23:59',
          status: 'approved'
        },
        $unset: { outletTimings: "" }
      }
    );
    
    console.log("Matched:", result.matchedCount, "Modified:", result.modifiedCount);
    console.log("Restaurant opened successfully! You should now be able to place/calculate orders.");
  } catch (err) {
    console.error("Error updating restaurant:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

openRestaurant();
