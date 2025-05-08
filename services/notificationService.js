const Notification = require('../models/Notification');

const markAsRead = async (id, read) => {
  return await Notification.findByIdAndUpdate(id, { read }, { new: true });
};

const markAllAsRead = async () => {
  return await Notification.updateMany({}, { read: true });
};

module.exports = {
  markAsRead,
  markAllAsRead,
};
