# Session Timer

A stopwatch for tracking total time and sessions per activity (e.g. Learning).
It's a plain HTML/CSS/JS web app that you can install on your iPhone home screen.

## Run it on your PC
```powershell
python -m http.server 8765
```
Then open http://localhost:8765.

## Put it on your iPhone (free, with GitHub Pages)
1. Create a new **public** repository on github.com, for example `session-timer`.
2. Upload these files, keeping the folder structure:
   `index.html`, `style.css`, `app.js`, `manifest.json`, `service-worker.js`, `icons/`.
   (On the repo page: **Add file → Upload files**, then drag them in.)
3. In the repo, go to **Settings → Pages**. Under "Build and deployment", choose
   **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After about a minute the site is at `https://<your-username>.github.io/session-timer/`.
5. On the iPhone, open that URL in **Safari**, then tap **Share → Add to Home Screen**.
6. Always open the app from the home-screen icon. It keeps its own data, separate from the Safari tab.

## Updating the app
Upload the changed files to the repo again. The installed app picks them up the
next time you open it while online.
If you change the list of files, also bump `CACHE` in `service-worker.js`.

## Your data
- Your data is saved in the browser's local storage on that device only. No server or account is involved.
- **Back it up now and then:** Activities → **Export JSON** (on the iPhone, choose "Save to Files").
  **Import JSON** restores a backup.
- Export CSV opens in Excel or Google Sheets.
- Deleting the home-screen app deletes its data.
