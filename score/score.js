// Remote scorer for CourtVision livestreams. The camera phone shows a QR code linking
// here with a session ID after the "#"; this page sends each tap to the phone through
// Firebase Realtime Database and shows the score the phone publishes back. The phone
// keeps the official score, so this page never changes it on its own.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {
  getDatabase, connectDatabaseEmulator, ref, onValue, push, set, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-database.js';

const DATABASE_URL = 'https://courtvision-4f9a1-default-rtdb.firebaseio.com';
// Without a connection by then, the free plan's connection limit is the likely cause.
const CONNECT_TIMEOUT_MS = 12000;
// The camera phone writes a heartbeat every 15 s.
const PHONE_STALE_MS = 45000;
const ACK_TIMEOUT_MS = 6000;
// No rally ends this soon after the last point, so a second tap is a slip.
const DOUBLE_TAP_MS = 350;

const NOTES = {
  notStarted: "The match hasn't started yet. Start it on the camera phone.",
  ended: 'The match has already ended.',
  paused: 'Scoring is paused for the break. Tap Resume Play first.',
  playing: 'Play has already resumed.',
  nothingToUndo: 'There’s nothing to undo in this game.',
  late: "That tap reached the camera phone too late, so it wasn't counted. Check the score.",
};

const $ = (id) => document.getElementById(id);
const sid = location.hash.slice(1);

let db;
let state = null;
let connected = false;
let everConnected = false;
let sessionGone = false;
let serverOffset = 0;
let pending = [];
let lastPointTap = 0;
let toastTimer;
let wakeLock = null;

if (!/^[A-Za-z0-9_-]{24,64}$/.test(sid)) {
  showScreen("This link isn't complete", 'Scan the QR code on the camera phone again.');
  setPill('bad', 'No match');
} else {
  start();
}

function start() {
  const params = new URLSearchParams(location.search);
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  // Local testing only: ?emulator=host:port&ns=name uses the database emulator.
  const emulator = local ? params.get('emulator') : null;
  const url = emulator ? `https://${params.get('ns') || 'courtvision-e2e'}.firebaseio.com` : DATABASE_URL;
  db = getDatabase(initializeApp({ databaseURL: url }));
  if (emulator) {
    const [host, port] = emulator.split(':');
    connectDatabaseEmulator(db, host, Number(port));
  }

  const session = `remoteScoring/${sid}`;
  const me = scorerId();
  const timer = setTimeout(() => {
    if (everConnected) return;
    if (navigator.onLine === false) {
      showScreen("You're offline", 'Connect to the internet, then try again.', 'Try Again');
    } else {
      showScreen('Remote scoring has reached its limit right now',
        'Try again in a few minutes. The match can still be scored on the camera phone.', 'Try Again');
    }
    setPill('bad', 'Not connected');
  }, CONNECT_TIMEOUT_MS);

  onValue(ref(db, '.info/serverTimeOffset'), (snap) => { serverOffset = snap.val() || 0; });
  onValue(ref(db, '.info/connected'), (snap) => {
    connected = snap.val() === true;
    if (connected) {
      everConnected = true;
      clearTimeout(timer);
      // Lets the camera phone show "Scorer connected".
      const presence = ref(db, `${session}/scorers/${me}`);
      onDisconnect(presence).remove()
        .then(() => set(presence, { seenAt: serverTimestamp() }))
        .catch(() => {});
    }
    render();
  });
  onValue(ref(db, `${session}/state`), (snap) => {
    if (snap.val() === null) { endSession(); return; }
    state = snap.val();
    resolvePending();
    render();
  }, () => endSession());

  setInterval(render, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => send(button.dataset.action, button));
  });
  keepAwake();
}

// MARK: - Showing the match

function render() {
  if (sessionGone || !state) return;
  if (state.ended) {
    showScreen('Match over', `${finalSummary()}Thanks for scoring! The video is saved on the camera phone.`);
    setPill('ok', 'Match over');
    return;
  }
  $('screen').hidden = true;
  $('scorer').hidden = false;

  const phoneOnline = state.online !== false && Date.now() + serverOffset - (state.beat || 0) < PHONE_STALE_MS;
  if (!connected) setPill('warn', 'Reconnecting…');
  else if (!phoneOnline) setPill('bad', 'Camera phone offline');
  else setPill('ok', 'Connected');

  const [won1, won2] = gamesWon();
  const stream = { live: ' · Live', weak: ' · Live (weak signal)', reconnecting: ' · Stream reconnecting', lost: ' · Stream lost' }[state.stream] || '';
  $('meta').textContent = state.started
    ? `Game ${state.game || 1} · Games ${won1}–${won2}${stream}`
    : 'Match not started yet';

  $('p1Name').textContent = state.p1Name || 'Player 1';
  $('p2Name').textContent = state.p2Name || 'Player 2';
  $('p1Score').textContent = state.p1 ?? 0;
  $('p2Score').textContent = state.p2 ?? 0;
  $('p1Serve').hidden = state.server !== 'p1';
  $('p2Serve').hidden = state.server !== 'p2';
  $('pointP1').setAttribute('aria-label', `${state.p1Name || 'Player 1'}, ${state.p1 ?? 0}. Add a point.`);
  $('pointP2').setAttribute('aria-label', `${state.p2Name || 'Player 2'}, ${state.p2 ?? 0}. Add a point.`);

  let banner = null;
  if (!connected) banner = ['warn', 'Reconnecting… Scoring is paused until this phone is back online.'];
  else if (!phoneOnline) banner = ['bad', "The camera phone is offline or CourtVision isn't open on it. Taps won't count until it's back."];
  else if (!state.started) banner = ['', 'Waiting for the match to start on the camera phone.'];
  else if (state.paused) banner = ['', 'On break. Tap Resume Play to keep scoring.'];
  const bannerEl = $('banner');
  bannerEl.hidden = !banner;
  if (banner) {
    bannerEl.className = `banner ${banner[0]}`;
    bannerEl.textContent = banner[1];
  }

  const canSend = connected && phoneOnline && state.started;
  const canScore = canSend && !state.paused;
  for (const id of ['pointP1', 'pointP2']) $(id).disabled = !canScore;
  const hint = canScore ? 'Tap for +1' : (state.started && state.paused ? 'On break' : '');
  $('p1Hint').textContent = hint;
  $('p2Hint').textContent = hint;
  $('p1Hint').hidden = !hint;
  $('p2Hint').hidden = !hint;

  $('undo').disabled = !canSend || !state.undo;
  $('undoText').textContent = state.undo ? `Undo ${state.undo}` : 'Undo';
  for (const id of ['highlight', 'toggleServer', 'endGame', 'endMatch']) $(id).disabled = !canSend;
  const breakButton = $('breakButton');
  breakButton.disabled = !canSend;
  breakButton.dataset.action = state.paused ? 'resume' : 'pause';
  breakButton.textContent = state.paused ? '▶ Resume Play' : 'Break';
  breakButton.classList.toggle('lime', !!state.paused && canSend);
}

function gamesWon() {
  const games = Array.isArray(state?.games) ? state.games : Object.values(state?.games || {});
  let won1 = 0, won2 = 0;
  for (let i = 0; i + 1 < games.length; i += 2) {
    if (games[i] > games[i + 1]) won1++;
    else if (games[i + 1] > games[i]) won2++;
  }
  return [won1, won2];
}

function finalSummary() {
  const games = Array.isArray(state?.games) ? state.games : Object.values(state?.games || {});
  if (games.length < 2) return '';
  const scores = [];
  for (let i = 0; i + 1 < games.length; i += 2) {
    // A match ended during the break after a game archives an empty one.
    if (games[i] || games[i + 1]) scores.push(`${games[i]}–${games[i + 1]}`);
  }
  if (!scores.length) return '';
  return `${state.p1Name || 'Player 1'} vs ${state.p2Name || 'Player 2'}: ${scores.join(', ')}. `;
}

function endSession() {
  if (sessionGone) return;
  sessionGone = true;
  if (state?.ended) {
    showScreen('Match over', `${finalSummary()}Thanks for scoring! The video is saved on the camera phone.`);
    setPill('ok', 'Match over');
  } else {
    showScreen('This scoring link has ended', 'Ask whoever is running the camera phone for a new QR code.');
    setPill('bad', 'Ended');
  }
}

function showScreen(title, text, buttonLabel) {
  $('scorer').hidden = true;
  $('screen').hidden = false;
  $('screenTitle').textContent = title;
  $('screenText').textContent = text;
  const button = $('screenButton');
  button.hidden = !buttonLabel;
  if (buttonLabel) {
    button.textContent = buttonLabel;
    button.onclick = () => location.reload();
  }
}

function setPill(kind, text) {
  const pill = $('connection');
  pill.className = `pill ${kind}`;
  pill.querySelector('.pill-text').textContent = text;
}

// MARK: - Sending taps

async function send(action, button) {
  if (!state || button.disabled) return;
  if (action === 'pointP1' || action === 'pointP2') {
    const now = Date.now();
    if (now - lastPointTap < DOUBLE_TAP_MS) return;
    lastPointTap = now;
  }
  if (action === 'endGame' && !await confirmAction(`End game ${state.game || 1}?`,
    `Final score ${state.p1 ?? 0}–${state.p2 ?? 0}. The break between games starts; tap Resume Play when you're ready.`, 'End Game')) return;
  if (action === 'endMatch' && !await confirmAction('End the match?',
    "This stops the recording and the livestream. The video is saved on the camera phone. You can't undo this.", 'End Match', true)) return;

  keepAwake();
  if (navigator.vibrate) navigator.vibrate(15);
  const commandRef = push(ref(db, `remoteScoring/${sid}/commands`));
  const entry = { key: commandRef.key, action, button };
  pending.push(entry);
  button.classList.add('sending');
  set(commandRef, { action, at: serverTimestamp(), by: scorerId() }).catch(() => {
    finish(entry);
    showToast("That tap didn't go through. Try again.");
  });
  setTimeout(() => {
    if (!pending.includes(entry)) return;
    finish(entry);
    showToast("The camera phone hasn't confirmed that tap yet. Check the score before tapping again.");
  }, ACK_TIMEOUT_MS);
}

// The phone acknowledges each command in the same write as the new score. Push keys
// sort by time, so everything up to the acknowledged key has been handled.
function resolvePending() {
  if (!state?.ack) return;
  for (const entry of pending.filter((p) => p.key <= state.ack)) {
    finish(entry);
    if (entry.key === state.ack) feedback(entry.action, state.ackNote);
  }
}

function finish(entry) {
  pending = pending.filter((p) => p !== entry);
  entry.button.classList.remove('sending');
}

function feedback(action, note) {
  if (note) { showToast(NOTES[note] || "That tap wasn't counted."); return; }
  const messages = {
    highlight: 'Highlight saved ★',
    pause: 'Break started',
    resume: 'Play resumed',
    endGame: 'Game saved. On break — tap Resume Play when you’re ready.',
    undoPoint: 'Point undone',
  };
  if (messages[action]) showToast(messages[action]);
}

function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

function confirmAction(title, text, okLabel, destructive = false) {
  const dialog = $('confirm');
  if (typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOK').textContent = okLabel;
  dialog.classList.toggle('danger', destructive);
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

// MARK: - Helpers

function scorerId() {
  try {
    let id = localStorage.getItem('cvScorerId');
    if (!id || !/^[A-Za-z0-9_-]{16,40}$/.test(id)) {
      id = randomId();
      localStorage.setItem('cvScorerId', id);
    }
    return id;
  } catch {
    scorerId.fallback ||= randomId();
    return scorerId.fallback;
  }
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

// Keeps the scorer's screen on while the page is open, where supported.
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {
    wakeLock = null;
  }
}
