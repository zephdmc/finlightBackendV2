const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    organizationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Organization',
        required: true
    },

    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User', // null = broadcast to all org members
        default: null
    },

    title: String,
    message: String,

    type: {
        type: String,
        enum: ['payment', 'system', 'member', 'alert'],
        default: 'system'
    },

    isRead: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 14 * 24 * 60 * 60 // Auto-delete after 14 days (in seconds)
    },

    metadata: {
        type: Object,
        default: {}
    }
}, {
    timestamps: true
});

// Index for faster queries
notificationSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);