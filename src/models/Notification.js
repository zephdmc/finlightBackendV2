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

    metadata: {
        type: Object,
        default: {}
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Notification', notificationSchema);