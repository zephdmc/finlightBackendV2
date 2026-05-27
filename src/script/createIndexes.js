// scripts/createIndexes.js
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const UserRead = require('../models/UserRead');

const createIndexes = async () => {
    try {
        // Notification indexes
        await Notification.collection.createIndex(
            { organizationId: 1, createdAt: -1 }
        );
        console.log('✅ Notification indexes created');

        // UserRead indexes
        await UserRead.collection.createIndex(
            { notificationId: 1, userId: 1 },
            { unique: true }
        );
        await UserRead.collection.createIndex(
            { userId: 1, organizationId: 1, readAt: -1 }
        );
        console.log('✅ UserRead indexes created');

        console.log('All indexes created successfully');
    } catch (error) {
        console.error('Error creating indexes:', error);
    } finally {
        mongoose.disconnect();
    }
};

// Run this script once
module.exports = createIndexes;