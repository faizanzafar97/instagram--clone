const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

async function browserScenario(imageBase64) {
  const checks = [];
  function check(condition, label) {
    if (!condition) throw new Error(label);
    checks.push(label);
  }
  async function waitFor(predicate) {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for browser update');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    const registration = await fetch('/register', {
      method: 'POST', body: new URLSearchParams({
        username: 'browser_tester', password: 'browser-test-password',
        name: '<img src=x onerror="window.unexpectedImage=true">', email: 'browser@example.com'
      })
    });
    check(registration.ok, 'Browser signup and session');
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    async function navigate(url) {
      await new Promise(resolve => {
        frame.onload = function () {
          if (frame.contentWindow.location.href !== 'about:blank') resolve();
        };
        frame.src = url;
      });
    }
    await navigate('/upload');
    const input = frame.contentDocument.querySelector('#imageinp');
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(imageBase64), value => value.charCodeAt(0));
    transfer.items.add(new File([bytes], 'browser-photo.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const preview = frame.contentDocument.querySelector('#imagepreview img');
    await preview.decode();
    check(preview.naturalWidth > 0, 'Selected image preview decodes');
    frame.contentDocument.querySelector('.story').click();
    check(frame.contentDocument.querySelector('.storyinput').checked, 'Story tab selects story');
    frame.contentDocument.querySelector('.post').click();
    check(frame.contentDocument.querySelector('.postinput').checked, 'Post tab selects post');
    frame.contentDocument.querySelector('textarea').value = 'Browser test photo';
    await new Promise(resolve => {
      frame.onload = resolve;
      frame.contentDocument.querySelector('#uploadform').requestSubmit();
    });
    check(frame.contentWindow.location.pathname === '/feed', 'Posting opens feed');
    const postImage = frame.contentDocument.querySelector('.postimg');
    await postImage.decode();
    check(postImage.naturalWidth > 0, 'Uploaded feed image decodes');
    const like = frame.contentDocument.querySelector('.likebutton');
    like.click();
    await waitFor(() => like.getAttribute('aria-pressed') === 'true');
    check(frame.contentDocument.querySelector('.likeval').textContent === '1 likes', 'Heart button updates likes');
    postImage.click();
    await waitFor(() => like.getAttribute('aria-pressed') === 'false');
    check(frame.contentDocument.querySelector('.likeval').textContent === '0 likes', 'Image click updates likes');
    const save = frame.contentDocument.querySelector('.savebutton');
    save.click();
    await waitFor(() => save.getAttribute('aria-pressed') === 'true');
    save.click();
    await waitFor(() => save.getAttribute('aria-pressed') === 'false');
    check(true, 'Save and unsave buttons update');
    frame.contentDocument.querySelector('.commenttoggle').click();
    const commentInput = frame.contentDocument.querySelector('.commentform textarea');
    await waitFor(() => !commentInput.disabled);
    const commentText = '<img src=x onerror="window.unexpectedComment=true">';
    commentInput.value = commentText;
    frame.contentDocument.querySelector('.commentform').requestSubmit();
    await waitFor(() => frame.contentDocument.querySelector('.comment-entry') && !commentInput.disabled);
    check(frame.contentDocument.querySelector('.comment-entry p').textContent === commentText &&
      !frame.contentDocument.querySelector('.comments-list img') && !frame.contentWindow.unexpectedComment,
      'Comments render text without HTML injection');
    frame.contentDocument.querySelector('.replybutton').click();
    check(!frame.contentDocument.querySelector('.reply-context').hidden, 'Reply selects the parent comment');
    commentInput.value = 'Browser reply';
    frame.contentDocument.querySelector('.commentform').requestSubmit();
    await waitFor(() => frame.contentDocument.querySelector('.comment-replies .comment-entry') && !commentInput.disabled);
    check(frame.contentDocument.querySelector('.commentcount').textContent === '2', 'Comment count includes replies');
    check(frame.contentDocument.querySelector('.reply-context').hidden, 'Posting a reply resets the form');
    await navigate('/feed');
    frame.contentDocument.querySelector('.commenttoggle').click();
    await waitFor(() => frame.contentDocument.querySelectorAll('.comment-entry').length === 2);
    check(frame.contentDocument.querySelector('.comment-replies p').textContent === 'Browser reply', 'Comments and replies survive reload');
    frame.contentDocument.querySelector('.commenttoggle').click();
    check(frame.contentDocument.querySelector('.comments-panel').hidden, 'Comments can be collapsed');
    const detailUrl = frame.contentDocument.querySelector('.postdetail-link').getAttribute('href');
    await new Promise(resolve => {
      frame.onload = resolve;
      frame.contentDocument.querySelector('.postdetail-link').click();
    });
    check(frame.contentWindow.location.pathname === detailUrl && frame.contentDocument.querySelectorAll('.post').length === 1,
      'View post opens a dedicated page for one post');
    await waitFor(() => frame.contentDocument.querySelectorAll('.comment-entry').length === 2);
    check(!frame.contentDocument.querySelector('.comments-panel').hidden, 'Post detail loads comments and replies automatically');
    const detailLike = frame.contentDocument.querySelector('.likebutton');
    detailLike.click();
    await waitFor(() => detailLike.getAttribute('aria-pressed') === 'true');
    detailLike.click();
    await waitFor(() => detailLike.getAttribute('aria-pressed') === 'false');
    const detailSave = frame.contentDocument.querySelector('.savebutton');
    detailSave.click();
    await waitFor(() => detailSave.getAttribute('aria-pressed') === 'true');
    detailSave.click();
    await waitFor(() => detailSave.getAttribute('aria-pressed') === 'false');
    check(true, 'Likes and saved posts work on the detail page');
    const detailInput = frame.contentDocument.querySelector('.commentform textarea');
    detailInput.value = 'Comment from the post detail';
    frame.contentDocument.querySelector('.commentform').requestSubmit();
    await waitFor(() => frame.contentDocument.querySelectorAll('.comment-entry').length === 3 && !detailInput.disabled);
    frame.contentDocument.querySelector('.replybutton').click();
    detailInput.value = 'Reply from the post detail';
    frame.contentDocument.querySelector('.commentform').requestSubmit();
    await waitFor(() => frame.contentDocument.querySelectorAll('.comment-entry').length === 4 && !detailInput.disabled);
    check(frame.contentDocument.querySelector('.comments-list').textContent.includes('Reply from the post detail'),
      'Comments and replies can be submitted from the detail page');
    await navigate('/profile');
    await new Promise(resolve => {
      frame.onload = resolve;
      frame.contentDocument.querySelector('.post a').click();
    });
    check(frame.contentWindow.location.pathname === detailUrl, 'Profile thumbnails open the post detail');
    frame.contentDocument.querySelector('.editpost').click();
    const captionInput = frame.contentDocument.querySelector('.editpostform textarea');
    check(captionInput.value === 'Browser test photo', 'Caption editor loads the current caption');
    captionInput.value = 'Discard this caption';
    frame.contentDocument.querySelector('.cancelpostedit').click();
    check(frame.contentDocument.querySelector('.post-caption').textContent === 'Browser test photo', 'Cancel preserves the caption');
    frame.contentDocument.querySelector('.editpost').click();
    const captionText = '<img src=x onerror="window.badCaption=true">\nEdited caption';
    captionInput.value = captionText;
    frame.contentDocument.querySelector('.editpostform').requestSubmit();
    await waitFor(() => frame.contentDocument.querySelector('.post-caption').textContent === captionText);
    check(!frame.contentDocument.querySelector('.post-caption img') && !frame.contentWindow.badCaption, 'Caption updates safely without reloading');
    await navigate('/feed');
    check(frame.contentDocument.querySelector('.post-caption').textContent === captionText, 'Edited caption survives reload');
    const postId = frame.contentDocument.querySelector('.post').dataset.postid;
    const ownerId = frame.contentDocument.querySelector('.posts.parent').dataset.userid;
    async function login(username, password) {
      const response = await fetch('/login', { method: 'POST', body: new URLSearchParams({ username, password }) });
      check(response.ok && new URL(response.url).pathname === '/feed', 'Notification test login: ' + username);
    }
    const newAccount = await fetch('/register', {
      method: 'POST', body: new URLSearchParams({ username: 'browser_new_account', password: 'new-account-password', name: 'New Account' })
    });
    check(newAccount.ok, 'A second account can be created in the same browser');
    await navigate('/profile');
    check(frame.contentDocument.querySelector('.nav h3').textContent === 'browser_new_account' &&
      !frame.contentDocument.querySelector('.post'), 'New account profile has its own identity and no inherited posts');
    await navigate('/feed');
    check(!frame.contentDocument.querySelector('.post'), 'New account does not see the previous account posts in its feed');
    await navigate('/logout');
    await login('browser_new_account', 'new-account-password');
    await navigate('/feed');
    check(!frame.contentDocument.querySelector('.post'), 'Logging in again keeps the new account feed empty');
    await login('browser_tester', 'browser-test-password');
    await navigate('/feed');
    check(frame.contentDocument.querySelector('.post').dataset.postid === postId, 'Switching back restores the original account own post');
    await login('browser_friend', 'browser-friend-password');
    await navigate(detailUrl);
    check(!frame.contentDocument.querySelector('.editpost') && !frame.contentDocument.querySelector('.deletepost'),
      'Visitors can view a post without seeing owner controls');
    await fetch('/like/' + postId);
    const notificationText = '<img src=x onerror="window.badNotification=true">';
    await fetch('/posts/' + postId + '/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: notificationText })
    });
    await fetch('/follow/' + ownerId);
    await login('browser_tester', 'browser-test-password');
    await navigate('/notifications');
    await waitFor(() => frame.contentDocument.querySelector('.notification-badge').textContent === '3');
    check(frame.contentDocument.querySelectorAll('.notification-item').length === 3, 'Likes, comments and follows appear in notifications');
    check(frame.contentDocument.querySelector('.notification-list').textContent.includes(notificationText) &&
      !frame.contentDocument.querySelector('.notification-item p img') && !frame.contentWindow.badNotification, 'Notifications escape comment text');
    const likeNotification = Array.from(frame.contentDocument.querySelectorAll('.notification-open'))
      .find(link => link.textContent.includes('liked your post'));
    await new Promise(resolve => { frame.onload = resolve; likeNotification.click(); });
    check(frame.contentWindow.location.pathname === '/posts/' + postId, 'Opening a notification navigates to its post');
    await waitFor(() => frame.contentDocument.querySelector('.notification-badge').textContent === '2');
    check(true, 'Opening a notification marks only that notification read');
    await navigate('/notifications');
    frame.contentDocument.querySelector('.mark-notifications-read').requestSubmit();
    await waitFor(() => frame.contentDocument.querySelector('.notifications-status').textContent.includes('All notifications marked'));
    check(Array.from(frame.contentDocument.querySelectorAll('.notification-unread')).every(item => item.hidden) &&
      frame.contentDocument.querySelector('.notification-badge').hidden, 'Mark all as read clears new indicators and the badge');
    await navigate('/notifications');
    check(Array.from(frame.contentDocument.querySelectorAll('.notification-item')).every(item => item.dataset.read === 'true'), 'Notification read status survives reload');
    await navigate(detailUrl);
    frame.contentDocument.querySelector('.deletepost').click();
    check(!frame.contentDocument.querySelector('.deletepostconfirm').hidden, 'Delete asks for confirmation');
    frame.contentDocument.querySelector('.cancelpostdelete').click();
    check(frame.contentDocument.querySelector('.deletepostconfirm').hidden && frame.contentDocument.querySelector('.post'), 'Cancel keeps the post');
    const deletedImageUrl = frame.contentDocument.querySelector('.postimg').getAttribute('src');
    frame.contentDocument.querySelector('.deletepost').click();
    await new Promise(resolve => {
      frame.onload = resolve;
      frame.contentDocument.querySelector('.confirmdeletepost').click();
    });
    check(frame.contentWindow.location.pathname === '/feed', 'Deleting from the detail page returns to the feed');
    check(frame.contentDocument.querySelector('.feedempty'), 'Deleting the last post displays an empty feed');
    check((await fetch(deletedImageUrl)).status === 404, 'Deleting a post removes its uploaded image');
    await navigate('/feed');
    check(!frame.contentDocument.querySelector('.post'), 'Deleted post stays removed after reload');
    await navigate('/profile');
    check(!frame.contentDocument.querySelector('.post'), 'Deleted post is removed from the profile');
    await navigate('/search');
    const search = frame.contentDocument.querySelector('.input');
    search.value = 'BROWSER_TESTER';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => frame.contentDocument.querySelector('.users a'));
    const results = frame.contentDocument.querySelector('.users');
    check(results.textContent.includes('<img src=x'), 'Search renders names as text');
    check(results.querySelectorAll('img').length === 1 && !frame.contentWindow.unexpectedImage, 'Search avoids HTML injection');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    check(results.children.length === 0, 'Clearing search clears results');
    await navigate('/profile/browser_friend');
    await new Promise(resolve => {
      frame.onload = resolve;
      frame.contentDocument.querySelector('a[href^="/follow/"]').click();
    });
    check(frame.contentDocument.querySelector('a[href^="/follow/"]').textContent === 'Following', 'Follow button updates profile');
    await login('browser_friend', 'browser-friend-password');
    await navigate('/notifications');
    check(frame.contentDocument.querySelectorAll('.notification-item').length === 1 &&
      frame.contentDocument.querySelector('.notification-list').textContent.includes('browser_tester'), 'Notifications belong to the signed-in recipient');
    const publicPost = await fetch('/posts/' + postId);
    check(publicPost.status === 404, 'Deleted posts cannot be opened at their detail URL');
    await navigate('/logout');
    check(frame.contentWindow.location.pathname === '/login', 'Logout returns to login');
    await fetch('/__browser-check-result', { method: 'POST', body: JSON.stringify({ ok: true, checks }) });
  } catch (error) {
    await fetch('/__browser-check-result', { method: 'POST', body: JSON.stringify({ ok: false, checks, error: error.stack }) });
  }
}

(async function () {
  const databaseName = 'instaclone_browser_' + randomUUID().replace(/-/g, '');
  const databaseUrl = new URL(process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017');
  databaseUrl.pathname = '/' + databaseName;
  process.env.MONGODB_URI = databaseUrl.toString();
  const app = require('../app');
  const mongoose = require('mongoose');
  const User = require('../routes/users');
  const Post = require('../routes/posts');
  let server, browser, temporaryDirectory, timer;
  try {
    await app.locals.databaseReady;
    await User.register(new User({ username: 'browser_friend', name: 'Browser Friend' }), 'browser-friend-password');
    const imageBase64 = (await fs.readFile(path.join(__dirname, '../public/images/logo.png'))).toString('base64');
    let report;
    const result = new Promise(resolve => { report = resolve; });
    server = http.createServer(function (req, res) {
      if (req.url === '/__browser-check') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<!doctype html><html><body><script>(' + browserScenario.toString() + ')(' + JSON.stringify(imageBase64) + ');</script></body></html>');
      }
      if (req.url === '/__browser-check-result') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => { res.end('OK'); report(JSON.parse(body)); });
        return;
      }
      app(req, res);
    });
    server.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'instaclone-browser-'));
    const candidates = [process.env.BROWSER_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
    let executable;
    for (const candidate of candidates) {
      try { await fs.access(candidate); executable = candidate; break; } catch (_) {}
    }
    if (!executable) throw new Error('Set BROWSER_PATH to a Chrome or Edge executable');
    browser = spawn(executable, [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--user-data-dir=' + temporaryDirectory, '--remote-debugging-port=0',
      'http://127.0.0.1:' + server.address().port + '/__browser-check'
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let browserErrors = '';
    browser.stderr.on('data', chunk => { browserErrors = (browserErrors + chunk).slice(-2000); });
    const browserExit = new Promise((resolve, reject) => {
      browser.once('error', reject);
      browser.once('exit', code => reject(new Error('Browser exited with code ' + code + '\n' + browserErrors)));
    });
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Browser checks timed out\n' + browserErrors)), 30000);
    });
    const outcome = await Promise.race([result, browserExit, timeout]);
    for (const label of outcome.checks) console.log('PASS ' + label);
    assert.equal(outcome.ok, true, outcome.error);
    console.log(outcome.checks.length + ' browser checks passed');
  } finally {
    clearTimeout(timer);
    if (browser && browser.exitCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      await exited;
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.name === databaseName) {
      const posts = await Post.find().select('picture').lean();
      for (const post of posts) {
        if (/^[a-f0-9]{32}\.png$/.test(post.picture)) await fs.unlink(path.join(__dirname, '../public/images/uploads', post.picture));
      }
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
    if (temporaryDirectory && path.dirname(path.resolve(temporaryDirectory)) === path.resolve(os.tmpdir()) &&
        path.basename(temporaryDirectory).startsWith('instaclone-browser-')) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
