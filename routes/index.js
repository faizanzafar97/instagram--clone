var express = require("express");
var router = express.Router();
const createError = require("http-errors");
const passport = require("passport");
const localStrategy = require("passport-local");
const userModel = require("./users");
const postModel = require("./posts");
const storyModel = require("./story");
passport.use(new localStrategy(userModel.authenticate()));
const upload = require("./multer");
const utils = require("../utils/utils");

// Express 4 does not forward rejected async handlers to the error middleware.
function asyncRoute(handler) {
  return function (req, res, next) {
    Promise.resolve().then(() => handler(req, res, next)).catch(async function (err) {
      try { await upload.removeFile(req.file); }
      catch (cleanupError) { console.error('Could not remove failed upload:', cleanupError.message); }
      next(err);
    });
  };
}

function usernameFrom(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_.-]{1,30}$/u.test(value.trim())) {
    throw createError(400, 'Use a username with 1–30 letters, numbers, dots, underscores or hyphens');
  }
  return value.trim();
}

function textFrom(value, field, maxLength) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    throw createError(400, `${field} must be text of at most ${maxLength} characters`);
  }
  return value.trim();
}

router.get("/", function (req, res) {
  res.render("index", { footer: false });
});

router.get("/login", function (req, res) {
  res.render("login", { footer: false });
});

router.get("/like/:postid", isLoggedIn, asyncRoute(async function (req, res) {
  const post = await postModel.findById(req.params.postid);
  if (!post) throw createError(404, "Post not found");
  const index = post.like.indexOf(req.user._id);
  const update = index === -1 ? { $addToSet: { like: req.user._id } } : { $pull: { like: req.user._id } };
  const updated = await postModel.findByIdAndUpdate(post._id, update, { new: true });
  if (!updated) throw createError(404, 'Post not found');
  res.json({ _id: updated.id, like: updated.like });
}));

router.get("/feed", isLoggedIn, asyncRoute(async function (req, res) {
  const user = req.user;
  const stories = await storyModel.find({ user: { $ne: user._id } }).sort({ date: -1, _id: -1 }).populate("user");
  const seen = new Set();
  const filtered = stories.filter(function (story) {
    if (!story.user || seen.has(story.user.id)) return false;
    seen.add(story.user.id);
    return true;
  });
  const posts = await postModel.find().sort({ date: -1, _id: -1 }).populate("user");
  res.render("feed", {
    footer: true,
    user,
    posts: posts.filter(post => post.user),
    stories: filtered,
    dater: utils.formatRelativeTime,
  });
}));

router.get("/profile", isLoggedIn, asyncRoute(async function (req, res) {
  const user = await userModel.findById(req.user._id)
    .populate({ path: 'posts', options: { sort: { date: -1, _id: -1 } } }).populate("saved");
  if (!user) throw createError(404, 'User not found');
  res.render("profile", { footer: true, user });
}));

router.get("/profile/:user", isLoggedIn, asyncRoute(async function (req, res) {
  const user = req.user;
  if (user.username === req.params.user) return res.redirect("/profile");
  const userprofile = await userModel.findOne({ username: req.params.user })
    .populate({ path: 'posts', options: { sort: { date: -1, _id: -1 } } });
  if (!userprofile) throw createError(404, "User not found");
  res.render("userprofile", { footer: true, userprofile, user });
}));

router.get("/follow/:userid", isLoggedIn, asyncRoute(async function (req, res) {
  const user = req.user;
  const target = await userModel.findById(req.params.userid);
  if (!target) throw createError(404, "User not found");
  if (user.id === target.id) throw createError(400, "You cannot follow yourself");
  const index = user.following.indexOf(target._id);
  const operation = index === -1 ? '$addToSet' : '$pull';
  await userModel.updateOne({ _id: target._id }, { [operation]: { followers: user._id } });
  await userModel.updateOne({ _id: user._id }, { [operation]: { following: target._id } });
  res.redirect('/profile/' + encodeURIComponent(target.username));
}));

router.get("/search", isLoggedIn, function (req, res) {
  res.render("search", { footer: true, user: req.user });
});

router.get("/save/:postid", isLoggedIn, asyncRoute(async function (req, res) {
  const user = req.user;
  if (!await postModel.exists({ _id: req.params.postid })) throw createError(404, "Post not found");
  const index = user.saved.indexOf(req.params.postid);
  const update = index === -1 ? { $addToSet: { saved: req.params.postid } } : { $pull: { saved: req.params.postid } };
  const updated = await userModel.findByIdAndUpdate(user._id, update, { new: true });
  if (!updated) throw createError(404, 'User not found');
  res.json({ saved: updated.saved });
}));

router.get("/search/:user", isLoggedIn, asyncRoute(async function (req, res) {
  const escaped = req.params.user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const users = await userModel.find({ username: { $regex: new RegExp(`^${escaped}`, 'i') } })
    .select('username name picture').limit(30);
  res.json(users);
}));

router.get("/edit", isLoggedIn, function (req, res) {
  res.render("edit", { footer: true, user: req.user });
});

router.get("/upload", isLoggedIn, function (req, res) {
  res.render("upload", { footer: true, user: req.user });
});

router.get("/story", isLoggedIn, asyncRoute(async function (req, res) {
  const story = await storyModel.findOne({ user: req.user._id }).sort({ date: -1 });
  if (!story) return res.redirect("/upload");
  res.redirect(`/story/${story.id}`);
}));

router.get("/story/:storyid", isLoggedIn, asyncRoute(async function (req, res) {
  const story = await storyModel.findById(req.params.storyid).populate("user");
  if (!story || !story.user) throw createError(404, "Story not found");
  res.render("story", { footer: true, user: req.user, story });
}));

router.post("/update", isLoggedIn, asyncRoute(async function (req, res, next) {
  const username = usernameFrom(req.body.username);
  const name = textFrom(req.body.name, 'Name', 100);
  const bio = textFrom(req.body.bio, 'Bio', 500);
  const user = await userModel.findByIdAndUpdate(req.user._id,
    { username, name, bio },
    { new: true, runValidators: true });
  if (!user) throw createError(404, 'User not found');
  req.login(user, function (err) {
    if (err) return next(err);
    res.redirect("/profile");
  });
}));

router.post("/post", isLoggedIn, upload.single("image"), asyncRoute(async function (req, res) {
  if (!req.file) throw createError(400, "Please select an image before posting");
  if (!["post", "story"].includes(req.body.category)) throw createError(400, "Choose post or story");
  const user = req.user;
  const isPost = req.body.category === 'post';
  const model = isPost ? postModel : storyModel;
  const document = await model.create(isPost
    ? { user: user._id, caption: textFrom(req.body.caption, 'Caption', 2200), picture: req.file.filename }
    : { user: user._id, story: req.file.filename });
  try {
    const result = await userModel.updateOne({ _id: user._id }, {
      $addToSet: { [isPost ? 'posts' : 'stories']: document._id }
    });
    if (!result.matchedCount) throw createError(404, 'User not found');
  } catch (err) {
    await model.deleteOne({ _id: document._id });
    throw err;
  }
  res.redirect("/feed");
}));

router.post("/upload", isLoggedIn, upload.single("image"), asyncRoute(async function (req, res) {
  if (!req.file) throw createError(400, "Please select a profile image");
  const user = await userModel.findByIdAndUpdate(req.user._id, { picture: req.file.filename });
  if (!user) throw createError(404, 'User not found');
  res.redirect("/edit");
}));

router.post("/register", asyncRoute(async function (req, res, next) {
  const username = usernameFrom(req.body.username);
  const name = textFrom(req.body.name, 'Name', 100);
  const email = textFrom(req.body.email, 'Email', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw createError(400, 'Enter a valid email address');
  if (typeof req.body.password !== 'string' || !req.body.password || req.body.password.length > 1024) {
    throw createError(400, 'Enter a password of at most 1024 characters');
  }
  const user = new userModel({ username, email, name });
  const registeredUser = await userModel.register(user, req.body.password);
  req.login(registeredUser, function (err) {
    if (err) return next(err);
    res.redirect("/profile");
  });
}));

router.post("/login", passport.authenticate("local", {
  successRedirect: "/feed",
  failureRedirect: "/login",
}));

router.get("/logout", function (req, res, next) {
  req.logout(function (err) {
    if (err) return next(err);
    res.redirect("/login");
  });
});

function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ message: 'Please log in to continue', loginUrl: '/login' });
  }
  res.redirect("/login");
}

module.exports = router;
