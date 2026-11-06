const createError = require('http-errors');
const Post = require('../routes/posts');
const User = require('../routes/users');

const pageSize = 10;

function decodeCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length !== 49) throw createError(400, 'Invalid feed cursor');
  const [date, id] = value.split('_');
  const timestamp = new Date(date);
  if (!/^[a-f0-9]{24}$/.test(id || '') || !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== date) {
    throw createError(400, 'Invalid feed cursor');
  }
  return { date: timestamp, _id: id };
}

async function getFeedPage(user, before) {
  const cursor = decodeCursor(before);
  const authors = await User.find({ _id: { $in: [user._id, ...user.following] } }).select('_id');
  const filter = { user: { $in: authors.map(author => author._id) } };
  if (cursor) filter.$or = [
    { date: { $lt: cursor.date } },
    { date: cursor.date, _id: { $lt: cursor._id } }
  ];
  const results = await Post.find(filter).sort({ date: -1, _id: -1 }).limit(pageSize + 1)
    .populate('user', 'username picture');
  const page = results.slice(0, pageSize);
  const last = page[page.length - 1];
  return {
    posts: page.filter(post => post.user),
    nextCursor: results.length > pageSize ? last.date.toISOString() + '_' + last.id : null
  };
}

module.exports = { getFeedPage };
