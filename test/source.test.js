const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ejs = require('ejs');
const { formatRelativeTime } = require('../utils/utils');
const root = path.resolve(__dirname, '..');

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

test('all application JavaScript and EJS templates compile', function () {
  const files = ['app.js', 'bin/www'].map(file => path.join(root, file));
  for (const folder of ['routes', 'utils', 'public/javascripts', 'scripts', 'views']) files.push(...filesIn(path.join(root, folder)));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.ejs')) ejs.compile(source, { filename: file });
    else if (file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('bin' + path.sep + 'www')) new vm.Script(source, { filename: file });
  }
  // Render pages containing inline browser scripts and compile those scripts too.
  for (const file of files.filter(file => file.endsWith('.ejs') && !file.includes(path.sep + 'partials' + path.sep))) {
    const user = { id: 'test', username: 'test', posts: [], followers: [], following: [], saved: [], picture: 'default-avatar.svg' };
    const html = ejs.render(fs.readFileSync(file, 'utf8'), {
      footer: true, user, userprofile: user, posts: [], stories: [], notifications: [], dater: formatRelativeTime,
      story: { user, story: 'default-avatar.svg' }, message: 'Example error', error: { status: 404 },
      post: { id: 'post', user, caption: 'Example caption', picture: 'default-avatar.svg', like: [], comments: [], date: new Date() },
      postDetail: true,
    }, { filename: file });
    for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      new vm.Script(script, { filename: file });
    }
  }
});

test('relative times handle normal, future, and invalid dates', function () {
  assert.equal(formatRelativeTime(new Date(Date.now() - 65000)), '1m');
  assert.equal(formatRelativeTime(new Date(Date.now() - 2 * 3600000)), '2h');
  assert.equal(formatRelativeTime(new Date(Date.now() - 2 * 86400000)), '2d');
  assert.equal(formatRelativeTime(new Date(Date.now() - 8 * 86400000)), '1w');
  assert.equal(formatRelativeTime(new Date(Date.now() + 3600000)), '0s');
  assert.equal(formatRelativeTime('invalid date'), '');
});
