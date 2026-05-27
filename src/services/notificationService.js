const Notification = require('../models/Notification');

/**
 * Send notification to all members in org
 */
// const notifyOrganization = async ({ organizationId, title, message, type = 'system', metadata = {} }) => {
//     const User = require('../models/User');

//     const users = await User.find({ organizationId, role: 'member' }, '_id');

//     const notifications = users.map(user => ({
//         organizationId,
//         userId: user._id,
//         title,
//         message,
//         type,
//         metadata
//     }));

//     await Notification.insertMany(notifications);
// };



/**
 * Broadcast ONE notification to organization (WhatsApp style)
 */
const notifyOrganization = async ({
    organizationId,
    title,
    message,
    type = 'system',
    metadata = {}
}) => {

    await Notification.create({
        organizationId,
        userId: null, // 🔥 broadcast notification
        title,
        message,
        type,
        metadata
    });
};
/**
 * Send notification to single user
 */
const notifyUser = async ({ userId, organizationId, title, message, type = 'system', metadata = {} }) => {
    await Notification.create({
        userId,
        organizationId,
        title,
        message,
        type,
        metadata
    });
};

module.exports = {
    notifyOrganization,
    notifyUser
};