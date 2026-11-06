const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');

const databaseName = 'instaclone_pagination_' + randomUUID().replace(/-/g, '');
const databaseUrl = new URL(process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017');
databaseUrl.pathname = '/' + databaseName;
process.env.MONGODB_URI = databaseUrl.toString();
const app = require('../app');
const mongoose = require('mongoose');
const User = require('../routes/users');
const Post = require('../routes/posts');

test('feed pagination stays ordered and scoped across inserts, deletes and tied timestamps', { timeout: 30000 }, async function (t) {
  let server;
  t.after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.name === databaseName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await app.locals.databaseReady;
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  async function request(path, options = {}) {
    const response = await fetch(base + path, {
      ...options, headers: { cookie, ...options.headers }, redirect: 'manual', signal: AbortSignal.timeout(5000)
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.text(), cacheControl: response.headers.get('cache-control') };
  }
  const api = async path => {
    const response = await request(path, { headers: { Accept: 'application/json' } });
    assert.equal(response.status, 200);
    return JSON.parse(response.body);
  };
  const ids = html => Array.from(html.matchAll(/<div id="post-([a-f0-9]{24})"/g), match => match[1]);
  await request('/register', { method: 'POST', body: new URLSearchParams({ username: 'pagination_viewer', password: 'pagination-password' }) });
  const viewer = await User.findOne({ username: 'pagination_viewer' });
  const followed = await User.create({ username: 'pagination_followed' });
  const unrelated = await User.create({ username: 'pagination_unrelated' });
  const missingAuthor = new mongoose.Types.ObjectId();
  await User.updateOne({ _id: viewer._id }, { $set: { following: [followed._id, missingAuthor] } });
  const empty = await api('/feed');
  assert.deepEqual(ids(empty.html), []);
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.userId, viewer.id);
  const date = new Date(Date.now() - 60000);
  const posts = await Post.insertMany(Array.from({ length: 25 }, (_, index) => ({
    user: index % 2 ? viewer._id : followed._id, date, caption: 'Paginated post ' + index, picture: 'default-avatar.svg'
  })));
  await Post.insertMany(Array.from({ length: 15 }, (_, index) => ({
    user: index % 2 ? unrelated._id : missingAuthor, date: new Date(), caption: 'Hidden post', picture: 'default-avatar.svg'
  })));
  const ordered = [...posts].sort((a, b) => b.id.localeCompare(a.id)).map(post => post.id);
  const first = await api('/feed');
  assert.equal(first.userId, viewer.id);
  assert.deepEqual(ids(first.html), ordered.slice(0, 10));
  assert.ok(first.nextCursor);
  assert.doesNotMatch(first.html, /Hidden post|<html|<script/);
  const initial = await request('/feed');
  assert.equal(initial.cacheControl, 'no-store');
  assert.deepEqual(ids(initial.body), ordered.slice(0, 10));
  assert.ok(initial.body.includes('data-cursor="' + first.nextCursor + '"'));
  // A new post must not shift the continuation. Deleting its boundary must not invalidate the cursor.
  const newPost = await Post.create({ user: viewer._id, date: new Date(), caption: 'Inserted after page one', picture: 'default-avatar.svg' });
  await Post.deleteMany({ _id: { $in: [ordered[9], ordered[12]] } });
  let cursor = first.nextCursor;
  const loaded = ids(first.html);
  const sizes = [];
  let lastCursor;
  while (cursor) {
    lastCursor = cursor;
    const page = await api('/feed?before=' + encodeURIComponent(cursor));
    const pageIds = ids(page.html);
    assert.ok(pageIds.length <= 10);
    assert.doesNotMatch(page.html, /Hidden post/);
    sizes.push(pageIds.length);
    loaded.push(...pageIds);
    cursor = page.nextCursor;
  }
  assert.deepEqual(sizes, [10, 4]);
  assert.deepEqual(loaded, ordered.filter(id => id !== ordered[12]));
  assert.equal(new Set(loaded).size, loaded.length);
  assert.ok(!loaded.includes(newPost.id));
  const refreshed = await api('/feed');
  assert.equal(ids(refreshed.html)[0], newPost.id);
  assert.equal((await api('/feed?before=' + encodeURIComponent(lastCursor))).nextCursor, null);
  const last = posts.find(post => post.id === ordered[24]);
  const end = await api('/feed?before=' + encodeURIComponent(last.date.toISOString() + '_' + last.id));
  assert.deepEqual(ids(end.html), []);
  assert.equal(end.nextCursor, null);
  for (const query of ['before=', 'before=invalid', 'before=x&before=y', 'before[$gt]=x',
    'before=' + encodeURIComponent('2026-02-31T00:00:00.000Z_' + newPost.id)]) {
    assert.equal((await request('/feed?' + query, { headers: { Accept: 'application/json' } })).status, 400);
  }
  const anonymous = await request('/feed?before=' + encodeURIComponent(first.nextCursor), {
    headers: { cookie: '', Accept: 'application/json' }
  });
  assert.equal(anonymous.status, 401);
  await User.updateOne({ _id: viewer._id }, { $set: { following: [] } });
  const afterUnfollow = await api('/feed?before=' + encodeURIComponent(first.nextCursor));
  const ownIds = new Set(posts.filter(post => String(post.user) === viewer.id).map(post => post.id));
  assert.ok(ids(afterUnfollow.html).every(id => ownIds.has(id)), 'each continuation uses the current follow list');
});
