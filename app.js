'use strict';

/* ---------- Data model ----------
 * Activities come in two types:
 *   'timer'  – a stopwatch: Start / Pause / Resume / Stop. Counts time spent (e.g. Learning).
 *   'streak' – counts time since you started (e.g. No smoking). "I slipped" ends the
 *              current streak, saves it to history and starts a new one.
 *
 * Sessions store timestamps (ms), never a running counter:
 *   { id, activityId, start, end, pauses: [{ start, end }] }
 *   end === null            -> still running
 *   last pause end === null -> currently paused
 * Duration = (end ?? now) - start - paused time, so the timer stays correct across
 * reloads, closed tabs, locked phones and restarts.
 */
const APP_VERSION = '11'; // bump on every release; must match VERSION in service-worker.js
const KEY = 'session-timer.v1';

// Hourly "Still studying?" reminders (see worker/). Locally the app talks to `wrangler dev`.
const PUSH_SERVER = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:8787'
  : 'https://study-timer-push.study-timer-push.workers.dev';
const VAPID_PUBLIC_KEY = 'BB2VZoGjoQvRaLyzNXgNyCdL_gf5m9N2IOJQKLNRhneUbd6rfvpom9v_Yhyu3JUM6Xa3nT6YrwdFjTTobLSRN3w';
const HOUR_MS = 3600000;
const SETTINGS_KEY = 'session-timer.settings';
const COLORS = ['#4f8cff', '#22c55e', '#f59e0b', '#a855f7', '#14b8a6', '#ec4899', '#ef4444'];
const DEFAULT_SUBJECTS = ['OE', 'TP', 'OBP', 'LAG']; // preloaded for "Learning"
const DATA_VERSION = 3;
const DEFAULT_STREAKS = [
  { name: 'No junk food', color: '#22c55e' },
  { name: 'No smoking', color: '#14b8a6' },
];

const $ = (s) => document.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- Settings (theme, language, time format, week start) ----------
 * Stored separately from your timer data, so backups/imports never change them.
 */
const DEFAULT_SETTINGS = {
  theme: 'system',                                                   // 'system' | 'light' | 'dark'
  lang: /^(bs|hr|sr)\b/i.test(navigator.language || '') ? 'bs' : 'en', // 'en' | 'bs'
  clock: 'auto',                                                     // 'auto' | '24' | '12'
  weekStart: 1,                                                      // 1 = Monday, 0 = Sunday
  notify: false,                                                     // hourly push reminders
  deviceId: '',                                                      // random id for the push server
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : DEFAULT_SETTINGS.theme,
      lang: ['en', 'bs'].includes(s.lang) ? s.lang : DEFAULT_SETTINGS.lang,
      clock: ['auto', '24', '12'].includes(s.clock) ? s.clock : DEFAULT_SETTINGS.clock,
      weekStart: s.weekStart === 0 ? 0 : 1,
      notify: s.notify === true,
      deviceId: typeof s.deviceId === 'string' ? s.deviceId : '',
    };
  } catch (e) { return { ...DEFAULT_SETTINGS }; }
}
let settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* not critical */ }
}

/* ---------- Translations ---------- */
const I18N = {
  en: {
    timers: 'Timers', newBtn: '+ New', back: 'Back', subject: 'Subject', timeBySubject: 'Time by subject',
    recentSessions: 'Recent sessions', recentStreaks: 'Recent streaks',
    history: 'History', addBtn: '+ Add', filter: 'Filter', allTimers: 'All timers', noSessions: 'No sessions yet.',
    manage: 'Manage', newTimerPh: 'New timer, e.g. Reading', type: 'Type',
    typeTimer: 'Stopwatch (track time spent)', typeStreak: 'Streak (time since last slip)', add: 'Add',
    settings: 'Settings', appearance: 'Appearance', themeSystem: 'System', themeLight: 'Light', themeDark: 'Dark',
    language: 'Language', timeFormat: 'Time format', auto: 'Auto', weekStart: 'Week starts on',
    monday: 'Monday', sunday: 'Sunday',
    backup: 'Backup', exportJson: 'Export JSON', exportCsv: 'Export CSV', importJson: 'Import JSON',
    backupHint: 'Your data is stored only on this device. Export a JSON backup now and then — Import restores it.',
    timer: 'Timer', startLabel: 'Start', endLabel: 'End', endHint: 'Leave End empty if the session is still running.',
    editSession: 'Edit session', addSession: 'Add session',
    delete: 'Delete', cancel: 'Cancel', save: 'Save', ok: 'OK', rename: 'Rename', reset: 'Reset', replace: 'Replace',
    // states
    notStarted: 'Not started', notRunning: 'Not running', today: 'Today', yesterday: 'Yesterday', now: 'now',
    stopwatch: 'Stopwatch', streak: 'Streak', total: (x) => `${x} total`, nowSubject: (x) => `now: ${x}`,
    best: (x) => `best ${x}`, currentStreakTag: 'current streak', streakTag: 'streak', pausedTag: 'paused',
    pausedFor: (x) => `${x} paused`, cleanSince: (x) => `Clean since ${x}`,
    pausedStarted: (x) => `Paused · started ${x}`, started: (x) => `Started ${x}`,
    currentX: (x) => `current ${x}`, notStartedLower: 'not started',
    // buttons
    slipBtn: 'I slipped – reset', startStreak: 'Start streak', start: 'Start', resume: 'Resume', pause: 'Pause', stop: 'Stop',
    // stats
    currentStreak: 'Current streak', longestStreak: 'Longest streak', slips: 'Slips', averageStreak: 'Average streak',
    totalAll: 'Total (all subjects)', totalTime: 'Total time', sessions: 'Sessions', thisWeek: 'This week',
    averageSession: 'Average session', longestSession: 'Longest session',
    // subjects
    noSubject: 'No subject', subjectChip: '+ Subject', addSubjectChip: '+ Add subject',
    newSubject: 'New subject', subjectExample: 'e.g. Math, English, Programming', editSubject: 'Edit subject',
    deleteSubjectQ: (x) => `Delete subject "${x}"?`,
    subjectKept: (n) => `Its ${n} will be kept, without a subject.`,
    // dialogs
    couldNotSave: 'Could not save',
    resetQ: (x) => `Reset "${x}"?`,
    resetMsg: (x) => `Your current streak of ${x} will be saved to history and a new streak starts now.`,
    errStart: 'Please enter a valid start time.', errEnd: 'Please enter a valid end time.',
    errOrder: 'End must be after start.', errFuture: 'Start cannot be in the future.',
    errRunning: 'This timer already has a running session.',
    deleteSessionQ: 'Delete this session?', cannotUndo: 'This cannot be undone.',
    renameTimer: 'Rename timer', cantDelete: 'Can’t delete', needOne: 'You need at least one timer.',
    deleteQ: (x) => `Delete "${x}"?`, deleteMsg: (n) => `This also deletes its ${n}. This cannot be undone.`,
    restoreQ: 'Restore backup?', restoreMsg: (n) => `This replaces all current data with the backup (${n}).`,
    restored: 'Backup restored', importFailed: 'Import failed', notBackup: 'This file is not a Session Timer backup.',
    version: (v) => `Version ${v}`,
    // reminders
    reminders: 'Hourly reminder', on: 'On', off: 'Off',
    notifyOn: 'You’ll get “Still studying?” every hour a stopwatch is running.',
    notifyOff: 'Get a notification every hour while a stopwatch is running.',
    notifyUnsupported: 'Notifications only work when the app is opened from the Home Screen (iPhone: iOS 16.4 or newer).',
    notifyDenied: 'Notifications are blocked. Allow them in Settings → Notifications → Timer.',
    notifyNoServer: 'The reminder server isn’t set up yet.',
    notifyError: (m) => `Couldn’t turn on reminders: ${m}`,
    stillStudying: 'Still studying?', stillGoing: 'Still going?',
    checkinMsg: (label, d, since) => `${label} — ${d} since ${since}.`,
    keepGoing: 'Yes, keep going', iStopped: 'I stopped',
    whenStopped: 'When did you stop?', stopNow: 'Just now', minAgo: (n) => `${n} min ago`, hourAgo: '1 hour ago',
  },
  bs: {
    timers: 'Tajmeri', newBtn: '+ Novi', back: 'Nazad', subject: 'Predmet', timeBySubject: 'Vrijeme po predmetu',
    recentSessions: 'Nedavne sesije', recentStreaks: 'Nedavni nizovi',
    history: 'Historija', addBtn: '+ Dodaj', filter: 'Filter', allTimers: 'Svi tajmeri', noSessions: 'Još nema sesija.',
    manage: 'Upravljanje', newTimerPh: 'Novi tajmer, npr. Čitanje', type: 'Vrsta',
    typeTimer: 'Štoperica (utrošeno vrijeme)', typeStreak: 'Niz (vrijeme bez posrtaja)', add: 'Dodaj',
    settings: 'Postavke', appearance: 'Izgled', themeSystem: 'Sistem', themeLight: 'Svijetlo', themeDark: 'Tamno',
    language: 'Jezik', timeFormat: 'Format vremena', auto: 'Auto', weekStart: 'Sedmica počinje',
    monday: 'Ponedjeljak', sunday: 'Nedjelja',
    backup: 'Rezervna kopija', exportJson: 'Izvezi JSON', exportCsv: 'Izvezi CSV', importJson: 'Uvezi JSON',
    backupHint: 'Podaci se čuvaju samo na ovom uređaju. Povremeno izvezi JSON kopiju — Uvoz je vraća.',
    timer: 'Tajmer', startLabel: 'Početak', endLabel: 'Kraj', endHint: 'Ostavi Kraj prazno ako sesija još traje.',
    editSession: 'Uredi sesiju', addSession: 'Dodaj sesiju',
    delete: 'Obriši', cancel: 'Otkaži', save: 'Sačuvaj', ok: 'U redu', rename: 'Preimenuj', reset: 'Resetuj', replace: 'Zamijeni',
    notStarted: 'Nije pokrenuto', notRunning: 'Ne radi', today: 'Danas', yesterday: 'Jučer', now: 'sada',
    stopwatch: 'Štoperica', streak: 'Niz', total: (x) => `ukupno ${x}`, nowSubject: (x) => `sada: ${x}`,
    best: (x) => `najbolje ${x}`, currentStreakTag: 'trenutni niz', streakTag: 'niz', pausedTag: 'pauzirano',
    pausedFor: (x) => `pauza ${x}`, cleanSince: (x) => `Čist od ${x}`,
    pausedStarted: (x) => `Pauzirano · počelo ${x}`, started: (x) => `Počelo ${x}`,
    currentX: (x) => `trenutno ${x}`, notStartedLower: 'nije pokrenut',
    slipBtn: 'Posrnuo sam – resetuj', startStreak: 'Pokreni niz', start: 'Pokreni', resume: 'Nastavi', pause: 'Pauza', stop: 'Zaustavi',
    currentStreak: 'Trenutni niz', longestStreak: 'Najduži niz', slips: 'Posrtaji', averageStreak: 'Prosječni niz',
    totalAll: 'Ukupno (svi predmeti)', totalTime: 'Ukupno vrijeme', sessions: 'Sesije', thisWeek: 'Ove sedmice',
    averageSession: 'Prosječna sesija', longestSession: 'Najduža sesija',
    noSubject: 'Bez predmeta', subjectChip: '+ Predmet', addSubjectChip: '+ Dodaj predmet',
    newSubject: 'Novi predmet', subjectExample: 'npr. Matematika, Engleski, Programiranje', editSubject: 'Uredi predmet',
    deleteSubjectQ: (x) => `Obrisati predmet "${x}"?`,
    subjectKept: (n) => `Sesije ovog predmeta (${n}) ostaju, ali bez predmeta.`,
    couldNotSave: 'Nije moguće sačuvati',
    resetQ: (x) => `Resetovati "${x}"?`,
    resetMsg: (x) => `Tvoj trenutni niz od ${x} biće sačuvan u historiji, a novi niz počinje sada.`,
    errStart: 'Unesi ispravno vrijeme početka.', errEnd: 'Unesi ispravno vrijeme kraja.',
    errOrder: 'Kraj mora biti nakon početka.', errFuture: 'Početak ne može biti u budućnosti.',
    errRunning: 'Ovaj tajmer već ima aktivnu sesiju.',
    deleteSessionQ: 'Obrisati ovu sesiju?', cannotUndo: 'Ovo se ne može poništiti.',
    renameTimer: 'Preimenuj tajmer', cantDelete: 'Nije moguće obrisati', needOne: 'Potreban je barem jedan tajmer.',
    deleteQ: (x) => `Obrisati "${x}"?`, deleteMsg: (n) => `Ovo briše i njegove sesije (${n}). Ne može se poništiti.`,
    restoreQ: 'Vratiti rezervnu kopiju?', restoreMsg: (n) => `Ovo zamjenjuje sve trenutne podatke kopijom (${n}).`,
    restored: 'Kopija vraćena', importFailed: 'Uvoz nije uspio', notBackup: 'Ovo nije rezervna kopija Session Timera.',
    version: (v) => `Verzija ${v}`,
    reminders: 'Podsjetnik svaki sat', on: 'Uključeno', off: 'Isključeno',
    notifyOn: 'Dobićeš „Da li još učiš?” svaki sat dok štoperica radi.',
    notifyOff: 'Notifikacija svaki sat dok štoperica radi.',
    notifyUnsupported: 'Notifikacije rade samo kad je aplikacija otvorena s početnog ekrana (iPhone: iOS 16.4 ili noviji).',
    notifyDenied: 'Notifikacije su blokirane. Dozvoli ih u Postavke → Obavještenja → Timer.',
    notifyNoServer: 'Server za podsjetnike još nije postavljen.',
    notifyError: (m) => `Uključivanje nije uspjelo: ${m}`,
    stillStudying: 'Da li još učiš?', stillGoing: 'Da li tajmer još radi?',
    checkinMsg: (label, d, since) => `${label} — ${d} od ${since}.`,
    keepGoing: 'Da, nastavljam', iStopped: 'Prestao sam',
    whenStopped: 'Kada si prestao?', stopNow: 'Upravo sada', minAgo: (n) => `prije ${n} min`, hourAgo: 'prije 1 sat',
  },
};

function t(key, ...args) {
  const v = I18N[settings.lang][key] ?? I18N.en[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
}

// Plural nouns: English has 2 forms, Bosnian 3 (1 sesija, 2 sesije, 5 sesija).
const NOUNS = {
  en: { session: ['session', 'sessions'], slip: ['slip', 'slips'] },
  bs: { session: ['sesija', 'sesije', 'sesija'], slip: ['posrtaj', 'posrtaja', 'posrtaja'] },
};
function plural(n, noun) {
  const f = NOUNS[settings.lang][noun];
  if (settings.lang === 'en') return `${n} ${n === 1 ? f[0] : f[1]}`;
  const d = n % 10, h = n % 100;
  const form = d === 1 && h !== 11 ? f[0] : d >= 2 && d <= 4 && (h < 12 || h > 14) ? f[1] : f[2];
  return `${n} ${form}`;
}

// Translate the static parts of the page (elements tagged with data-i18n*).
function applyI18n() {
  document.documentElement.lang = settings.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  $('#app-version').textContent = t('version', APP_VERSION);
}

/* ---------- Date/time formatting (follows language + time format settings) ---------- */
let timeFmt, dateTimeFmt, dayFmt, shortDayFmt, homeDateFmt;

// Bosnian names are built in, because some browsers ship without Bosnian calendar data
// (they print things like "M11 25, Wed").
const BS_DATES = {
  weekdays: ['nedjelja', 'ponedjeljak', 'utorak', 'srijeda', 'četvrtak', 'petak', 'subota'],
  months: ['januar', 'februar', 'mart', 'april', 'maj', 'juni', 'juli', 'august', 'septembar', 'oktobar', 'novembar', 'decembar'],
  monthsShort: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
};

function buildFormatters() {
  if (settings.lang === 'bs') {
    const use12 = settings.clock === '12';
    const time = (x) => {
      const d = new Date(x), h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
      return use12 ? `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}` : `${String(h).padStart(2, '0')}:${m}`;
    };
    const shortDay = (x) => { const d = new Date(x); return `${d.getDate()}. ${BS_DATES.monthsShort[d.getMonth()]}`; };
    timeFmt = { format: time };                                                     // 22:51
    dateTimeFmt = { format: (x) => `${shortDay(x)} ${time(x)}` };                   // 25. nov 22:51
    shortDayFmt = { format: shortDay };                                             // 25. nov
    dayFmt = { format: (x) => `${BS_DATES.weekdays[new Date(x).getDay()]}, ${shortDay(x)}` }; // srijeda, 25. nov
    homeDateFmt = { format: (x) => {                                                // srijeda, 25. novembar
      const d = new Date(x);
      return `${BS_DATES.weekdays[d.getDay()]}, ${d.getDate()}. ${BS_DATES.months[d.getMonth()]}`;
    } };
    return;
  }
  const locale = 'en-US';
  const hc = settings.clock === '24' ? { hourCycle: 'h23' } : settings.clock === '12' ? { hourCycle: 'h12' } : {};
  const make = (opts) => {
    try { return new Intl.DateTimeFormat(locale, opts); } catch (e) { return new Intl.DateTimeFormat(undefined, opts); }
  };
  timeFmt = make({ hour: '2-digit', minute: '2-digit', ...hc });
  dateTimeFmt = make({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...hc });
  dayFmt = make({ weekday: 'long', month: 'short', day: 'numeric' });
  shortDayFmt = make({ month: 'short', day: 'numeric' });
  homeDateFmt = make({ weekday: 'long', day: 'numeric', month: 'long' });
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- Theme ---------- */
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  const dark = settings.theme === 'dark'
    || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#0b0d12' : '#f3f5f9';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

/* ---------- Data ---------- */
function defaultState() {
  const id = uid();
  return {
    version: DATA_VERSION,
    activities: [
      { id, name: 'Learning', color: COLORS[0], type: 'timer',
        subjects: DEFAULT_SUBJECTS.map((name) => ({ id: uid(), name })) },
      ...DEFAULT_STREAKS.map((a) => ({ id: uid(), ...a, type: 'streak' })),
    ],
    sessions: [],
    selectedId: id,
  };
}

function isValidState(s) {
  return s && Array.isArray(s.activities) && Array.isArray(s.sessions)
    && s.activities.every((a) => a && a.id && typeof a.name === 'string')
    && s.sessions.every((x) => x && x.id && x.activityId && Number.isFinite(x.start)
      && (x.end === null || Number.isFinite(x.end))
      && (x.pauses === undefined || Array.isArray(x.pauses)));
}

function normalize(s) {
  // v1 -> v2: add the default streak trackers once.
  if ((s.version || 1) < 2) {
    for (const d of DEFAULT_STREAKS) {
      if (!s.activities.some((a) => a.name.toLowerCase() === d.name.toLowerCase())) {
        s.activities.push({ id: uid(), ...d, type: 'streak' });
      }
    }
  }
  if (!s.activities.length) s.activities = defaultState().activities;
  const ids = new Set(s.activities.map((a) => a.id));
  s.sessions = s.sessions.filter((x) => ids.has(x.activityId));
  s.sessions.forEach((x) => { if (!Array.isArray(x.pauses)) x.pauses = []; });
  s.activities.forEach((a, i) => {
    if (!a.color) a.color = COLORS[i % COLORS.length];
    if (a.type !== 'streak') a.type = 'timer';
  });
  // Subjects (stopwatch timers only): activity.subjects = [{ id, name }], session.subjectId
  s.activities.forEach((a) => {
    if (!Array.isArray(a.subjects)) a.subjects = [];
    if (a.lastSubjectId && !a.subjects.some((sb) => sb.id === a.lastSubjectId)) a.lastSubjectId = null;
  });
  // v2 -> v3: preload the default subjects into "Learning" once (keeps any you already added).
  if ((s.version || 1) < 3) {
    const learning = s.activities.find((a) => a.type === 'timer' && a.name.toLowerCase() === 'learning');
    if (learning) {
      for (const name of DEFAULT_SUBJECTS) {
        if (!learning.subjects.some((sb) => sb.name.toLowerCase() === name.toLowerCase())) {
          learning.subjects.push({ id: uid(), name });
        }
      }
    }
  }
  s.sessions.forEach((x) => {
    const a = s.activities.find((y) => y.id === x.activityId);
    if (!x.subjectId || !a.subjects.some((sb) => sb.id === x.subjectId)) x.subjectId = null;
  });
  if (!ids.has(s.selectedId)) s.selectedId = s.activities[0].id;
  s.version = DATA_VERSION;
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (isValidState(s)) return normalize(s);
    }
  } catch (e) { console.error('Load failed', e); }
  return defaultState();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { ask({ title: t('couldNotSave'), message: e.message, cancel: false }); }
  if (typeof schedulePushSync === 'function') schedulePushSync(); // tell the reminder server
}

let state = load();
save(); // persist any migration

/* ---------- In-app dialogs ----------
 * Replaces confirm()/prompt()/alert(): some browsers and embedded web views block
 * those pop-ups and silently answer "Cancel".
 *   await ask({ title, message, ok, danger })            -> true / false
 *   await ask({ title, input: 'current value' })         -> string / null
 *   await ask({ title, message, cancel: false })         -> plain message
 */
function ask({ title, message = '', ok = t('ok'), danger = false, input = null, cancel = true, extra = null }) {
  const d = $('#ask-dialog');
  const inp = $('#ask-input');
  const okBtn = $('#ask-ok');
  const cancelBtn = $('#ask-cancel');
  const extraBtn = $('#ask-extra');
  const wantsText = input !== null;
  // Optional third button (e.g. "Delete"); resolves to the string 'extra'.
  extraBtn.hidden = !extra;
  if (extra) extraBtn.textContent = extra;

  $('#ask-title').textContent = title;
  $('#ask-message').textContent = message;
  $('#ask-message').hidden = !message;
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'danger-fill' : 'primary'}`;
  cancelBtn.hidden = !cancel;
  inp.hidden = !wantsText;
  if (wantsText) inp.value = input;

  return new Promise((resolve) => {
    const finish = (value) => {
      $('#ask-form').onsubmit = null;
      cancelBtn.onclick = null;
      extraBtn.onclick = null;
      d.oncancel = null;
      if (d.open) d.close();
      resolve(value);
    };
    $('#ask-form').onsubmit = (e) => { e.preventDefault(); finish(wantsText ? inp.value : true); };
    cancelBtn.onclick = () => finish(wantsText ? null : false);
    extraBtn.onclick = () => finish('extra');
    d.oncancel = (e) => { e.preventDefault(); finish(wantsText ? null : false); }; // Esc key
    d.showModal();
    if (wantsText) { inp.focus(); inp.select(); }
  });
}

/* ---------- Helpers ---------- */
const now = () => Date.now();
const activity = (id) => state.activities.find((a) => a.id === id);
const runningFor = (activityId) => state.sessions.find((s) => s.activityId === activityId && s.end === null);
const sessionsFor = (activityId) => state.sessions.filter((s) => !activityId || s.activityId === activityId);
const isPaused = (s) => s.end === null && s.pauses.length > 0 && s.pauses[s.pauses.length - 1].end === null;
const pad = (n) => String(n).padStart(2, '0');
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const subjectOf = (s) => {
  if (!s.subjectId) return null;
  const sb = activity(s.activityId).subjects.find((x) => x.id === s.subjectId);
  return sb ? sb.name : null;
};

function pausedMs(s) {
  const lo = s.start, hi = s.end ?? now();
  return s.pauses.reduce((sum, p) => sum + Math.max(0, Math.min(p.end ?? hi, hi) - Math.max(p.start, lo)), 0);
}
const dur = (s) => Math.max(0, (s.end ?? now()) - s.start - pausedMs(s));

function clock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(sec / 86400);
  const hms = `${pad(Math.floor((sec % 86400) / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
  if (d) return `${d}d ${hms}`;
  return `${Math.floor(sec / 3600)}:${hms.slice(3)}`;
}

function human(ms) {
  if (ms < 60000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

function startOfDay(x) { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeek(x) {
  const d = new Date(startOfDay(x));
  d.setDate(d.getDate() - ((d.getDay() - settings.weekStart + 7) % 7));
  return d.getTime();
}

// Returns 'today' / 'yesterday' / null, so callers can compare without depending on the language.
function relDay(x) {
  const today = startOfDay(now());
  const day = startOfDay(x);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === today) return 'today';
  if (day === yesterday.getTime()) return 'yesterday';
  return null;
}
function dayLabel(x) {
  const r = relDay(x);
  return r ? t(r) : cap(dayFmt.format(x));
}

function range(s) {
  const multiDay = startOfDay(s.start) !== startOfDay(s.end ?? now());
  const f = multiDay ? dateTimeFmt : timeFmt;
  return `${f.format(s.start)} – ${s.end === null ? t('now') : f.format(s.end)}`;
}

function timerStats(activityId) {
  const list = sessionsFor(activityId);
  const total = list.reduce((sum, s) => sum + dur(s), 0);
  const finished = list.filter((s) => s.end !== null);
  const today = startOfDay(now());
  const week = startOfWeek(now());
  return {
    total,
    count: list.length,
    avg: finished.length ? finished.reduce((sum, s) => sum + dur(s), 0) / finished.length : 0,
    longest: list.reduce((m, s) => Math.max(m, dur(s)), 0),
    today: list.filter((s) => s.start >= today).reduce((sum, s) => sum + dur(s), 0),
    week: list.filter((s) => s.start >= week).reduce((sum, s) => sum + dur(s), 0),
  };
}

function streakStats(activityId) {
  const list = sessionsFor(activityId);
  const run = runningFor(activityId);
  const ended = list.filter((s) => s.end !== null);
  return {
    current: run ? dur(run) : 0,
    longest: list.reduce((m, s) => Math.max(m, dur(s)), 0),
    slips: ended.length,
    avg: ended.length ? ended.reduce((sum, s) => sum + dur(s), 0) / ended.length : 0,
  };
}

/* ---------- Session item markup ----------
 * Live values are tagged with data-live-* and refreshed by tick(), so lists are
 * never rebuilt every second (a rebuild under your finger can swallow a tap).
 */
function sessionItem(s, showActivity) {
  const a = activity(s.activityId);
  const live = s.end === null;
  const paused = isPaused(s);
  let title = esc(a.name);
  if (!showActivity) {
    const r = relDay(s.start);
    title = r ? t(r) : shortDayFmt.format(s.start);
  }
  const subj = subjectOf(s);
  if (subj) title += ` · ${esc(subj)}`;
  const brk = pausedMs(s);
  let sub = range(s);
  if (a.type === 'streak') sub += ` · ${live ? t('currentStreakTag') : t('streakTag')}`;
  else if (paused) sub += ` · ${t('pausedTag')}`;
  else if (brk >= 1000) sub += ` · ${t('pausedFor', human(brk))}`;
  const cls = paused ? ' paused' : live ? (a.type === 'streak' ? ' streak' : ' live') : '';
  const liveAttr = live ? ` data-live-session="${s.id}"` : '';
  return `<li><button class="item" data-session="${s.id}" style="--c:${a.color}">
    <span class="dot"></span>
    <span class="main"><span class="title">${title}</span><span class="sub">${sub}</span></span>
    <span class="dur${cls}"${liveAttr}>${live ? clock(dur(s)) : human(dur(s))}</span>
  </button></li>`;
}

const statTiles = (rows) => rows.map(([l, v]) =>
  `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');

/* ---------- Icons (inline SVG, purely visual) ---------- */
const svg = (body, fill = false) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  stopwatch: svg('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2M9.5 2.5h5M12 2.5V6"/>'),
  flame: svg('<path d="M12 3c.8 2.8 4.5 5 4.5 9.5a4.5 4.5 0 0 1-9 0c0-2.2 1.2-3.7 2.2-4.7.3 1.5 1 2.3 1.8 2.7 0-2.8-.9-5 .5-7.5z"/>'),
  chevron: svg('<path d="M9 5l7 7-7 7"/>'),
  play: svg('<path d="M8 5.2v13.6a1 1 0 0 0 1.5.9l10.6-6.8a1 1 0 0 0 0-1.7L9.5 4.3A1 1 0 0 0 8 5.2z"/>', true),
  pause: svg('<rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/>', true),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2.5"/>', true),
  reset: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>'),
};

/* ---------- Home (main menu) ---------- */
function homeItem(a) {
  const run = runningFor(a.id);
  const paused = run && isPaused(run);
  let sub, right;
  if (a.type === 'streak') {
    const st = streakStats(a.id);
    sub = `${t('streak')} · ${plural(st.slips, 'slip')}${st.longest ? ` · ${t('best', human(st.longest))}` : ''}`;
    right = run
      ? `<span class="dur streak" data-live-session="${run.id}">${clock(dur(run))}</span>`
      : `<span class="dur idle">${t('notStarted')}</span>`;
  } else {
    sub = `${t('stopwatch')} · ${t('total', `<span data-live-total="${a.id}">${human(timerStats(a.id).total)}</span>`)}`;
    const subj = run && subjectOf(run);
    if (subj) sub += ` · ${t('nowSubject', esc(subj))}`;
    if (paused) right = `<span class="dur paused" data-live-session="${run.id}">${clock(dur(run))}</span>`;
    else if (run) right = `<span class="dur live" data-live-session="${run.id}">${clock(dur(run))}</span>`;
    else right = `<span class="dur idle">${t('notRunning')}</span>`;
  }
  const stateCls = run ? (paused ? ' is-running is-paused' : ' is-running') : '';
  return `<li><button class="item${stateCls}" data-open="${a.id}" style="--c:${a.color}">
    <span class="badge">${a.type === 'streak' ? ICONS.flame : ICONS.stopwatch}</span>
    <span class="main"><span class="title">${esc(a.name)}</span><span class="sub">${sub}</span></span>
    ${right}<span class="chev">${ICONS.chevron}</span>
  </button></li>`;
}

function renderHome() {
  $('#home-date').textContent = cap(homeDateFmt.format(now()));
  $('#home-list').innerHTML = state.activities.map(homeItem).join('');
}

/* ---------- Timer detail view ---------- */
function renderControls(sel, run) {
  const paused = run && isPaused(run);
  let html;
  if (sel.type === 'streak') {
    html = run
      ? `<button class="big-btn ghost" data-action="slip">${ICONS.reset}${t('slipBtn')}</button>`
      : `<button class="big-btn" data-action="start">${ICONS.play}${t('startStreak')}</button>`;
  } else if (!run) {
    html = `<button class="big-btn" data-action="start">${ICONS.play}${t('start')}</button>`;
  } else {
    html = `<button class="big-btn pause" data-action="${paused ? 'resume' : 'pause'}">${paused ? ICONS.play + t('resume') : ICONS.pause + t('pause')}</button>
      <button class="big-btn stop" data-action="stop">${ICONS.stop}${t('stop')}</button>`;
  }
  const box = $('#controls');
  box.innerHTML = html;
  box.style.setProperty('--c', sel.color);
}

function renderTimerLive() {
  const sel = activity(state.selectedId);
  const run = runningFor(sel.id);
  const paused = run && isPaused(run);
  const streak = sel.type === 'streak';

  const c = $('#clock');
  const elapsed = run ? dur(run) : 0;
  c.textContent = clock(elapsed);
  c.classList.toggle('long', elapsed >= 86400000);
  c.classList.toggle('paused', !!paused);
  const ring = $('.clock-wrap');
  ring.classList.toggle('running', !!run && !paused);
  ring.classList.toggle('paused', !!paused);

  let sub;
  if (streak) sub = run ? t('cleanSince', dateTimeFmt.format(run.start)) : t('notStarted');
  else if (paused) sub = t('pausedStarted', timeFmt.format(run.start));
  else sub = run ? t('started', timeFmt.format(run.start)) : t('notRunning');
  const subj = run && subjectOf(run);
  if (subj) sub += ` · ${subj}`;
  $('#clock-sub').textContent = sub;

  if (streak) {
    const st = streakStats(sel.id);
    $('#stats').innerHTML = statTiles([
      [t('currentStreak'), run ? human(st.current) : '–'],
      [t('longestStreak'), st.longest ? human(st.longest) : '–'],
      [t('slips'), st.slips],
      [t('averageStreak'), st.avg ? human(st.avg) : '–'],
    ]);
  } else {
    const st = timerStats(sel.id);
    $('#stats').innerHTML = statTiles([
      [sel.subjects.length ? t('totalAll') : t('totalTime'), human(st.total)],
      [t('sessions'), st.count],
      [t('today'), human(st.today)],
      [t('thisWeek'), human(st.week)],
      [t('averageSession'), st.avg ? human(st.avg) : '–'],
      [t('longestSession'), st.longest ? human(st.longest) : '–'],
    ]);
  }
}

/* ---------- Subjects (stopwatch timers) ---------- */
// The subject the next session starts with, or the running session's subject.
function currentSubjectId(sel, run) {
  return run ? run.subjectId : (sel.lastSubjectId ?? null);
}

function subjectTotals(sel) {
  const rows = sel.subjects.map((sb) => ({ id: sb.id, name: sb.name, total: 0, count: 0 }));
  const none = { id: '', name: t('noSubject'), total: 0, count: 0 };
  for (const s of sessionsFor(sel.id)) {
    const row = rows.find((r) => r.id === s.subjectId) || none;
    row.total += dur(s);
    row.count += 1;
  }
  if (none.count) rows.push(none);
  return rows;
}

function renderSubjects(sel, run) {
  const isTimer = sel.type === 'timer';
  $('#subject-row').hidden = !isTimer;
  $('#by-subject-title').hidden = !isTimer || !sel.subjects.length;
  if (!isTimer) { $('#by-subject').innerHTML = ''; return; }

  const cur = currentSubjectId(sel, run);
  $('#subject-chips').innerHTML = sel.subjects.map((sb) =>
    `<button class="chip${sb.id === cur ? ' selected' : ''}" data-subject="${sb.id}" style="--c:${sel.color}">${esc(sb.name)}</button>`
  ).join('') + `<button class="chip add-chip" data-add-subject>${sel.subjects.length ? t('subjectChip') : t('addSubjectChip')}</button>`;

  if (!sel.subjects.length) { $('#by-subject').innerHTML = ''; return; }
  const rows = subjectTotals(sel);
  const max = Math.max(1, ...rows.map((r) => r.total));
  $('#by-subject').innerHTML = rows.map((r) => `<li>
    <button class="item subject-row" ${r.id ? `data-edit-subject="${r.id}"` : 'disabled'} style="--c:${sel.color}">
      <span class="bar" style="width:${(r.total / max) * 100}%"></span>
      <span class="main"><span class="title">${esc(r.name)}</span><span class="sub">${plural(r.count, 'session')}</span></span>
      <span class="dur" data-live-subject="${sel.id}|${r.id}">${human(r.total)}</span>
    </button></li>`).join('');
}

function renderTimer() {
  const sel = activity(state.selectedId);
  const run = runningFor(sel.id);
  $('#detail-title').textContent = sel.name;
  // Activity colour for the ring, buttons and highlights; line the ring's sweep up with the seconds.
  $('#view-timer').style.setProperty('--c', sel.color);
  $('.clock-wrap').style.setProperty('--sweep-delay', `-${run ? (dur(run) % 60000) / 1000 : 0}s`);
  renderSubjects(sel, run);
  renderControls(sel, run);
  renderTimerLive();

  const recent = sessionsFor(sel.id).sort((a, b) => b.start - a.start).slice(0, 5);
  $('#recent').innerHTML = recent.map((s) => sessionItem(s, false)).join('');
  $('#recent-title').textContent = sel.type === 'streak' ? t('recentStreaks') : t('recentSessions');
  $('#recent-title').hidden = !recent.length;
}

/* ---------- History view ---------- */
let historyFilter = 'all';

function historyDayTotal(day) {
  return sessionsFor(historyFilter === 'all' ? null : historyFilter)
    .filter((s) => startOfDay(s.start) === day && activity(s.activityId).type === 'timer')
    .reduce((sum, s) => sum + dur(s), 0);
}

function renderHistory() {
  const filter = $('#history-filter');
  if (historyFilter !== 'all' && !activity(historyFilter)) historyFilter = 'all';
  filter.innerHTML = `<option value="all">${t('allTimers')}</option>` +
    state.activities.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  filter.value = historyFilter;

  const list = sessionsFor(historyFilter === 'all' ? null : historyFilter).sort((a, b) => b.start - a.start);
  if (!list.length) { $('#history').innerHTML = `<p class="empty">${t('noSessions')}</p>`; return; }

  const groups = new Map();
  for (const s of list) {
    const k = startOfDay(s.start);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  $('#history').innerHTML = [...groups].map(([day, items]) => {
    // Day total only counts stopwatch time; streaks aren't "time spent".
    const hasTimed = items.some((s) => activity(s.activityId).type === 'timer');
    const total = hasTimed ? `<span data-live-day="${day}">${human(historyDayTotal(day))}</span>` : '<span></span>';
    return `<div class="day-head"><span>${dayLabel(day)}</span>${total}</div>
      <ul class="list">${items.map((s) => sessionItem(s, true)).join('')}</ul>`;
  }).join('');
}

/* ---------- Manage view ---------- */
function renderActivities() {
  $('#activity-list').innerHTML = state.activities.map((a) => {
    let sub;
    if (a.type === 'streak') {
      const st = streakStats(a.id);
      sub = `${t('streak')} · ${st.current ? t('currentX', human(st.current)) : t('notStartedLower')} · ${plural(st.slips, 'slip')}`;
    } else {
      const st = timerStats(a.id);
      sub = `${t('stopwatch')} · ${human(st.total)} · ${plural(st.count, 'session')}`;
    }
    return `<li><div class="item" style="--c:${a.color}">
      <span class="dot"></span>
      <span class="main"><span class="title">${esc(a.name)}</span><span class="sub">${sub}</span></span>
      <button class="btn small" data-rename="${a.id}">${t('rename')}</button>
      <button class="btn small danger" data-delete="${a.id}">${t('delete')}</button>
    </div></li>`;
  }).join('');
  renderSettings();
}

/* ---------- Settings view ---------- */
function renderSettings() {
  renderNotifyHint();
  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    const key = seg.dataset.setting;
    const val = key === 'notify' ? (settings.notify ? 'on' : 'off') : String(settings[key]);
    seg.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.value === val;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
  });
}

function applySettings() {
  applyTheme();
  buildFormatters();
  applyI18n();
  render();
}

document.querySelector('.settings').addEventListener('click', (e) => {
  const b = e.target.closest('.seg button');
  if (!b) return;
  const key = b.closest('.seg').dataset.setting;
  if (key === 'notify') { setNotify(b.dataset.value === 'on'); return; } // must run inside the tap (iOS)
  settings[key] = key === 'weekStart' ? Number(b.dataset.value) : b.dataset.value;
  saveSettings();
  applySettings();
  if (key === 'lang') schedulePushSync(); // reminder texts follow the language
});

/* ---------- Rendering / navigation ---------- */
const VIEWS = ['home', 'timer', 'history', 'activities'];
let currentView = 'home';

function render() {
  if (currentView === 'home') renderHome();
  if (currentView === 'timer') renderTimer();
  if (currentView === 'history') renderHistory();
  if (currentView === 'activities') renderActivities();
  updateTitle();
}

function show(view) {
  currentView = view;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  const tab = view === 'timer' ? 'home' : view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === tab));
  window.scrollTo(0, 0);
  render();
}

function openTimer(id) {
  state.selectedId = id;
  save();
  show('timer');
}

function updateTitle() {
  const sel = activity(state.selectedId);
  const run = currentView === 'timer' && sel.type === 'timer' && runningFor(sel.id);
  document.title = run ? `${isPaused(run) ? '⏸ ' : ''}${clock(dur(run))} · ${sel.name}` : 'Session Timer';
}

// Once a second: update only the live numbers, never rebuild buttons or lists.
function tick() {
  if (!state.sessions.some((s) => s.end === null)) return;
  document.querySelectorAll('[data-live-session]').forEach((el) => {
    const s = state.sessions.find((x) => x.id === el.dataset.liveSession);
    if (s) el.textContent = clock(dur(s));
  });
  document.querySelectorAll('[data-live-total]').forEach((el) => {
    el.textContent = human(timerStats(el.dataset.liveTotal).total);
  });
  document.querySelectorAll('[data-live-day]').forEach((el) => {
    el.textContent = human(historyDayTotal(Number(el.dataset.liveDay)));
  });
  document.querySelectorAll('[data-live-subject]').forEach((el) => {
    const [aid, sid] = el.dataset.liveSubject.split('|');
    const a = activity(aid);
    const row = a && subjectTotals(a).find((r) => r.id === sid);
    if (row) el.textContent = human(row.total);
  });
  if (currentView === 'timer') renderTimerLive();
  updateTitle();
  if (!document.hidden) runCheckin(); // a new hour passed while the app is open
}

setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  render();
  runCheckin();
  schedulePushSync(); // re-send in case an earlier sync failed (e.g. offline)
});
window.addEventListener('storage', (e) => {
  if (e.key === KEY) { state = load(); render(); }
  if (e.key === SETTINGS_KEY) { settings = loadSettings(); applySettings(); }
});

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) show(b.dataset.view);
});
$('#home-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]');
  if (b) openTimer(b.dataset.open);
});
$('#back').addEventListener('click', () => show('home'));
$('#home-new').addEventListener('click', () => { show('activities'); $('#new-activity').focus(); });

/* ---------- Timer actions ---------- */
function closePauses(s, at) { s.pauses.forEach((p) => { if (p.end === null) p.end = at; }); }

$('#controls').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const sel = activity(state.selectedId);
  const run = runningFor(sel.id);
  const at0 = now();

  switch (b.dataset.action) {
    case 'start': {
      if (run) break;
      const subjectId = sel.type === 'timer' ? currentSubjectId(sel, null) : null;
      state.sessions.push({ id: uid(), activityId: sel.id, start: at0, end: null, pauses: [], subjectId });
      break;
    }
    case 'pause':
      if (run && !isPaused(run)) run.pauses.push({ start: at0, end: null });
      break;
    case 'resume':
      if (run) closePauses(run, at0);
      break;
    case 'stop':
      if (run) { closePauses(run, at0); run.end = at0; }
      break;
    case 'slip': {
      if (!run) break;
      const ok = await ask({
        title: t('resetQ', sel.name),
        message: t('resetMsg', human(dur(run))),
        ok: t('reset'), danger: true,
      });
      if (!ok) return;
      const at = now();
      run.end = at;
      state.sessions.push({ id: uid(), activityId: sel.id, start: at, end: null, pauses: [] });
      break;
    }
  }
  save();
  if (navigator.vibrate) navigator.vibrate(15);
  render();
});

/* ---------- Subject actions ---------- */
$('#subject-chips').addEventListener('click', async (e) => {
  const sel = activity(state.selectedId);
  const run = runningFor(sel.id);

  if (e.target.closest('[data-add-subject]')) {
    const name = await ask({ title: t('newSubject'), message: t('subjectExample'), input: '', ok: t('add') });
    if (!name || !name.trim()) return;
    const sb = { id: uid(), name: name.trim().slice(0, 40) };
    sel.subjects.push(sb);
    sel.lastSubjectId = sb.id;
    if (run) run.subjectId = sb.id;
    save();
    render();
    return;
  }

  const chip = e.target.closest('[data-subject]');
  if (!chip) return;
  // Tapping the selected subject again clears it. While running, this changes the current session's subject.
  const id = chip.dataset.subject === currentSubjectId(sel, run) ? null : chip.dataset.subject;
  sel.lastSubjectId = id;
  if (run) run.subjectId = id;
  save();
  render();
});

$('#by-subject').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-edit-subject]');
  if (!b) return;
  const sel = activity(state.selectedId);
  const sb = sel.subjects.find((x) => x.id === b.dataset.editSubject);
  const res = await ask({ title: t('editSubject'), input: sb.name, ok: t('save'), extra: t('delete') });
  if (res === 'extra') {
    const n = state.sessions.filter((s) => s.subjectId === sb.id).length;
    const ok = await ask({
      title: t('deleteSubjectQ', sb.name),
      message: n ? t('subjectKept', plural(n, 'session')) : '',
      ok: t('delete'), danger: true,
    });
    if (!ok) return;
    sel.subjects = sel.subjects.filter((x) => x.id !== sb.id);
    state.sessions.forEach((s) => { if (s.subjectId === sb.id) s.subjectId = null; });
    if (sel.lastSubjectId === sb.id) sel.lastSubjectId = null;
  } else if (res && res.trim()) {
    sb.name = res.trim().slice(0, 40);
  } else return;
  save();
  render();
});

/* ---------- Session dialog (edit / add) ---------- */
function fillSubjectSelect(activityId, value) {
  const a = activity(activityId);
  const visible = a.type === 'timer' && a.subjects.length > 0;
  $('#sd-subject-label').hidden = !visible;
  $('#sd-subject').innerHTML = `<option value="">${t('noSubject')}</option>` +
    a.subjects.map((sb) => `<option value="${sb.id}">${esc(sb.name)}</option>`).join('');
  $('#sd-subject').value = visible && value && a.subjects.some((sb) => sb.id === value) ? value : '';
}
$('#sd-activity').addEventListener('change', (e) => fillSubjectSelect(e.target.value, null));

const dlg = $('#session-dialog');
let editingId = null;

function toLocalInput(x) {
  const d = new Date(x);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function openSession(id) {
  editingId = id;
  const s = id ? state.sessions.find((x) => x.id === id) : null;
  const defaultActivity = historyFilter !== 'all' && currentView === 'history' ? historyFilter : state.selectedId;
  $('#sd-title').textContent = s ? t('editSession') : t('addSession');
  $('#sd-activity').innerHTML = state.activities.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('#sd-activity').value = s ? s.activityId : defaultActivity;
  const actId = $('#sd-activity').value;
  fillSubjectSelect(actId, s ? s.subjectId : activity(actId).lastSubjectId);
  $('#sd-start').value = toLocalInput(s ? s.start : now() - 3600000);
  $('#sd-end').value = s ? (s.end === null ? '' : toLocalInput(s.end)) : toLocalInput(now());
  $('#sd-delete').hidden = !s;
  $('#sd-error').hidden = true;
  dlg.showModal();
}

function dialogError(msg) { const p = $('#sd-error'); p.textContent = msg; p.hidden = false; }

$('#session-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const activityId = $('#sd-activity').value;
  const start = new Date($('#sd-start').value).getTime();
  const endVal = $('#sd-end').value;
  const end = endVal ? new Date(endVal).getTime() : null;

  if (!Number.isFinite(start)) return dialogError(t('errStart'));
  if (end !== null && !Number.isFinite(end)) return dialogError(t('errEnd'));
  if (end !== null && end <= start) return dialogError(t('errOrder'));
  if (start > now()) return dialogError(t('errFuture'));
  if (end === null) {
    const other = runningFor(activityId);
    if (other && other.id !== editingId) return dialogError(t('errRunning'));
  }

  const subjectId = $('#sd-subject-label').hidden ? null : ($('#sd-subject').value || null);
  if (editingId) {
    const s = state.sessions.find((x) => x.id === editingId);
    Object.assign(s, { activityId, start, end, subjectId });
    if (end !== null) closePauses(s, end);
  } else {
    state.sessions.push({ id: uid(), activityId, start, end, pauses: [], subjectId });
  }
  save();
  dlg.close();
  render();
});

$('#sd-cancel').addEventListener('click', () => dlg.close());
$('#sd-delete').addEventListener('click', async () => {
  if (!await ask({ title: t('deleteSessionQ'), message: t('cannotUndo'), ok: t('delete'), danger: true })) return;
  state.sessions = state.sessions.filter((x) => x.id !== editingId);
  save();
  dlg.close();
  render();
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-session]');
  if (b) openSession(b.dataset.session);
});
$('#add-session').addEventListener('click', () => openSession(null));
$('#history-filter').addEventListener('change', (e) => { historyFilter = e.target.value; renderHistory(); });

/* ---------- Manage timers ---------- */
$('#add-activity').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#new-activity');
  const name = input.value.trim();
  if (!name) return;
  const color = COLORS[state.activities.length % COLORS.length];
  const a = { id: uid(), name, color, type: $('#new-activity-type').value === 'streak' ? 'streak' : 'timer', subjects: [] };
  state.activities.push(a);
  input.value = '';
  save();
  render();
});

$('#activity-list').addEventListener('click', async (e) => {
  const ren = e.target.closest('[data-rename]');
  const del = e.target.closest('[data-delete]');
  if (ren) {
    const a = activity(ren.dataset.rename);
    const name = await ask({ title: t('renameTimer'), input: a.name, ok: t('save') });
    if (name && name.trim()) { a.name = name.trim().slice(0, 40); save(); render(); }
  }
  if (del) {
    if (state.activities.length === 1) {
      return ask({ title: t('cantDelete'), message: t('needOne'), cancel: false });
    }
    const a = activity(del.dataset.delete);
    const n = sessionsFor(a.id).length;
    const ok = await ask({
      title: t('deleteQ', a.name),
      message: t('deleteMsg', plural(n, 'session')),
      ok: t('delete'), danger: true,
    });
    if (!ok) return;
    state.activities = state.activities.filter((x) => x.id !== a.id);
    state.sessions = state.sessions.filter((x) => x.activityId !== a.id);
    normalize(state);
    save();
    render();
  }
});

/* ---------- Export / import ---------- */
async function saveFile(name, text, type) {
  const file = new File([text], name, { type });
  // On phones, the share sheet is the most reliable way to save a file ("Save to Files").
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const csvCell = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const localStamp = (x) => toLocalInput(x).replace('T', ' ');

$('#export-json').addEventListener('click', () =>
  saveFile(`session-timer-${stamp()}.json`, JSON.stringify(state, null, 2), 'application/json'));

$('#export-csv').addEventListener('click', () => {
  const rows = [['activity', 'subject', 'type', 'start', 'end', 'duration_minutes', 'paused_minutes']];
  for (const s of [...state.sessions].sort((a, b) => a.start - b.start)) {
    const a = activity(s.activityId);
    rows.push([a.name, subjectOf(s) || '', a.type, localStamp(s.start), s.end === null ? '' : localStamp(s.end),
      (dur(s) / 60000).toFixed(1), (pausedMs(s) / 60000).toFixed(1)]);
  }
  saveFile(`session-timer-${stamp()}.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
});

$('#import-json').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!isValidState(data)) throw new Error(t('notBackup'));
    const ok = await ask({
      title: t('restoreQ'),
      message: t('restoreMsg', plural(data.sessions.length, 'session')),
      ok: t('replace'), danger: true,
    });
    if (!ok) return;
    state = normalize(data);
    save();
    render();
    ask({ title: t('restored'), cancel: false });
  } catch (err) {
    ask({ title: t('importFailed'), message: err.message, cancel: false });
  }
});

/* ---------- "Still studying?" check-in ----------
 * Asked when a stopwatch has run another full hour (active time): on opening the app,
 * while it's open, or when you tap the hourly notification. "I stopped" lets you pick
 * when you actually stopped, so forgotten time isn't counted.
 */
const isLearning = (a) => /learn|study|uč|uci|ucenje/i.test(a.name);
const fullHours = (s) => Math.floor(dur(s) / HOUR_MS);

function dueCheckin() {
  return state.sessions.find((s) => s.end === null && !isPaused(s)
    && activity(s.activityId).type === 'timer'
    && fullHours(s) >= 1 && fullHours(s) > (s.checkin || 0)) || null;
}

let checkinOpen = false;
async function runCheckin(sessionId = null) {
  if (checkinOpen || document.querySelector('dialog[open]')) return; // never on top of another dialog
  const s = sessionId
    ? state.sessions.find((x) => x.id === sessionId && x.end === null)
    : dueCheckin();
  if (!s) return;
  checkinOpen = true;
  try {
    const a = activity(s.activityId);
    const subj = subjectOf(s);
    const res = await ask({
      title: isLearning(a) ? t('stillStudying') : t('stillGoing'),
      message: t('checkinMsg', `${a.name}${subj ? ` · ${subj}` : ''}`, human(dur(s)), timeFmt.format(s.start)),
      ok: t('keepGoing'), extra: t('iStopped'), cancel: false,
    });
    if (s.end !== null) return; // stopped elsewhere meanwhile
    if (res === 'extra') {
      const end = await chooseStopTime(s);
      if (end === null) return;
      closePauses(s, end);
      s.end = end;
    } else {
      s.checkin = fullHours(s);
    }
    save();
    render();
  } finally {
    checkinOpen = false;
  }
}

function chooseStopTime(s) {
  const d = $('#choice-dialog');
  $('#choice-title').textContent = t('whenStopped');
  const options = [0, 15, 30, 60].map((m) => ({ m, at: now() - m * 60000 })).filter((o) => o.at > s.start);
  $('#choice-list').innerHTML = options.map((o) => {
    const label = o.m === 0 ? t('stopNow') : o.m === 60 ? t('hourAgo') : t('minAgo', o.m);
    return `<button type="button" class="btn choice" data-at="${o.at}"><span>${label}</span><span class="hint">${timeFmt.format(o.at)}</span></button>`;
  }).join('');
  return new Promise((resolve) => {
    const done = (v) => { d.onclick = null; d.oncancel = null; if (d.open) d.close(); resolve(v); };
    d.onclick = (e) => {
      const b = e.target.closest('[data-at]');
      if (b) done(Number(b.dataset.at));
      else if (e.target.closest('#choice-cancel')) done(null);
    };
    d.oncancel = (e) => { e.preventDefault(); done(null); };
    d.showModal();
  });
}

/* ---------- Hourly reminders (push notifications) ----------
 * The phone can't run code while the app is closed, so a small server (worker/) sends the
 * reminders. Whenever timers change, we send it the running stopwatch timers: id, name,
 * subject, start and paused time. Nothing else leaves the phone.
 */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
var pushSyncTimer = null; // `var`: save() may call schedulePushSync() before this line runs

function b64uToBytes(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function reminderTimers() {
  return state.sessions
    .filter((s) => s.end === null && activity(s.activityId).type === 'timer')
    .map((s) => {
      const open = isPaused(s) ? s.pauses[s.pauses.length - 1] : null;
      const closed = s.pauses.filter((p) => p !== open).reduce((n, p) => n + Math.max(0, p.end - p.start), 0);
      return {
        id: s.id, name: activity(s.activityId).name, subject: subjectOf(s),
        start: s.start, pausedMs: closed, pausedAt: open ? open.start : null,
      };
    });
}

function schedulePushSync() {
  if (!settings.notify || !PUSH_SERVER) return;
  clearTimeout(pushSyncTimer);
  pushSyncTimer = setTimeout(syncPushNow, 400);
}

async function syncPushNow() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) { settings.notify = false; saveSettings(); renderSettings(); return; } // permission was removed
    await fetch(`${PUSH_SERVER}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: settings.deviceId, subscription: sub.toJSON(), lang: settings.lang, timers: reminderTimers() }),
      keepalive: true,
    });
  } catch (e) {
    console.warn('Reminder sync failed (will retry when the app is opened):', e);
  }
}

let notifyMessage = null; // last error/info to show under the setting
function renderNotifyHint() {
  const el = $('#notify-hint');
  if (!el) return;
  let msg;
  if (notifyMessage) msg = notifyMessage;
  else if (!PUSH_SERVER) msg = t('notifyNoServer');
  else if (!pushSupported()) msg = t('notifyUnsupported');
  else if (Notification.permission === 'denied') msg = t('notifyDenied');
  else msg = settings.notify ? t('notifyOn') : t('notifyOff');
  el.textContent = msg;
}

async function setNotify(on) {
  notifyMessage = null;
  if (!on) {
    settings.notify = false;
    saveSettings();
    renderSettings();
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      if (PUSH_SERVER && settings.deviceId) {
        await fetch(`${PUSH_SERVER}/unsubscribe`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: settings.deviceId }),
        });
      }
    } catch (e) { /* turning off locally is what matters */ }
    return;
  }
  if (!PUSH_SERVER) { notifyMessage = t('notifyNoServer'); renderSettings(); return; }
  if (!pushSupported()) { notifyMessage = t('notifyUnsupported'); renderSettings(); return; }
  // iOS only shows the permission prompt if this call comes straight from the tap.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { notifyMessage = t('notifyDenied'); renderSettings(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC_KEY) });
    if (!sub) throw new Error('no subscription');
    if (!settings.deviceId) settings.deviceId = uid();
    settings.notify = true;
    saveSettings();
    await syncPushNow();
  } catch (e) {
    settings.notify = false;
    saveSettings();
    notifyMessage = t('notifyError', e.message || String(e));
  }
  renderSettings();
}

/* ---------- Updates ----------
 * iPhone home-screen apps are usually resumed from memory, not reloaded, so they would keep
 * running an old version. Every time the app comes back to the foreground we ask for a new
 * service worker; when one takes over, the page reloads itself (after any open dialog closes).
 * Your data is not touched by an update.
 */
function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  const reloadWhenIdle = () => {
    if (document.querySelector('dialog[open]')) { setTimeout(reloadWhenIdle, 1500); return; }
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing old to replace
    reloading = true;
    reloadWhenIdle();
  });
  navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' })
    .then((reg) => {
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      window.addEventListener('focus', check);
      setInterval(check, 30 * 60 * 1000);
    })
    .catch(console.error);
}

/* ---------- Startup ---------- */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
setupUpdates();
applyTheme();
buildFormatters();
applyI18n();
show('home');

// Tapping a reminder notification: opens the app with ?checkin=<session>, or (if the app was
// already open) the service worker sends a message instead.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'checkin') runCheckin(e.data.sessionId || null);
  });
}
{
  const params = new URLSearchParams(location.search);
  if (params.has('checkin')) {
    history.replaceState(null, '', location.pathname);
    runCheckin(params.get('checkin') || null);
  } else {
    runCheckin();
  }
}
schedulePushSync();
