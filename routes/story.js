const mongoose = require('mongoose');

const storySchema = mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user"
  },
  story: String,
  date: {
    type: Date,
    default: Date.now,
    index: true
  }
})

const lifetime = 24 * 60 * 60 * 1000;
storySchema.statics.activeFilter = function (now = Date.now()) {
  return { date: { $gt: new Date(now - lifetime) } };
};
storySchema.statics.lifetime = lifetime;

module.exports = mongoose.model("story", storySchema);
