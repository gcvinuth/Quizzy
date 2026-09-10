# Quiz Room

A small, self-contained website for running a live quiz with friends: one person hosts a room, shares a short code, and everyone else joins from their own device to answer a mix of multiple-choice ("objective") and open-ended ("subjective") questions in real time.

It's plain HTML/CSS/JS — no build step — so it runs directly on GitHub Pages. The only thing it needs from you is a free Firebase Realtime Database, which is what lets one person's browser sync live with everyone else's.

## 1. Create a free Firebase project (~5 minutes, one-time)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with any Google account.
2. Click **Add project**, give it any name (e.g. `quiz-room`), and finish the setup wizard (you can skip Google Analytics).
3. In the left sidebar, go to **Build → Realtime Database**, click **Create Database**, choose any location, and start in **test mode** for now. This is fine for a casual quiz app used by friends; see the security note at the bottom if you want to lock it down further.
4. In the left sidebar, click the gear icon → **Project settings**. Under "Your apps", click the **</>** (web) icon to register a new web app. You don't need Firebase Hosting — just register the app.
5. Firebase will show you a `firebaseConfig` object that looks like this:

   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "quiz-room-xxxxx.firebaseapp.com",
     databaseURL: "https://quiz-room-xxxxx-default-rtdb.firebaseio.com",
     projectId: "quiz-room-xxxxx",
     storageBucket: "quiz-room-xxxxx.appspot.com",
     messagingSenderId: "...",
     appId: "..."
   };
   ```

   Copy those values into `firebase-config.js` in this project, replacing the placeholder values.

That's the only edit needed. Everything else works as-is.

## 2. Try it locally (optional)

Open `index.html` directly in a browser, or serve the folder with any static server, e.g.:

```
python3 -m http.server 8000
```

then visit `http://localhost:8000`.

## 3. Deploy to GitHub Pages

1. Create a new GitHub repository and push all the files in this folder (`index.html`, `style.css`, `app.js`, `firebase-config.js`) to it.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source** to "Deploy from a branch", pick your default branch (e.g. `main`) and the `/ (root)` folder, then save.
4. GitHub gives you a URL like `https://yourusername.github.io/your-repo-name/` — that's your live site. It can take a minute to go live after the first push.

## How it works

- The host creates a room, gets a 5-character code, and adds questions before starting.
- Friends join from any device using that code.
- Once the host hits **Start game**, everyone sees the same question at the same time. Multiple-choice answers are scored automatically (1 point each); open-ended answers aren't scored — they're there for discussion, and the host can choose to share everyone's answers before moving on.
- A live leaderboard appears once the host ends the game.

## A note on security

Firebase's "test mode" rules allow anyone with your database URL to read and write to it, which is fine for casual use among friends but not for anything sensitive. If you want to tighten this up, in the Firebase console go to **Realtime Database → Rules** and restrict access — for example, only allowing writes to a room's `players` and `responses` paths, never to `questions` or `status` directly from a non-host client. This requires adding Firebase Authentication and more specific rules, which is beyond this basic setup but well documented in Firebase's own docs.
