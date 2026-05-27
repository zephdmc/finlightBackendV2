// models/UserRead.js
const mongoose = require('mongoose');

const userReadSchema = new mongoose.Schema({
    notificationId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        ref: 'Notification',
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    organizationId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    readAt: {
        type: Date,
        default: Date.now,
        expires: 48 * 60 * 60 // Auto-delete after 48 hours (in seconds)
    }
});

// Compound unique index to prevent duplicate reads
userReadSchema.index({ notificationId: 1, userId: 1 }, { unique: true });

// Compound index for queries
userReadSchema.index({ userId: 1, organizationId: 1, readAt: -1 });

module.exports = mongoose.model('UserRead', userReadSchema);