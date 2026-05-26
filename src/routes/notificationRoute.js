const router = require('express').Router();
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');

// Get notifications
router.get('/', protect, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;

        // const notifications = await Notification.find({
        //     organizationId: req.user.organizationId,
        //     $or: [
        //         { userId: req.user.id },
        //         { userId: null }
        //     ]
        // })
        //     .sort({ createdAt: -1 })
        //     .limit(limit);

        const notifications = await Notification.find({
            organizationId: req.user.organizationId
        })
            .sort({ createdAt: -1 })
            .limit(50);

        // const unreadCount = await Notification.countDocuments({
        //     organizationId: req.user.organizationId,
        //     isRead: false,
        //     $or: [{ userId: req.user.id }, { userId: null }]
        // });
        const unreadCount = await Notification.countDocuments({
            organizationId: req.user.organizationId,
            isRead: false
        });
        res.json({
            success: true,
            data: notifications,
            unreadCount
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark one as read
router.put('/:id/read', protect, async (req, res) => {
    await Notification.findByIdAndUpdate(req.params.id, { isRead: true });

    res.json({ success: true });
});

// Mark all as read
router.put('/read-all', protect, async (req, res) => {
    await Notification.updateMany(
        {
            organizationId: req.user.organizationId,
            $or: [{ userId: req.user.id }, { userId: null }]
        },
        { isRead: true }
    );

    res.json({ success: true });
});

module.exports = router;