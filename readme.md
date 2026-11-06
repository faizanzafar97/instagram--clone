HQ Instagram clone

Requires Node.js and MongoDB running locally on port 27017. To use another MongoDB server, set `MONGODB_URI` before starting the app.

```powershell
npm install
npm start
```

Open http://localhost:3000/ and create an account. Existing users can log in at http://localhost:3000/login. The feed at http://localhost:3000/feed requires login and redirects visitors to the login page.

The home feed shows your own posts and posts from accounts you follow. A new account starts with an empty feed. Your profile shows only your posts; switching accounts does not transfer posts between them.

Open a post at `/posts/:postid` from the feed's "View post" link, a profile thumbnail, or a notification. The page shows the full photo, caption, likes, saved status, comments and replies. Only the owner sees caption editing and deletion controls. Login is required.

Stories are visible for 24 hours after upload, including stories created before expiration was added. Expired stories cannot be opened. While the app is running, background cleanup removes expired story records, user references and unshared uploaded images in batches of 100 every minute, with a cleanup pass on startup.

Start the server with `npm start`; running `node app.js` does not start an HTTP listener. Restart the server after changing files.

Run `npm test` to check the pages and authentication flow. Tests require MongoDB and use a separate temporary database that is deleted after the run. Optionally set `TEST_MONGODB_URI` to select a test MongoDB server.

Run `npm run test:browser` to check image previews, posting, likes, saves, search, follows and logout in Chrome or Edge. It uses a temporary browser profile and database, and removes its uploaded test image afterward. Set `BROWSER_PATH` if the browser is installed outside the usual Windows locations. External CDNs are blocked during this check; it verifies behavior and image decoding.

Usernames must contain 1–30 letters, numbers, dots, underscores or hyphens. Uploads accept PNG, JPEG, GIF, WebP and AVIF images up to 5 MB. Invalid uploads are rejected and removed.

Optional server settings: `PORT` (default `3000`), `MONGODB_URI`, and `SESSION_SECRET`. Without a configured secret, a new session secret is generated on each server start. Accounts belong to the selected database, so use the same MongoDB database when logging in again.
