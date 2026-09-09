const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;

async function createAdmin() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB.');

    const adminCollection = mongoose.connection.collection('food_admins');
    const existingAdmin = await adminCollection.findOne({ email: 'admin@switcheats.com' });
    
    if (existingAdmin) {
      console.log('Admin already exists! (Email: admin@switcheats.com)');
      // Re-hash and force update password
      const newHash = await bcrypt.hash('admin123', 10);
      await adminCollection.updateOne(
        { email: 'admin@switcheats.com' }, 
        { $set: { password: newHash, adminType: 'super_admin' } }
      );
      console.log('Updated existing admin password to: admin123 and set adminType to super_admin');
    } else {
      const hash = await bcrypt.hash('admin123', 10);
      await adminCollection.insertOne({
        email: 'admin@switcheats.com',
        password: hash,
        name: 'Super Admin',
        phone: '9999999999',
        profileImage: '',
        fcmTokens: [],
        fcmTokenMobile: [],
        role: 'ADMIN',
        adminType: 'super_admin',
        isActive: true,
        servicesAccess: ['food', 'quickCommerce', 'taxi'],
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log('Successfully created a new admin account!');
      console.log('Email: admin@switcheats.com | Password: admin123');
    }
  } catch (err) {
    console.error('Error creating admin:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

createAdmin();
