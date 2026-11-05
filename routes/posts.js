const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  text: { type: String, required: true, trim: true, maxlength: 1000 },
  parent: { type: mongoose.Schema.Types.ObjectId, default: null },
  date: { type: Date, default: Date.now }
});

const postSchema = mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "user"
  },
  caption: String,
  like: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "user"
  }],
  comments: { type: [commentSchema], default: [] },
  date: {
    type: Date,
    default: Date.now
  },
  shares: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "user"
  }],
  picture: String
})


module.exports = mongoose.model("post", postSchema);
