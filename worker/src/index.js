// Session Timer push server (Cloudflare Worker + one Durable Object per device).
//
// The app sends its running stopwatch timers to POST /sync whenever they change
// (start / pause / resume / stop). For each device the Durable Object sets an alarm
// for the next full hour of *active* time (pauses don't count) and sends a
// "Still studying?" push notification when it fires. Stopping a timer removes it.
//
// Only what's needed for reminders is stored: timer id, name, subject, start time and
// paused time. Session history stays on the phone.

import { DurableObject } from 'cloudflare:workers';
import { sendPush } from './webpush.js';

const MAX_REMINDERS = 16; // stop reminding after 16 hours, in case a "stop" never arrived
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// Only real browser push services (no arbitrary URLs), plus localhost when testing locally.
function isValidSubscription(sub, env) {
  try {
    const u = new URL(sub.endpoint);
    const local = env.ALLOW_LOCAL_PUSH === 'true' && ['localhost', '127.0.0.1'].includes(u.hostname);
    if (!local && (u.protocol !== 'https:' || !PUSH_HOSTS.some((r) => r.test(u.hostname)))) return false;
    return typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string';
  } catch { return false; }
}

function cleanTimers(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.id === 'string' && Number.isFinite(x.start))
    .slice(0, 20)
    .map((x) => ({
      id: x.id.slice(0, 64),
      name: String(x.name || '').slice(0, 40),
      subject: x.subject ? String(x.subject).slice(0, 40) : null,
      start: x.start,
      pausedMs: Number.isFinite(x.pausedMs) ? Math.max(0, x.pausedMs) : 0,
      pausedAt: Number.isFinite(x.pausedAt) ? x.pausedAt : null,
    }));
}

function reminderMessage(t, hours, lang) {
  const learning = /learn|study|uč|uci|ucenje/i.test(t.name);
  const label = `${t.name}${t.subject ? ` · ${t.subject}` : ''} · ${hours}h`;
  if (lang === 'bs') {
    return {
      title: learning ? 'Da li još učiš?' : 'Da li tajmer još radi?',
      body: `${label} — tapni da potvrdiš ili zaustaviš.`,
      sessionId: t.id,
    };
  }
  return {
    title: learning ? 'Still studying?' : 'Still going?',
    body: `${label} — tap to confirm or stop.`,
    sessionId: t.id,
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'study-timer-push' }, 200, headers);
    if (req.method !== 'POST' || !['/sync', '/unsubscribe'].includes(url.pathname)) {
      return json({ error: 'not found' }, 404, headers);
    }

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400, headers); }
    const deviceId = String(body.deviceId || '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(deviceId)) return json({ error: 'bad deviceId' }, 400, headers);
    const device = env.DEVICE.get(env.DEVICE.idFromName(deviceId));

    if (url.pathname === '/unsubscribe') {
      await device.clear();
      return json({ ok: true }, 200, headers);
    }
    if (!isValidSubscription(body.subscription, env)) return json({ error: 'bad subscription' }, 400, headers);
    const lang = body.lang === 'bs' ? 'bs' : 'en';
    const result = await device.sync(body.subscription, lang, cleanTimers(body.timers));
    return json({ ok: true, ...result }, 200, headers);
  },
};

export class Device extends DurableObject {
  hourMs() { return Number(this.env.HOUR_MS) || 3600000; } // HOUR_MS can be shortened for local tests
  activeMs(t, at) { return Math.max(0, (t.pausedAt ?? at) - t.start - t.pausedMs); }

  async sync(subscription, lang, timers) {
    const old = (await this.ctx.storage.get('timers')) || [];
    const at = Date.now();
    for (const t of timers) {
      const prev = old.find((o) => o.id === t.id && o.start === t.start);
      // A timer we haven't seen: don't send reminders for hours that already passed.
      t.notified = prev ? prev.notified : Math.floor(this.activeMs(t, at) / this.hourMs());
    }
    await this.ctx.storage.put({ subscription, lang, timers });
    return { timers: timers.length, nextReminder: await this.schedule(timers) };
  }

  async clear() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async schedule(timers) {
    let next = null;
    for (const t of timers) {
      if (t.pausedAt != null || t.notified >= MAX_REMINDERS) continue;
      const due = t.start + t.pausedMs + (t.notified + 1) * this.hourMs();
      if (next === null || due < next) next = due;
    }
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
    return next;
  }

  async alarm() {
    const data = await this.ctx.storage.get(['subscription', 'lang', 'timers']);
    const subscription = data.get('subscription');
    const lang = data.get('lang') || 'en';
    const timers = data.get('timers') || [];
    if (!subscription || !timers.length) return;

    const vapid = {
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateKey: this.env.VAPID_PRIVATE_KEY,
      subject: this.env.VAPID_SUBJECT,
    };
    const at = Date.now();
    for (const t of timers) {
      if (t.pausedAt != null || t.notified >= MAX_REMINDERS) continue;
      const hours = Math.floor(this.activeMs(t, at) / this.hourMs());
      if (hours <= t.notified) continue;
      t.notified = hours;
      const status = await sendPush(subscription, JSON.stringify(reminderMessage(t, hours, lang)), vapid);
      if (status === 404 || status === 410) { await this.clear(); return; } // subscription no longer valid
      if (status >= 400) console.log('push failed', status);
    }
    await this.ctx.storage.put('timers', timers);
    await this.schedule(timers);
  }
}
