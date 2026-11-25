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
const KEY = 'session-timer.v1';
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
  catch (e) { ask({ title: 'Could not save', message: e.message, cancel: false }); }
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
function ask({ title, message = '', ok = 'OK', danger = false, input = null, cancel = true, extra = null }) {
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
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
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
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86400);
  const hms = `${pad(Math.floor((t % 86400) / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
  if (d) return `${d}d ${hms}`;
  return `${Math.floor(t / 3600)}:${hms.slice(3)}`;
}

function human(ms) {
  if (ms < 60000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeek(t) { // Monday
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function dayLabel(t) {
  const today = startOfDay(now());
  const day = startOfDay(t);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === today) return 'Today';
  if (day === yesterday.getTime()) return 'Yesterday';
  return dayFmt.format(t);
}

function range(s) {
  const multiDay = startOfDay(s.start) !== startOfDay(s.end ?? now());
  const f = multiDay ? dateTimeFmt : timeFmt;
  return `${f.format(s.start)} – ${s.end === null ? 'now' : f.format(s.end)}`;
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
    const label = dayLabel(s.start);
    title = label === 'Today' || label === 'Yesterday' ? label : shortDayFmt.format(s.start);
  }
  const subj = subjectOf(s);
  if (subj) title += ` · ${esc(subj)}`;
  const brk = pausedMs(s);
  let sub = range(s);
  if (a.type === 'streak') sub += live ? ' · current streak' : ' · streak';
  else if (paused) sub += ' · paused';
  else if (brk >= 1000) sub += ` · ${human(brk)} paused`;
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
    sub = `Streak · ${plural(st.slips, 'slip')}${st.longest ? ` · best ${human(st.longest)}` : ''}`;
    right = run
      ? `<span class="dur streak" data-live-session="${run.id}">${clock(dur(run))}</span>`
      : '<span class="dur idle">Not started</span>';
  } else {
    sub = `Stopwatch · <span data-live-total="${a.id}">${human(timerStats(a.id).total)}</span> total`;
    const subj = run && subjectOf(run);
    if (subj) sub += ` · now: ${esc(subj)}`;
    if (paused) right = `<span class="dur paused" data-live-session="${run.id}">${clock(dur(run))}</span>`;
    else if (run) right = `<span class="dur live" data-live-session="${run.id}">${clock(dur(run))}</span>`;
    else right = '<span class="dur idle">Not running</span>';
  }
  const stateCls = run ? (paused ? ' is-running is-paused' : ' is-running') : '';
  return `<li><button class="item${stateCls}" data-open="${a.id}" style="--c:${a.color}">
    <span class="badge">${a.type === 'streak' ? ICONS.flame : ICONS.stopwatch}</span>
    <span class="main"><span class="title">${esc(a.name)}</span><span class="sub">${sub}</span></span>
    ${right}<span class="chev">${ICONS.chevron}</span>
  </button></li>`;
}

const homeDateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
function renderHome() {
  $('#home-date').textContent = homeDateFmt.format(now());
  $('#home-list').innerHTML = state.activities.map(homeItem).join('');
}

/* ---------- Timer detail view ---------- */
function renderControls(sel, run) {
  const paused = run && isPaused(run);
  let html;
  if (sel.type === 'streak') {
    html = run
      ? `<button class="big-btn ghost" data-action="slip">${ICONS.reset}I slipped – reset</button>`
      : `<button class="big-btn" data-action="start">${ICONS.play}Start streak</button>`;
  } else if (!run) {
    html = `<button class="big-btn" data-action="start">${ICONS.play}Start</button>`;
  } else {
    html = `<button class="big-btn pause" data-action="${paused ? 'resume' : 'pause'}">${paused ? ICONS.play + 'Resume' : ICONS.pause + 'Pause'}</button>
      <button class="big-btn stop" data-action="stop">${ICONS.stop}Stop</button>`;
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
  if (streak) sub = run ? `Clean since ${dateTimeFmt.format(run.start)}` : 'Not started';
  else if (paused) sub = `Paused · started ${timeFmt.format(run.start)}`;
  else sub = run ? `Started ${timeFmt.format(run.start)}` : 'Not running';
  const subj = run && subjectOf(run);
  if (subj) sub += ` · ${subj}`;
  $('#clock-sub').textContent = sub;

  if (streak) {
    const st = streakStats(sel.id);
    $('#stats').innerHTML = statTiles([
      ['Current streak', run ? human(st.current) : '–'],
      ['Longest streak', st.longest ? human(st.longest) : '–'],
      ['Slips', st.slips],
      ['Average streak', st.avg ? human(st.avg) : '–'],
    ]);
  } else {
    const st = timerStats(sel.id);
    $('#stats').innerHTML = statTiles([
      [sel.subjects.length ? 'Total (all subjects)' : 'Total time', human(st.total)],
      ['Sessions', st.count],
      ['Today', human(st.today)],
      ['This week', human(st.week)],
      ['Average session', st.avg ? human(st.avg) : '–'],
      ['Longest session', st.longest ? human(st.longest) : '–'],
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
  const none = { id: '', name: 'No subject', total: 0, count: 0 };
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
  ).join('') + `<button class="chip add-chip" data-add-subject>+ ${sel.subjects.length ? 'Subject' : 'Add subject'}</button>`;

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
  $('#recent-title').textContent = sel.type === 'streak' ? 'Recent streaks' : 'Recent sessions';
  $('#recent-title').hidden = !recent.length;
}

/* ---------- History view ---------- */
let historyFilter = 'all';

function historyDayTotal(day) {
  return sessionsFor(historyFilter === 'all' ? null : historyFilter)
    .filter((s) => startOfDay(s.start) === day && activity(s.activityId).type === 'timer')
    .reduce((t, s) => t + dur(s), 0);
}

function renderHistory() {
  const filter = $('#history-filter');
  if (historyFilter !== 'all' && !activity(historyFilter)) historyFilter = 'all';
  filter.innerHTML = `<option value="all">All timers</option>` +
    state.activities.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  filter.value = historyFilter;

  const list = sessionsFor(historyFilter === 'all' ? null : historyFilter).sort((a, b) => b.start - a.start);
  if (!list.length) { $('#history').innerHTML = '<p class="empty">No sessions yet.</p>'; return; }

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
      sub = `Streak · ${st.current ? 'current ' + human(st.current) : 'not started'} · ${plural(st.slips, 'slip')}`;
    } else {
      const st = timerStats(a.id);
      sub = `Stopwatch · ${human(st.total)} · ${plural(st.count, 'session')}`;
    }
    return `<li><div class="item" style="--c:${a.color}">
      <span class="dot"></span>
      <span class="main"><span class="title">${esc(a.name)}</span><span class="sub">${sub}</span></span>
      <button class="btn small" data-rename="${a.id}">Rename</button>
      <button class="btn small danger" data-delete="${a.id}">Delete</button>
    </div></li>`;
  }).join('');
}

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
}

setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
window.addEventListener('storage', (e) => { if (e.key === KEY) { state = load(); render(); } });

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
  const t = now();

  switch (b.dataset.action) {
    case 'start': {
      if (run) break;
      const subjectId = sel.type === 'timer' ? currentSubjectId(sel, null) : null;
      state.sessions.push({ id: uid(), activityId: sel.id, start: t, end: null, pauses: [], subjectId });
      break;
    }
    case 'pause':
      if (run && !isPaused(run)) run.pauses.push({ start: t, end: null });
      break;
    case 'resume':
      if (run) closePauses(run, t);
      break;
    case 'stop':
      if (run) { closePauses(run, t); run.end = t; }
      break;
    case 'slip': {
      if (!run) break;
      const ok = await ask({
        title: `Reset "${sel.name}"?`,
        message: `Your current streak of ${human(dur(run))} will be saved to history and a new streak starts now.`,
        ok: 'Reset', danger: true,
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
    const name = await ask({ title: 'New subject', message: 'e.g. Math, English, Programming', input: '', ok: 'Add' });
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
  const res = await ask({ title: 'Edit subject', input: sb.name, ok: 'Save', extra: 'Delete' });
  if (res === 'extra') {
    const n = state.sessions.filter((s) => s.subjectId === sb.id).length;
    const ok = await ask({
      title: `Delete subject "${sb.name}"?`,
      message: n ? `Its ${plural(n, 'session')} will be kept, without a subject.` : '',
      ok: 'Delete', danger: true,
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
  const show = a.type === 'timer' && a.subjects.length > 0;
  $('#sd-subject-label').hidden = !show;
  $('#sd-subject').innerHTML = '<option value="">No subject</option>' +
    a.subjects.map((sb) => `<option value="${sb.id}">${esc(sb.name)}</option>`).join('');
  $('#sd-subject').value = show && value && a.subjects.some((sb) => sb.id === value) ? value : '';
}
$('#sd-activity').addEventListener('change', (e) => fillSubjectSelect(e.target.value, null));

const dlg = $('#session-dialog');
let editingId = null;

function toLocalInput(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function openSession(id) {
  editingId = id;
  const s = id ? state.sessions.find((x) => x.id === id) : null;
  const defaultActivity = historyFilter !== 'all' && currentView === 'history' ? historyFilter : state.selectedId;
  $('#sd-title').textContent = s ? 'Edit session' : 'Add session';
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

  if (!Number.isFinite(start)) return dialogError('Please enter a valid start time.');
  if (end !== null && !Number.isFinite(end)) return dialogError('Please enter a valid end time.');
  if (end !== null && end <= start) return dialogError('End must be after start.');
  if (start > now()) return dialogError('Start cannot be in the future.');
  if (end === null) {
    const other = runningFor(activityId);
    if (other && other.id !== editingId) return dialogError('This timer already has a running session.');
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
  if (!await ask({ title: 'Delete this session?', message: 'This cannot be undone.', ok: 'Delete', danger: true })) return;
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
  const a = { id: uid(), name, color, type: $('#new-activity-type').value === 'streak' ? 'streak' : 'timer' };
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
    const name = await ask({ title: 'Rename timer', input: a.name, ok: 'Save' });
    if (name && name.trim()) { a.name = name.trim().slice(0, 40); save(); render(); }
  }
  if (del) {
    if (state.activities.length === 1) {
      return ask({ title: 'Can’t delete', message: 'You need at least one timer.', cancel: false });
    }
    const a = activity(del.dataset.delete);
    const n = sessionsFor(a.id).length;
    const ok = await ask({
      title: `Delete "${a.name}"?`,
      message: `This also deletes its ${plural(n, 'session')}. This cannot be undone.`,
      ok: 'Delete', danger: true,
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
const localStamp = (t) => toLocalInput(t).replace('T', ' ');

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
    if (!isValidState(data)) throw new Error('This file is not a Session Timer backup.');
    const ok = await ask({
      title: 'Restore backup?',
      message: `This replaces all current data with the backup (${plural(data.sessions.length, 'session')}).`,
      ok: 'Replace', danger: true,
    });
    if (!ok) return;
    state = normalize(data);
    save();
    render();
    ask({ title: 'Backup restored', cancel: false });
  } catch (err) {
    ask({ title: 'Import failed', message: err.message, cancel: false });
  }
});

/* ---------- Startup ---------- */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(console.error));
}
show('home');
