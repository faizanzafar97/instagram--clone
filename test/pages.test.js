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

test('pages, authentication, and route failures', { timeout: 30000 }, async function (t) {
  let server;
  let cookie = '';
  const uploadedFiles = [];
  t.after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const filename of uploadedFiles) {
      await fs.unlink(path.join(__dirname, '../public/images/uploads', filename));
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
    for (const url of ['/feed', '/profile', '/search', '/edit', '/upload', '/like/invalid']) {
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
    const response = await request('/feed');
    assert.equal(response.status, 200);
    assert.match(response.body, /Visible test post/);
    assert.doesNotMatch(response.body, /Deleted author/);
    assert.equal((await request('/story/' + story.id)).status, 200);
    assert.equal((await request('/profile/other_user')).status, 200);
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
      assert.equal(response.status, example.status, JSON.stringify(example));
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
