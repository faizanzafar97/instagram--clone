const mongoose = require('mongoose');
const plm = require("passport-local-mongoose");

mongoose.set('bufferCommands', false);
mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/instainstaclone", {
  serverSelectionTimeoutMS: 5000
}).catch(function (err) {
  console.error('MongoDB connection failed. Start MongoDB or set MONGODB_URI:', err.message);
});

const userSchema = mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  name: String,
  email: String,
  password: String,
  picture: {
    type: String,
    default: "default-avatar.svg"
  },
  contact: String,
  bio: String,
  stories: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "story" 
    }
  ],
  saved: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "post" 
    }
  ],
  posts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "post" 
  }],
  followers: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user" 
    } 
  ],
  following: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user" 
    }
  ]
})

userSchema.plugin(plm);

module.exports = mongoose.model("user", userSchema);
