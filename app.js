var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var expressSession = require('express-session');
var crypto = require('crypto');
var mongoose = require('mongoose');

var indexRouter = require('./routes/index');
var userModel = require('./routes/users');
var notificationModel = require('./routes/notifications');
const { startStoryExpiration } = require('./utils/story-expiration');
const passport = require('passport');

var app = express();
const databaseReady = mongoose.connection.asPromise().then(() => Promise.all([userModel.init(), notificationModel.init()]));
databaseReady.catch(function(err) {
  console.error('Database initialization failed:', err.message);
});
app.locals.databaseReady = databaseReady;
databaseReady.then(startStoryExpiration, function () {});

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
// Accounts created before the default avatar changed still request def.png.
app.get('/images/uploads/def.png', function(req, res) {
  res.sendFile(path.join(__dirname, 'public/images/uploads/default-avatar.svg'));
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    if (path.extname(filePath).toLowerCase() === '.avif') res.type('image/avif');
  }
}));

app.use(expressSession({
  resave: false,
  saveUninitialized: false,
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
}));
app.use(passport.initialize());
app.use(function(req, res, next) {
  const needsDatabase = (req.session.passport && req.session.passport.user) ||
    (req.method === 'POST' && ['/login', '/register'].includes(req.path));
  if (!needsDatabase) return next();
  const unavailable = () => next(createError(503, 'Database unavailable. Start MongoDB and try again'));
  if (mongoose.connection.readyState === 0) return unavailable();
  databaseReady.then(function() {
    if (mongoose.connection.readyState !== 1) return unavailable();
    next();
  }, unavailable);
});
app.use(passport.session());
passport.serializeUser(userModel.serializeUser());
passport.deserializeUser(userModel.deserializeUser());

app.use('/', indexRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.name === 'CastError' || err.name === 'ValidationError' ||
      err.name === 'MissingUsernameError' || err.name === 'MissingPasswordError') {
    err.status = 400;
  } else if (err.name === 'UserExistsError' || err.code === 11000) {
    err.status = 409;
    err.message = 'That username is already taken';
  } else if (err.name === 'MulterError') {
    err.status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    err.message = err.code === 'LIMIT_FILE_SIZE' ? 'Images must be 5 MB or smaller' : 'Upload one image using the image field';
  } else if (['MongooseServerSelectionError', 'MongoServerSelectionError', 'MongoNetworkError', 'MongoNotConnectedError'].includes(err.name) ||
      (err.name === 'MongooseError' && mongoose.connection.readyState !== 1)) {
    err.status = 503;
    err.message = 'Database unavailable. Start MongoDB and try again';
  }
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(err.status || 500).json({
      message: (err.status || req.app.get('env') === 'development') ? err.message : 'Something went wrong. Please try again'
    });
  }
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
