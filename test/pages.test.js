const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

// Each run uses its own database; never run the checks against application data.
const databaseName = 'instaclone_test_' + randomUUID().replace(/-/g, '');
const databaseUrl = new URL(process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017');
databaseUrl.pathname = '/' + databaseName;
process.env.MONGODB_URI = databaseUrl.toString();
const app = require('../app');
const mongoose = require('mongoose');
const User = require('../routes/users');
const Post = require('../routes/posts');
const Story = require('../routes/story');
const Notification = require('../routes/notifications');
const { removeExpiredStories } = require('../utils/story-expiration');

test('pages, authentication, and route failures', { timeout: 30000 }, async function (t) {
  let server;
  let cookie = '';
  const uploadedFiles = [];
  t.after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const filename of uploadedFiles) {
      await fs.rm(path.join(__dirname, '../public/images/uploads', filename), { force: true });
    }
    if (mongoose.connection.name === databaseName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await mongoose.connection.asPromise();
  await User.init();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;

  async function request(url, options = {}) {
    const response = await fetch(baseUrl + url, {
      ...options,
      headers: { cookie, ...options.headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return {
      status: response.status,
      location: response.headers.get('location'),
      contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
      body: await response.text(),
    };
  }

  function form(url, values) {
    return request(url, { method: 'POST', body: new URLSearchParams(values) });
  }

  await t.test('public pages load and protected pages redirect to login', async function () {
    for (const url of ['/', '/login', '/stylesheets/style.css', '/images/uploads/default-avatar.svg']) {
      assert.equal((await request(url)).status, 200, url);
    }
    for (const url of ['/feed', '/profile', '/search', '/edit', '/upload', '/like/invalid', '/notifications', '/posts/invalid']) {
      const response = await request(url);
      assert.equal(response.status, 302, url);
      assert.equal(response.location, '/login', url);
    }
    assert.equal((await request('/users')).status, 404);
  });

  await t.test('signup creates a session and all authenticated pages render', async function () {
    const response = await form('/register', {
      username: 'page_tester', password: 'test-password', email: 'test@example.com', name: 'Page Tester',
    });
    assert.equal(response.status, 302);
    assert.equal(response.location, '/profile');
    for (const url of ['/feed', '/profile', '/search', '/edit', '/upload']) {
      assert.equal((await request(url)).status, 200, url);
    }
    assert.match((await request('/feed')).body, /No posts yet\./);
    assert.equal((await request('/profile/page_tester')).location, '/profile');
    assert.equal((await request('/story')).location, '/upload');
  });

  await t.test('invalid requests respond without crashing or hanging', async function () {
    assert.equal((await form('/register', { username: 'page_tester', password: 'test-password' })).status, 409);
    assert.equal((await form('/register', { username: 'no_password' })).status, 400);
    assert.equal((await request('/profile/missing_user')).status, 404);
    assert.equal((await request('/like/invalid')).status, 400);
    assert.equal((await request('/like/' + new mongoose.Types.ObjectId())).status, 404);
    assert.equal((await form('/post', { category: 'post' })).status, 400);
    assert.equal((await form('/upload', {})).status, 400);
    assert.equal((await request('/search/' + encodeURIComponent('['))).status, 200);
    assert.equal((await request('/feed')).status, 200);
  });

  await t.test('existing accounts using def.png receive a valid avatar on every page', async function () {
    await User.updateOne({ username: 'page_tester' }, { picture: 'def.png' });
    for (const url of ['/feed', '/profile', '/edit', '/upload']) {
      const page = await request(url);
      assert.equal(page.status, 200);
      const images = [...page.body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)];
      assert.ok(images.length > 0, url);
      for (const [, src] of images) {
        const image = await request(src);
        assert.equal(image.status, 200, src);
        assert.match(image.contentType, /^image\//, src);
      }
    }
    const avatar = await request('/images/uploads/def.png');
    assert.match(avatar.contentType, /^image\/svg\+xml/);
    assert.match(avatar.body, /<svg/);
  });

  await t.test('feed renders posts and stories and skips deleted authors', async function () {
    const author = await User.create({ username: 'other_user', name: 'Other User' });
    const missingAuthor = new mongoose.Types.ObjectId();
    await Post.create([
      { user: author._id, caption: 'Visible test post', picture: 'default-avatar.svg' },
      { user: missingAuthor, caption: 'Deleted author', picture: 'default-avatar.svg' },
    ]);
    const story = await Story.create({ user: author._id, story: 'default-avatar.svg' });
    await Story.create({ user: missingAuthor, story: 'default-avatar.svg' });
    await request('/follow/' + author.id);
    const response = await request('/feed');
    assert.equal(response.status, 200);
    assert.match(response.body, /Visible test post/);
    assert.doesNotMatch(response.body, /Deleted author/);
    assert.equal((await request('/story/' + story.id)).status, 200);
    assert.equal((await request('/profile/other_user')).status, 200);
    await request('/follow/' + author.id);
  });

  await t.test('stories expire at exactly 24 hours in the feed and both story routes', async function () {
    const owner = await User.findOne({ username: 'page_tester' });
    const author = await User.create({ username: 'story_expiration_author' });
    const expiredAuthor = await User.create({ username: 'expired_story_author' });
    const realNow = Date.now;
    let now = realNow();
    const cutoff = now - 24 * 60 * 60 * 1000;
    // Insert an old-format record directly: existing stories need no migration.
    const legacy = await Story.collection.insertOne({ user: author._id, story: 'default-avatar.svg', date: new Date(cutoff - 1) });
    const boundary = await Story.create({ user: expiredAuthor._id, story: 'default-avatar.svg', date: new Date(cutoff) });
    const inside = await Story.create({ user: author._id, story: 'default-avatar.svg', date: new Date(cutoff + 1) });
    const ownExpired = await Story.create({ user: owner._id, story: 'default-avatar.svg', date: new Date(cutoff) });
    Date.now = () => now;
    try {
      const page = await request('/feed');
      assert.equal(page.status, 200);
      assert.ok(page.body.includes('/story/' + inside.id));
      for (const id of [legacy.insertedId, boundary.id, ownExpired.id]) {
        assert.ok(!page.body.includes('/story/' + id));
        assert.equal((await request('/story/' + id)).status, 404);
      }
      assert.equal((await request('/story/' + inside.id)).status, 200);
      assert.equal((await request('/story')).location, '/upload', 'an expired own story is not reopened');
      assert.equal((await request('/story/invalid')).status, 400);
      now += 1;
      assert.equal((await request('/story/' + inside.id)).status, 404, 'the story expires at the exact millisecond boundary');
      assert.ok(!(await request('/feed')).body.includes('/story/' + inside.id));
    } finally { Date.now = realNow; }
  });

  await t.test('expired story cleanup removes records, references and unshared images while preserving active content', async function () {
    const author = await User.findOne({ username: 'story_expiration_author' });
    const now = Date.now();
    const expiredDate = new Date(now - 24 * 60 * 60 * 1000);
    const filenames = Array.from({ length: 4 }, () => randomUUID().replace(/-/g, '') + '.png');
    const image = await fs.readFile(path.join(__dirname, '../public/images/logo.png'));
    for (const filename of filenames) {
      uploadedFiles.push(filename);
      await fs.writeFile(path.join(__dirname, '../public/images/uploads', filename), image);
    }
    const expired = await Story.create(filenames.map(story => ({ user: author._id, story, date: expiredDate })));
    const active = await Story.create({ user: author._id, story: filenames[1] });
    const post = await Post.create({ user: author._id, picture: filenames[2], caption: 'Shared story image' });
    await User.updateOne({ _id: author._id }, {
      $set: { picture: filenames[3] }, $addToSet: { stories: { $each: [...expired.map(story => story._id), active._id] } }
    });
    assert.ok(await removeExpiredStories(now) >= 4);
    for (const story of expired) assert.equal(await Story.findById(story._id), null);
    assert.ok(await Story.findById(active._id));
    assert.deepEqual((await User.findById(author._id)).stories.map(String), [active.id]);
    await assert.rejects(fs.access(path.join(__dirname, '../public/images/uploads', filenames[0])), { code: 'ENOENT' });
    for (const filename of filenames.slice(1)) await fs.access(path.join(__dirname, '../public/images/uploads', filename));
    assert.ok(await Post.findById(post._id));
    assert.equal((await request('/images/uploads/default-avatar.svg')).status, 200);
    assert.equal(await removeExpiredStories(now), 0, 'cleanup can safely run again');
  });

  await t.test('image uploads create posts and stories that load in the feed', async function () {
    const image = await fs.readFile(path.join(__dirname, '../public/images/logo.png'));
    for (const category of ['post', 'story']) {
      const body = new FormData();
      body.set('category', category);
      body.set('caption', 'Uploaded test image');
      body.set('image', new Blob([image], { type: 'image/png' }), 'test.png');
      const response = await request('/post', { method: 'POST', body });
      const owner = await User.findOne({ username: 'page_tester' });
      const document = category === 'post'
        ? await Post.findOne({ user: owner._id })
        : await Story.findOne({ user: owner._id });
      assert.ok(document);
      const filename = category === 'post' ? document.picture : document.story;
      uploadedFiles.push(filename);
      assert.equal(response.status, 302);
      assert.equal(response.location, '/feed');
      const servedImage = await fetch(baseUrl + '/images/uploads/' + filename);
      assert.equal(servedImage.status, 200);
      assert.match(servedImage.headers.get('content-type'), /^image\/png/);
      assert.deepEqual(Buffer.from(await servedImage.arrayBuffer()), image);
    }
    const body = new FormData();
    body.set('image', new Blob([image], { type: 'image/png' }), 'avatar.png');
    const profileUpload = await request('/upload', { method: 'POST', body });
    const owner = await User.findOne({ username: 'page_tester' });
    uploadedFiles.push(owner.picture);
    assert.equal(profileUpload.location, '/edit');
    const profile = await request('/profile');
    assert.ok(profile.body.includes('/images/uploads/' + owner.picture));
    const avatar = await fetch(baseUrl + '/images/uploads/' + owner.picture);
    assert.equal(avatar.status, 200);
    assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), image);
    assert.equal((await request('/feed')).status, 200);
    assert.match((await request('/story')).location, /^\/story\//);
  });

  await t.test('registering and logging in to another account does not inherit the previous account posts', async function () {
    const originalUser = await User.findOne({ username: 'page_tester' });
    const originalPost = await Post.findOne({ user: originalUser._id });
    assert.ok((await request('/feed')).body.includes('data-postid="' + originalPost.id + '"'));
    const registered = await form('/register', { username: 'fresh_account', password: 'fresh-account-password', name: 'Fresh Account' });
    assert.equal(registered.location, '/profile');
    const freshUser = await User.findOne({ username: 'fresh_account' });
    let feed = await request('/feed');
    assert.equal(feed.cacheControl, 'no-store');
    assert.ok(feed.body.includes('data-userid="' + freshUser.id + '"'));
    assert.match(feed.body, /No posts yet\./);
    assert.doesNotMatch(feed.body, /class="postimg/);
    let profile = await request('/profile');
    assert.match(profile.body, /Fresh Account/);
    assert.match(profile.body, /no posts yet\./);
    assert.equal(profile.cacheControl, 'no-store');
    assert.ok(!profile.body.includes(originalPost.picture));
    await request('/logout');
    assert.equal((await form('/login', { username: 'fresh_account', password: 'fresh-account-password' })).location, '/feed');
    assert.match((await request('/feed')).body, /No posts yet\./);
    const freshPost = await Post.create({ user: freshUser._id, caption: 'Fresh account photo', picture: 'default-avatar.svg' });
    await User.updateOne({ _id: freshUser._id }, { $addToSet: { posts: freshPost._id } });
    feed = await request('/feed');
    assert.match(feed.body, /Fresh account photo/);
    assert.ok(!feed.body.includes('data-postid="' + originalPost.id + '"'));
    await request('/follow/' + originalUser.id);
    feed = await request('/feed');
    assert.ok(feed.body.includes('data-postid="' + originalPost.id + '"'), 'following an account adds its posts');
    assert.match(feed.body, /Fresh account photo/);
    profile = await request('/profile');
    assert.ok(!profile.body.includes(originalPost.picture), 'following does not add posts to your profile');
    await request('/follow/' + originalUser.id);
    assert.ok(!(await request('/feed')).body.includes('data-postid="' + originalPost.id + '"'), 'unfollowing removes its posts');
    await form('/login', { username: 'page_tester', password: 'test-password' });
    feed = await request('/feed');
    assert.ok(feed.body.includes('data-postid="' + originalPost.id + '"'));
    assert.doesNotMatch(feed.body, /Fresh account photo/);
    assert.ok((await request('/profile')).body.includes(originalPost.picture));
    assert.equal((await Post.findById(originalPost._id)).user.toString(), originalUser.id);
  });

  await t.test('query rejections reach the error page and the server stays available', async function () {
    const originalFind = Post.find;
    Post.find = function () { throw new Error('Simulated database query failure'); };
    try {
      const response = await request('/feed');
      assert.equal(response.status, 500);
      assert.match(response.body, /Simulated database query failure/);
    } finally {
      Post.find = originalFind;
    }
    assert.equal((await request('/feed')).status, 200);
  });

  await t.test('likes, saved posts and follows toggle consistently', async function () {
    const owner = await User.findOne({ username: 'page_tester' });
    const other = await User.findOne({ username: 'other_user' });
    const post = await Post.findOne({ user: other._id });
    for (const enabled of [true, false]) {
      const liked = await request('/like/' + post.id, { headers: { Accept: 'application/json' } });
      assert.equal(liked.status, 200);
      assert.equal(JSON.parse(liked.body).like.includes(owner.id), enabled);
      const saved = await request('/save/' + post.id);
      assert.equal(saved.status, 200);
      assert.deepEqual(Object.keys(JSON.parse(saved.body)), ['saved']);
      assert.equal(JSON.parse(saved.body).saved.includes(post.id), enabled);
      const followed = await request('/follow/' + other.id);
      assert.equal(followed.location, '/profile/other_user');
      const updatedOwner = await User.findById(owner._id);
      const updatedOther = await User.findById(other._id);
      assert.equal(updatedOwner.following.includes(other._id), enabled);
      assert.equal(updatedOther.followers.includes(owner._id), enabled);
    }
    assert.equal((await request('/follow/' + owner.id)).status, 400);
    assert.equal((await request('/follow/invalid')).status, 400);
    assert.equal((await request('/save/invalid')).status, 400);
  });

  await t.test('search is case insensitive and only returns public profile fields', async function () {
    const response = await request('/search/PAGE');
    assert.equal(response.status, 200);
    const users = JSON.parse(response.body);
    assert.equal(users[0].username, 'page_tester');
    assert.deepEqual(Object.keys(users[0]).sort(), ['_id', 'name', 'picture', 'username']);
  });

  await t.test('comments and replies persist, validate their parent, and expose only public authors', async function () {
    const owner = await User.findOne({ username: 'page_tester' });
    const other = await User.findOne({ username: 'other_user' });
    const post = await Post.findOne({ user: other._id });
    const ownPost = await Post.findOne({ user: owner._id });
    const url = '/posts/' + post.id + '/comments';
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const submit = (values, pathname = url) => request(pathname, {
      method: 'POST', headers, body: JSON.stringify(values)
    });
    assert.deepEqual(JSON.parse((await request(url)).body), { comments: [] });
    for (const method of ['GET', 'POST']) {
      const response = await request(url, {
        method, headers: { ...headers, cookie: '' },
        ...(method === 'POST' ? { body: JSON.stringify({ text: 'Anonymous' }) } : {})
      });
      assert.equal(response.status, 401);
    }
    for (const text of [undefined, '', '   ', 'x'.repeat(1001), {}, ['bad']]) {
      assert.equal((await submit({ text })).status, 400);
    }
    const payload = '<img src=x onerror="window.unexpectedComment=true">';
    const created = await submit({ text: '  ' + payload + '  ', user: other.id });
    assert.equal(created.status, 201);
    const comment = JSON.parse(created.body).comment;
    assert.equal(comment.text, payload);
    assert.equal(comment.user._id, owner.id, 'author always comes from the session');
    assert.equal(comment.parent, null);
    assert.deepEqual(Object.keys(comment.user).sort(), ['_id', 'picture', 'username']);
    const reply = await submit({ text: 'A reply', parent: comment._id });
    assert.equal(reply.status, 201);
    const replyComment = JSON.parse(reply.body).comment;
    assert.equal(replyComment.parent, comment._id);
    assert.equal((await submit({ text: 'Nested reply', parent: replyComment._id })).status, 404);
    assert.equal((await submit({ text: 'Wrong post', parent: comment._id }, '/posts/' + ownPost.id + '/comments')).status, 404);
    assert.equal((await submit({ text: 'Missing parent', parent: new mongoose.Types.ObjectId().toString() })).status, 404);
    for (const parent of ['invalid', '', {}, []]) {
      assert.equal((await submit({ text: 'Bad parent', parent })).status, 400);
    }
    for (const [id, expected] of [['invalid', 400], [new mongoose.Types.ObjectId(), 404]]) {
      const missingUrl = '/posts/' + id + '/comments';
      assert.equal((await request(missingUrl)).status, expected);
      assert.equal((await submit({ text: 'Missing post' }, missingUrl)).status, expected);
    }
    const concurrent = await Promise.all([submit({ text: 'First simultaneous comment' }), submit({ text: 'Second simultaneous comment' })]);
    assert.ok(concurrent.every(response => response.status === 201));
    const loaded = JSON.parse((await request(url)).body).comments;
    assert.equal(loaded.length, 4);
    assert.equal(loaded[0].text, payload);
    assert.equal(loaded[1].parent, comment._id);
    assert.deepEqual(Object.keys(loaded[0].user).sort(), ['_id', 'picture', 'username']);
    assert.equal((await Post.findById(post._id)).comments.length, 4);
    await request('/follow/' + other.id);
    const feed = await request('/feed');
    assert.equal(feed.status, 200);
    assert.match(feed.body, /class="commentcount">4<\/span>/);
    await request('/follow/' + other.id);
  });

  await t.test('individual post pages show one public post and keep owner actions private', async function () {
    const viewer = await User.findOne({ username: 'page_tester' });
    const author = await User.findOne({ username: 'other_user' });
    const post = await Post.findOne({ user: author._id });
    const ownPost = await Post.findOne({ user: viewer._id });
    const page = await request('/posts/' + post.id);
    assert.equal(page.status, 200);
    assert.equal(page.cacheControl, 'no-store');
    assert.match(page.body, /Visible test post/);
    assert.ok(page.body.includes('/profile/' + author.username));
    assert.ok(page.body.includes('/images/uploads/' + post.picture));
    assert.ok(page.body.includes('data-userid="' + viewer.id + '"'));
    assert.equal((page.body.match(/class="post mt-10/g) || []).length, 1);
    assert.match(page.body, /aria-label="Hide comments" aria-expanded="true"/);
    assert.match(page.body, /class="commentcount">4<\/span>/);
    assert.doesNotMatch(page.body, /class="editpost text-blue-500"/);
    assert.doesNotMatch(page.body, /class="deletepost text-red-500"/);
    const ownPage = await request('/posts/' + ownPost.id);
    assert.equal(ownPage.status, 200);
    assert.match(ownPage.body, /class="editpost text-blue-500"/);
    assert.match(ownPage.body, /class="deletepost text-red-500"/);
    assert.ok((await request('/feed')).body.includes('href="/posts/' + ownPost.id + '"'));
    assert.ok((await request('/profile')).body.includes('href="/posts/' + ownPost.id + '"'));
    await User.updateOne({ _id: author._id }, { $addToSet: { posts: post._id } });
    assert.ok((await request('/profile/' + author.username)).body.includes('href="/posts/' + post.id + '"'));
    assert.equal((await request('/posts/invalid')).status, 400);
    assert.equal((await request('/posts/' + new mongoose.Types.ObjectId())).status, 404);
    const orphan = await Post.findOne({ caption: 'Deleted author' });
    assert.equal((await request('/posts/' + orphan.id)).status, 404);
    assert.equal((await request('/posts/' + post.id, { headers: { cookie: '', Accept: 'application/json' } })).status, 401);
  });

  await t.test('notifications are private, persist read status, and track likes, comments and follows', async function () {
    const actor = await User.findOne({ username: 'page_tester' });
    const recipient = await User.findOne({ username: 'other_user' });
    const post = await Post.findOne({ user: recipient._id });
    const ownPost = await Post.findOne({ user: actor._id });
    await Notification.deleteMany({});
    await recipient.setPassword('notification-test-password');
    await recipient.save();
    const headers = { Accept: 'application/json' };
    const count = async () => JSON.parse((await request('/notifications/unread-count', { headers })).body).unreadCount;
    for (const [url, method] of [['/notifications/unread-count', 'GET'], ['/notifications/read', 'POST'], ['/notifications/' + new mongoose.Types.ObjectId() + '/read', 'POST']]) {
      assert.equal((await request(url, { method, headers: { ...headers, cookie: '' } })).status, 401);
    }
    const empty = await request('/notifications');
    assert.equal(empty.status, 200);
    assert.match(empty.body, /No notifications yet/);
    await request('/like/' + ownPost.id);
    await form('/posts/' + ownPost.id + '/comments', { text: 'My own post' });
    assert.equal(await Notification.countDocuments(), 0, 'self actions do not notify');
    await request('/like/' + ownPost.id);
    await request('/like/' + post.id);
    await request('/follow/' + recipient.id);
    const text = '<img src=x onerror="window.badNotification=true">';
    await form('/posts/' + post.id + '/comments', { text });
    const notifications = await Notification.find({ recipient: recipient._id });
    assert.equal(notifications.length, 3);
    assert.deepEqual(notifications.map(item => item.type).sort(), ['comment', 'follow', 'like']);
    assert.equal(await count(), 0, 'actor cannot see the recipient unread count');
    assert.doesNotMatch((await request('/notifications')).body, /notification-item border/);
    const target = notifications.find(item => item.type === 'like');
    assert.equal((await request('/notifications/' + target.id + '/read', { method: 'POST', headers })).status, 404);
    await request('/notifications/read', { method: 'POST', headers });
    assert.equal(await Notification.countDocuments({ recipient: recipient._id, read: false }), 3, 'mark all is scoped to the session');
    await form('/login', { username: recipient.username, password: 'notification-test-password' });
    assert.equal(await count(), 3);
    const page = await request('/notifications');
    assert.equal(page.status, 200);
    assert.match(page.body, /page_tester/);
    assert.match(page.body, /liked your post/);
    assert.match(page.body, /commented on your post/);
    assert.match(page.body, /started following you/);
    assert.match(page.body, /&lt;img src=x/);
    assert.doesNotMatch(page.body, /<img src=x/);
    assert.ok(page.body.includes('/posts/' + post.id));
    assert.ok(page.body.includes('/profile/page_tester'));
    assert.equal((await request('/notifications/' + target.id + '/read', { method: 'POST', headers })).status, 200);
    assert.equal(await count(), 2);
    assert.equal((await request('/notifications/' + target.id + '/read', { method: 'POST', headers })).status, 200);
    assert.equal(await count(), 2, 'marking one notification read is idempotent');
    assert.equal((await request('/notifications/invalid/read', { method: 'POST', headers })).status, 400);
    const marked = await request('/notifications/read', { method: 'POST', headers });
    assert.equal(JSON.parse(marked.body).unreadCount, 0);
    assert.equal(await count(), 0);
    assert.equal(await Notification.countDocuments({ recipient: recipient._id, read: true }), 3);
    await form('/login', { username: actor.username, password: 'test-password' });
    await request('/like/' + post.id);
    await request('/follow/' + recipient.id);
    assert.equal(await Notification.countDocuments({ type: { $in: ['like', 'follow'] } }), 0, 'undoing actions removes their notifications');
    await request('/like/' + post.id);
    await request('/follow/' + recipient.id);
    assert.equal(await Notification.countDocuments({ recipient: recipient._id, read: false }), 2, 'new actions create new unread notifications');
    await request('/like/' + post.id);
    await request('/follow/' + recipient.id);
  });

  await t.test('only post owners can edit captions or delete posts, images and saved references', async function () {
    const owner = await User.findOne({ username: 'page_tester' });
    const other = await User.findOne({ username: 'other_user' });
    const post = await Post.findOne({ user: owner._id });
    const otherPost = await Post.findOne({ user: other._id });
    const url = '/posts/' + post.id;
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const edit = (values, pathname = url) => request(pathname, { method: 'PATCH', headers, body: JSON.stringify(values) });
    for (const method of ['PATCH', 'DELETE']) {
      assert.equal((await request(url, {
        method, headers: { ...headers, cookie: '' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ caption: 'Anonymous edit' }) } : {})
      })).status, 401);
      const forbidden = await request('/posts/' + otherPost.id, {
        method, headers, ...(method === 'PATCH' ? { body: JSON.stringify({ caption: 'Stolen post', user: owner.id }) } : {})
      });
      assert.equal(forbidden.status, 403);
      for (const [id, expected] of [['invalid', 400], [new mongoose.Types.ObjectId(), 404]]) {
        assert.equal((await request('/posts/' + id, {
          method, headers, ...(method === 'PATCH' ? { body: JSON.stringify({ caption: 'Missing post' }) } : {})
        })).status, expected);
      }
    }
    assert.equal((await Post.findById(otherPost._id)).caption, otherPost.caption);
    for (const caption of [undefined, null, {}, [], 'x'.repeat(2201)]) {
      assert.equal((await edit({ caption })).status, 400);
    }
    const caption = '<img src=x onerror="window.badCaption=true">\nUpdated caption';
    const edited = await edit({ caption: '  ' + caption + '  ', user: other.id, picture: 'changed.png' });
    assert.equal(edited.status, 200);
    assert.equal(JSON.parse(edited.body).caption, caption);
    const stored = await Post.findById(post._id);
    assert.equal(stored.caption, caption);
    assert.equal(stored.picture, post.picture);
    assert.equal(String(stored.user), owner.id);
    assert.equal(stored.date.toISOString(), post.date.toISOString());
    const feed = await request('/feed');
    assert.match(feed.body, /&lt;img src=x/);
    assert.doesNotMatch(feed.body, /<img src=x/);
    assert.equal((feed.body.match(/class="editpost text-blue-500"/g) || []).length, 1);
    assert.equal((await edit({ caption: '' })).status, 200, 'captions can be cleared');
    await User.updateMany({ _id: { $in: [owner._id, other._id] } }, { $addToSet: { saved: post._id } });
    const comment = await request(url + '/comments', {
      method: 'POST', headers, body: JSON.stringify({ text: 'Removed with the post' })
    });
    assert.equal(comment.status, 201);
    await Notification.create({ recipient: other._id, actor: owner._id, type: 'like', post: post._id });
    const deleted = await request(url, { method: 'DELETE', headers });
    assert.equal(deleted.status, 200);
    assert.equal(await Post.findById(post._id), null);
    assert.equal(await Notification.countDocuments({ post: post._id }), 0);
    await assert.rejects(fs.access(path.join(__dirname, '../public/images/uploads', post.picture)), { code: 'ENOENT' });
    uploadedFiles.splice(uploadedFiles.indexOf(post.picture), 1);
    for (const id of [owner._id, other._id]) {
      const user = await User.findById(id);
      assert.equal(user.posts.includes(post._id), false);
      assert.equal(user.saved.includes(post._id), false);
    }
    assert.equal((await request(url + '/comments')).status, 404);
    assert.equal((await request(url)).status, 404);
    assert.equal((await request(url, { method: 'DELETE', headers })).status, 404);
    assert.doesNotMatch((await request('/profile')).body, new RegExp(post.picture));
    assert.equal((await request('/images/uploads/default-avatar.svg')).status, 200);
  });

  await t.test('profile validation rejects invalid and duplicate usernames without breaking the session', async function () {
    for (const username of ['', '  ', '../invalid', 'other_user']) {
      const response = await form('/update', { username, name: 'Name', bio: 'Bio' });
      assert.equal(response.status, username === 'other_user' ? 409 : 400);
      assert.equal((await request('/profile')).status, 200);
      assert.ok(await User.exists({ username: 'page_tester' }));
    }
    const changed = await form('/update', { username: 'renamed_tester', name: 'Renamed Tester', bio: 'Updated bio' });
    assert.equal(changed.location, '/profile');
    assert.match((await request('/profile')).body, /renamed_tester/);
    assert.equal((await request('/feed')).status, 200);
    await form('/update', { username: 'page_tester', name: 'Page Tester', bio: '' });
    for (const values of [
      { username: '../invalid', password: 'test' },
      { username: 'valid_name', password: 'test', email: 'invalid' },
    ]) assert.equal((await form('/register', values)).status, 400);
  });

  await t.test('invalid uploads return clear errors and leave no files behind', async function () {
    const uploadDirectory = path.join(__dirname, '../public/images/uploads');
    const before = (await fs.readdir(uploadDirectory)).sort();
    const validImage = await fs.readFile(path.join(__dirname, '../public/images/logo.png'));
    for (const example of [
      { type: 'text/plain', bytes: Buffer.from('not an image'), status: 400 },
      { type: 'image/png', bytes: Buffer.from('not a PNG despite its MIME type'), status: 400 },
      { type: 'image/png', bytes: validImage, category: 'invalid', status: 400 },
      { type: 'image/png', bytes: Buffer.alloc(5 * 1024 * 1024 + 1), status: 413 },
      { type: 'image/png', bytes: validImage, field: 'wrong_field', status: 400 },
    ]) {
      const body = new FormData();
      body.set('category', example.category || 'post');
      body.set(example.field || 'image', new Blob([example.bytes], { type: example.type }), 'test.png');
      const response = await request('/post', { method: 'POST', body, headers: { Accept: 'application/json' } });
      assert.equal(response.status, example.status, example.type + ' / ' + (example.category || 'post'));
      assert.equal(typeof JSON.parse(response.body).message, 'string');
      assert.deepEqual((await fs.readdir(uploadDirectory)).sort(), before);
    }
  });

  await t.test('a failed post reference update removes the new post and its upload', async function () {
    const uploadDirectory = path.join(__dirname, '../public/images/uploads');
    const beforeFiles = (await fs.readdir(uploadDirectory)).sort();
    const beforePosts = await Post.countDocuments();
    const originalUpdate = User.updateOne;
    User.updateOne = function () { throw new Error('Simulated post reference failure'); };
    try {
      const body = new FormData();
      body.set('category', 'post');
      body.set('image', new Blob([await fs.readFile(path.join(__dirname, '../public/images/logo.png'))], { type: 'image/png' }), 'test.png');
      const response = await request('/post', { method: 'POST', body });
      assert.equal(response.status, 500);
    } finally { User.updateOne = originalUpdate; }
    assert.equal(await Post.countDocuments(), beforePosts);
    assert.deepEqual((await fs.readdir(uploadDirectory)).sort(), beforeFiles);
  });

  await t.test('logout and login preserve the feed access rules', async function () {
    assert.equal((await request('/logout')).location, '/login');
    assert.equal((await request('/feed')).location, '/login');
    const expiredApi = await request('/like/invalid', { headers: { Accept: 'application/json' } });
    assert.equal(expiredApi.status, 401);
    assert.equal(JSON.parse(expiredApi.body).loginUrl, '/login');
    assert.equal((await form('/login', { username: 'page_tester', password: 'wrong' })).location, '/login');
    assert.equal((await form('/login', { username: 'page_tester', password: 'test-password' })).location, '/feed');
    assert.equal((await request('/feed')).status, 200);
  });
});
