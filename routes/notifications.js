const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  type: { type: String, enum: ['like', 'comment', 'follow'], required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'post', default: null },
  comment: { type: mongoose.Schema.Types.ObjectId, default: null },
  text: { type: String, maxlength: 1000, default: '' },
  read: { type: Boolean, default: false },
  date: { type: Date, default: Date.now }
});

// One notification per active like/follow, or per individual comment.
notificationSchema.index({ recipient: 1, actor: 1, type: 1, post: 1, comment: 1 }, { unique: true });
notificationSchema.index({ recipient: 1, read: 1, date: -1 });

module.exports = mongoose.model('notification', notificationSchema);
