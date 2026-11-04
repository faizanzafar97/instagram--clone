const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');

test('database outage preserves public pages and returns a bounded 503 for writes', { timeout: 15000 }, async function () {
  const source = `
    const assert = require('node:assert/strict');
    const app = require('./app');
    const mongoose = require('mongoose');
    const server = app.listen(0, '127.0.0.1', async function () {
      try {
        await app.locals.databaseReady.catch(() => {});
        const url = 'http://127.0.0.1:' + server.address().port;
        for (const pathname of ['/', '/login', '/images/uploads/default-avatar.svg']) {
          const response = await fetch(url + pathname, { signal: AbortSignal.timeout(2000) });
          assert.equal(response.status, 200, pathname);
          await response.arrayBuffer();
        }
        const response = await fetch(url + '/register', {
          method: 'POST', headers: { Accept: 'application/json' },
          body: new URLSearchParams({username:'test', password:'test'}),
          signal: AbortSignal.timeout(2000)
        });
        assert.equal(response.status, 503);
        assert.match((await response.json()).message, /Database unavailable/);
        console.log('DATABASE_OUTAGE_CHECK_PASSED');
      } catch (error) { console.error(error); process.exitCode = 1; }
      finally { server.close(); await mongoose.disconnect(); }
    });
  `;
  const result = await promisify(execFile)(process.execPath, ['-e', source], {
    cwd: path.resolve(__dirname, '..'), timeout: 12000, windowsHide: true,
    env: { ...process.env, MONGODB_URI: 'mongodb://127.0.0.1:1/instaclone_offline_test' },
  });
  assert.match(result.stdout, /DATABASE_OUTAGE_CHECK_PASSED/);
});
