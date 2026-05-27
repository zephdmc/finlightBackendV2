// const router = require('express').Router();
// const Notification = require('../models/Notification');
// const { protect } = require('../middleware/auth');

// // Get notifications
// router.get('/', protect, async (req, res) => {
//     try {
//         const limit = parseInt(req.query.limit) || 50;

//         // const notifications = await Notification.find({
//         //     organizationId: req.user.organizationId,
//         //     $or: [
//         //         { userId: req.user.id },
//         //         { userId: null }
//         //     ]
//         // })
//         //     .sort({ createdAt: -1 })
//         //     .limit(limit);

//         const notifications = await Notification.find({
//             organizationId: req.user.organizationId
//         })
//             .sort({ createdAt: -1 })
//             .limit(50);

//         // const unreadCount = await Notification.countDocuments({
//         //     organizationId: req.user.organizationId,
//         //     isRead: false,
//         //     $or: [{ userId: req.user.id }, { userId: null }]
//         // });
//         const unreadCount = await Notification.countDocuments({
//             organizationId: req.user.organizationId,
//             isRead: false
//         });
//         res.json({
//             success: true,
//             data: notifications,
//             unreadCount
//         });
//     } catch (error) {
//         res.status(500).json({ success: false, message: error.message });
//     }
// });

// // Mark one as read
// router.put('/:id/read', protect, async (req, res) => {
//     await Notification.findByIdAndUpdate(req.params.id, { isRead: true });

//     res.json({ success: true });
// });

// // Mark all as read
// router.put('/read-all', protect, async (req, res) => {
//     await Notification.updateMany(
//         {
//             organizationId: req.user.organizationId,
//             $or: [{ userId: req.user.id }, { userId: null }]
//         },
//         { isRead: true }
//     );

//     res.json({ success: true });
// });

// module.exports = router;



// routes/notifications.js
const router = require('express').Router();
const Notification = require('../models/Notification');
const UserRead = require('../models/UserRead');
const { protect } = require('../middleware/auth');

// Get notifications for current user
router.get('/', protect, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;

        // Get all notifications (they auto-delete after 2 weeks)
        const notifications = await Notification.find({
            organizationId: req.user.organizationId
        })
            .sort({ createdAt: -1 })
            .limit(limit);

        if (notifications.length === 0) {
            return res.json({
                success: true,
                data: [],
                unreadCount: 0
            });
        }

        // Get user's read records (auto-delete after 48 hours)
        const userReads = await UserRead.find({
            notificationId: { $in: notifications.map(n => n._id) },
            userId: req.user.id
        });

        const readNotificationIds = new Set(
            userReads.map(read => read.notificationId.toString())
        );

        // Attach read status
        const notificationsWithStatus = notifications.map(notification => ({
            ...notification.toObject(),
            isRead: readNotificationIds.has(notification._id.toString())
        }));

        // Count unread
        const unreadCount = notificationsWithStatus.filter(n => !n.isRead).length;

        res.json({
            success: true,
            data: notificationsWithStatus,
            unreadCount
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark one notification as read
router.put('/:id/read', protect, async (req, res) => {
    try {
        // Check if notification exists
        const notification = await Notification.findOne({
            _id: req.params.id,
            organizationId: req.user.organizationId
        });

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found'
            });
        }

        // Create read record (auto-deletes after 48 hours)
        await UserRead.findOneAndUpdate(
            {
                notificationId: req.params.id,
                userId: req.user.id
            },
            {
                notificationId: req.params.id,
                userId: req.user.id,
                organizationId: req.user.organizationId,
                readAt: new Date()
            },
            { upsert: true }
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark all notifications as read
router.put('/read-all', protect, async (req, res) => {
    try {
        // Get all notifications for this organization
        const notifications = await Notification.find({
            organizationId: req.user.organizationId
        }, '_id');

        if (notifications.length === 0) {
            return res.json({ success: true });
        }

        // Bulk create read records
        const bulkOps = notifications.map(notification => ({
            updateOne: {
                filter: {
                    notificationId: notification._id,
                    userId: req.user.id
                },
                update: {
                    notificationId: notification._id,
                    userId: req.user.id,
                    organizationId: req.user.organizationId,
                    readAt: new Date()
                },
                upsert: true
            }
        }));

        await UserRead.bulkWrite(bulkOps);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get read status for multiple notifications
router.post('/read-status', protect, async (req, res) => {
    try {
        const { notificationIds } = req.body;

        const userReads = await UserRead.find({
            notificationId: { $in: notificationIds },
            userId: req.user.id
        });

        const readStatus = {};
        userReads.forEach(read => {
            readStatus[read.notificationId.toString()] = true;
        });

        res.json({
            success: true,
            data: readStatus
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get stats (optional, for debugging)
router.get('/stats', protect, async (req, res) => {
    try {
        const stats = {
            notifications: await Notification.countDocuments({
                organizationId: req.user.organizationId
            }),
            userReads: await UserRead.countDocuments({
                userId: req.user.id
            }),
            // Sample of when records will expire
            oldestNotification: await Notification.findOne({
                organizationId: req.user.organizationId
            }).sort({ createdAt: 1 }),
            oldestUserRead: await UserRead.findOne({
                userId: req.user.id
            }).sort({ readAt: 1 })
        };

        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;