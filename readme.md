HQ Instagram clone

Requires Node.js and MongoDB running locally on port 27017. To use another MongoDB server, set `MONGODB_URI` before starting the app.

```powershell
npm install
npm start
```

Open http://localhost:3000/ and create an account. Existing users can log in at http://localhost:3000/login. The feed at http://localhost:3000/feed requires login and redirects visitors to the login page.

Start the server with `npm start`; running `node app.js` does not start an HTTP listener. Restart the server after changing files.

Run `npm test` to check the pages and authentication flow. Tests require MongoDB and use a separate temporary database that is deleted after the run. Optionally set `TEST_MONGODB_URI` to select a test MongoDB server.
