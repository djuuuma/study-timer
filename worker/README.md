# Reminder server (Cloudflare Worker)

Sends the hourly "Still studying?" push notifications while a stopwatch is running.
The phone can't run code while the app is closed, so this small server does it.

- `POST /sync`: the app sends its running stopwatch timers (id, name, subject, start, paused time)
  plus its push subscription whenever something changes.
- One Durable Object per device sets an alarm for the next full hour of active time and sends
  an encrypted Web Push (VAPID + aes128gcm, implemented in `src/webpush.js` with WebCrypto).
- `POST /unsubscribe`: forget the device (used when reminders are turned off).

Session history never leaves the phone.

## Deploy

```powershell
cd worker
npm install
npx wrangler login              # once, opens Cloudflare in the browser
npx wrangler secret put VAPID_PRIVATE_KEY   # paste the private key (kept in .dev.vars, never committed)
npx wrangler deploy
```

Then put the printed `https://study-timer-push.<your-subdomain>.workers.dev` URL into
`PUSH_SERVER` in `app.js`.

## Local test

```powershell
npx wrangler dev --var HOUR_MS:4000 --var ALLOW_LOCAL_PUSH:true
```

`HOUR_MS` shortens an "hour" for testing. `ALLOW_LOCAL_PUSH` accepts localhost push endpoints.
