// monitor_cde_basis.js
//
// CDE futures basis-vs-funding monitor + live dashboard.
// Public REST only (no auth):
//   GET /api/v3/brokerage/market/products?product_type=FUTURE
//   GET /api/v3/brokerage/market/products?product_type=SPOT
//
// Pipeline (see analysis/cde_basis.js for the verified math):
//   - Dated basis APY   = (F-S)/S * (365/T_years)              [per-token front expiry]
//   - Perp funding APY  = funding_rate * 8760 (hourly)         [can be negative]
//   - Perp gap %        = (P - index)/index
//   - All-in over hold h: dated (F-S)/S*(h/T)  vs  perp gap + funding*(h/periods)
//   - Cheaper-to-LONG   = lower all-in. Spread trade = short expensive / long cheap.
//
// History/z-score layer (see analysis/cde_basis_stats.js):
//   - Every poll is appended to data/cde_basis_LOG.jsonl (analysis/cde_basis.js#logPoll).
//   - After each poll this process also recomputes per-token stats (mean/stdev/z,
//     min/max/percentiles) over a rolling window (default 30d) from that log.
//   - z = (latest divergence - window mean) / window stdev. |z| >= 2 flags a
//     divergence reading that's unusual vs its own recent history.
//   - /chart?root=BTC renders a time-series page (mean +/- 2sigma band) per token.
//
// Runs as a Node process (set up as a Windows scheduled task to keep it live).
//   CLI: node monitor_cde_basis.js [--once] [--port 8080] [--poll 30000] [--dryrun]
//        [--horizon-days N] [--stats-window-days N]
//
// Env overrides (all optional; can also live in a local .env file, never committed):
//   CDE_BASIS_PORT, CDE_BASIS_POLL_MS, CDE_BASIS_ONCE, CDE_BASIS_DRYRUN, CDE_BASIS_LOG,
//   CDE_BASIS_HORIZON_DAYS, CDE_BASIS_STATS_WINDOW_DAYS, CDE_BASIS_STALE_POLLS,
//   CDE_BASIS_MAX_LOG_DAYS      (active-log retention before rotating older polls to data/archive/, default 60)
//   CDE_BASIS_BOOK_TTL_MS / CDE_BASIS_BOOK_INTERVAL_MS   (Bid/Ask tab order-book cache and request pacing)
//   CDE_ALERT_MAJORS / CDE_ALERT_MAJOR_APY / CDE_ALERT_ALT_APY / CDE_ALERT_CLEAR_APY   (alert defaults; editable live at /alerts/settings)
//   CDE_BASIS_TELEGRAM_BOT_TOKEN / CDE_BASIS_TELEGRAM_CHAT_ID   (optional Telegram alerts; console-only if unset)
//
// Tabs: Overview, Front vs Perp, Front vs Back, Term Structure, Bid/Ask (executable),
//   My Positions (APY), Volume, Calibration, plus /chart?root=X, /alerts/settings.
// Log growth: the stats/calibration code parses the whole active log, so the log is
//   rotated automatically (analysis/cde_log_rotation.js) at startup and daily; nothing is deleted,
//   older polls are moved to data/archive/.

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- lightweight .env loader (no external dependency) ----
// Loads perp-arb/.env if present, WITHOUT overriding a variable already set
// in the real shell environment (so an explicit $env:X=... before launch
// still wins). This lets secrets live in a plain local file instead of
// needing to be set globally — works the same whether launched by hand or
// via Task Scheduler, unlike a session-only $env: variable.
// .env format: one KEY=value per line, '#' starts a comment, blank lines ok.
// NEVER share this file or its contents — it's the actual secret, not a
// reference to one.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
  console.log('[cde-basis] loaded .env from', envPath);
})();
const { buildSnapshot, logPoll, LOG_PATH, SANITY_CAP_PCT } = require('./analysis/cde_basis');
const calibration = require('./analysis/cde_basis_calibration');
const { rotateLogIfNeeded } = require('./analysis/cde_log_rotation');
const bidask = require('./analysis/cde_basis_bidask');
const myPos = require('./analysis/cde_basis_positions');
const { statsFromLog, historyFor, METRICS } = require('./analysis/cde_basis_stats');

// ---------- "my positions" tracking (pin a token, see if it's converging or
// diverging vs. where it was when you pinned it) ----------
// Persisted to disk (not localStorage) so it survives browser changes/restarts
// and stays in the same dir pattern as the log file.
const POSITIONS_PATH = path.join(path.dirname(LOG_PATH), 'cde_basis_positions.json');

function loadPositions() {
  try {
    if (!fs.existsSync(POSITIONS_PATH)) return {};
    return JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8'));
  } catch (e) {
    console.warn('[cde-basis] loadPositions failed:', e.message);
    return {};
  }
}
function savePositions(positions) {
  try {
    fs.mkdirSync(path.dirname(POSITIONS_PATH), { recursive: true });
    fs.writeFileSync(POSITIONS_PATH, JSON.stringify(positions, null, 2));
  } catch (e) {
    console.warn('[cde-basis] savePositions failed:', e.message);
  }
}

// ---------- hidden tokens (toggle a token off the main scanning pages) ----------
const HIDDEN_PATH = path.join(path.dirname(LOG_PATH), 'cde_basis_hidden.json');
function loadHidden() {
  try {
    if (!fs.existsSync(HIDDEN_PATH)) return {};
    return JSON.parse(fs.readFileSync(HIDDEN_PATH, 'utf8'));
  } catch (e) {
    console.warn('[cde-basis] loadHidden failed:', e.message);
    return {};
  }
}
function saveHidden(hidden) {
  try {
    fs.mkdirSync(path.dirname(HIDDEN_PATH), { recursive: true });
    fs.writeFileSync(HIDDEN_PATH, JSON.stringify(hidden, null, 2));
  } catch (e) {
    console.warn('[cde-basis] saveHidden failed:', e.message);
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function parseFormBody(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}
// Direction implied by the divergence sign at the moment a position was
// opened: > 0 means the dated future was rich (short future / long perp);
// < 0 means the perp was rich (long future / short perp). Matches the sign
// convention already used for the main table's "Cheaper to LONG" column.
function sideLabel(entryDiv) {
  if (entryDiv == null) return '—';
  return entryDiv >= 0 ? 'SHORT FUTURE / LONG PERP' : 'LONG FUTURE / SHORT PERP';
}
// Is the trade working? A pinned position is a bet that divergence reverts
// toward its mean, so "good" = moved back toward zero since entry, "bad" =
// moved further away. A sign flip (rich side swapped) is called out
// separately since that changes which leg is actually favorable to hold.
const FLAT_THRESHOLD_PCT = 0.10; // movement smaller than this = treat as flat/noise
function positionStatus(entryDiv, currentDiv) {
  if (entryDiv == null || currentDiv == null) return { label: 'N/A', cls: '' };
  const movement = currentDiv - entryDiv;
  const flipped = entryDiv !== 0 && currentDiv !== 0 && Math.sign(entryDiv) !== Math.sign(currentDiv);
  if (flipped) return { label: 'FLIPPED', cls: 'flip' };
  if (Math.abs(movement) < FLAT_THRESHOLD_PCT) return { label: 'FLAT', cls: '' };
  const converging = entryDiv >= 0 ? movement < 0 : movement > 0; // moving toward 0
  return converging ? { label: 'CONVERGING', cls: 'pos' } : { label: 'DIVERGING', cls: 'neg' };
}

const BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const FUT_URL = `${BASE}?product_type=FUTURE`;
const SPOT_URL = `${BASE}?product_type=SPOT`;

const PORT = parseInt(process.env.CDE_BASIS_PORT || '') || argv('--port', 8080);
const POLL_MS = parseInt(process.env.CDE_BASIS_POLL_MS || '') || argv('--poll', 30_000);
const ONCE = hasFlag('--once') || !!process.env.CDE_BASIS_ONCE;
const DRYRUN = hasFlag('--dryrun') || !!process.env.CDE_BASIS_DRYRUN;
const HORIZON_DAYS = (() => {
  const v = process.env.CDE_BASIS_HORIZON_DAYS || argv('--horizon-days', null);
  const n = v == null ? null : parseFloat(v);
  return (n != null && !isNaN(n) && n > 0) ? n : null;
})();
const STATS_WINDOW_DAYS = (() => {
  const v = process.env.CDE_BASIS_STATS_WINDOW_DAYS || argv('--stats-window-days', '30');
  const n = parseFloat(v);
  return (!isNaN(n) && n > 0) ? n : 30;
})();
const MAX_ACTIVE_LOG_DAYS = (() => {
  const v = process.env.CDE_BASIS_MAX_LOG_DAYS || argv('--max-log-days', '60');
  const n = parseFloat(v);
  return (!isNaN(n) && n > 0) ? n : 60;
})();
const FETCH_TIMEOUT_MS = 15_000;

// ---------- Telegram alerting ----------
// Same env var names as the other monitors in this project (hxro_monitor.py,
// trade_tracker.py) — set once, works for any of them, or point this one at
// a different bot/chat by overriding just these two here.
// Dedicated to this script only — deliberately NOT shared with
// hxro_monitor.py / trade_tracker.py's TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
// With many scripts each sending to their own channel, silently falling back
// to another script's variable would risk alerts landing in the wrong place
// with no warning. Set these explicitly for a dedicated CDE-basis channel.
const TELEGRAM_BOT_TOKEN = process.env.CDE_BASIS_TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.CDE_BASIS_TELEGRAM_CHAT_ID || '';
// Thresholds: "major" gets a lower bar since majors are usually tighter/more
// liquid, so a smaller dislocation there is more meaningful than the same
// number in a thinner alt. Edit MAJORS or the two threshold numbers directly
// if these defaults don't match how you think about it — this is a judgment
// call, not something derived from the data.
// These env/CLI values are only the FIRST-RUN defaults, seeding the
// persisted settings file below. After that, /alerts/settings (the webapp
// page) is the actual source of truth — edits there take effect on the next
// poll with no restart needed, and survive restarts since they're on disk.
const DEFAULT_MAJOR_APY_THRESHOLD = (() => {
  const v = process.env.CDE_ALERT_MAJOR_APY || argv('--alert-major-apy', '20');
  const n = parseFloat(v);
  return (!isNaN(n) && n > 0) ? n : 20;
})();
const DEFAULT_ALT_APY_THRESHOLD = (() => {
  const v = process.env.CDE_ALERT_ALT_APY || argv('--alert-alt-apy', '30');
  const n = parseFloat(v);
  return (!isNaN(n) && n > 0) ? n : 30;
})();
const DEFAULT_MAJORS = (process.env.CDE_ALERT_MAJORS || 'BTC,ETH').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const DEFAULT_CLEAR_THRESHOLD = (() => {
  const v = process.env.CDE_ALERT_CLEAR_APY || argv('--alert-clear-apy', '10');
  const n = parseFloat(v);
  return (!isNaN(n) && n >= 0) ? n : 10;
})();
const ALERT_ZSCORE_WINDOW_DAYS = 1; // "over the past day" per the user's spec, independent of STATS_WINDOW_DAYS

const ALERT_SETTINGS_PATH = path.join(path.dirname(LOG_PATH), 'cde_basis_alert_settings.json');
function loadAlertSettings() {
  try {
    if (fs.existsSync(ALERT_SETTINGS_PATH)) {
      const s = JSON.parse(fs.readFileSync(ALERT_SETTINGS_PATH, 'utf8'));
      if (typeof s.majorThreshold === 'number' && typeof s.altThreshold === 'number' && Array.isArray(s.majors)) {
        // Backward-compatible: an older settings file saved before the
        // hysteresis fix won't have clearThreshold yet — fill it in rather
        // than reject the whole file.
        if (typeof s.clearThreshold !== 'number') s.clearThreshold = DEFAULT_CLEAR_THRESHOLD;
        return s;
      }
    }
  } catch (e) {
    console.warn('[cde-basis] loadAlertSettings failed, using defaults:', e.message);
  }
  return { majorThreshold: DEFAULT_MAJOR_APY_THRESHOLD, altThreshold: DEFAULT_ALT_APY_THRESHOLD, clearThreshold: DEFAULT_CLEAR_THRESHOLD, majors: DEFAULT_MAJORS };
}
function saveAlertSettings(s) {
  try {
    fs.mkdirSync(path.dirname(ALERT_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(ALERT_SETTINGS_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    console.warn('[cde-basis] saveAlertSettings failed:', e.message);
  }
}
// Mutable — this is genuinely reassigned by the /alerts/settings POST
// handler, which is exactly what lets a webapp edit change live behavior.
let alertSettings = loadAlertSettings();
if (!fs.existsSync(ALERT_SETTINGS_PATH)) saveAlertSettings(alertSettings); // seed the file on first run

// Maps a bestSpread pair to the logged metric key that has that pair's own
// z-score history — each of the 3 pairs is logged separately (div, term,
// bpApy) specifically so this mapping always has real history to draw on.
// Each of the 3 possible pairwise trades, evaluated independently. Using the
// row's raw per-pair values (not just bestSpread) means a trade that's no
// longer "the best" for this token but is still itself elevated doesn't get
// silently dropped just because a different pair became bigger.
const PAIR_DEFS = [
  { pair: 'FRONT_PERP', metric: 'div', label: 'Front ↔ Perp',
    getSpread: r => r.divergence,
    actionFor: spread => spread >= 0 ? 'SHORT FRONT / LONG PERP' : 'LONG FRONT / SHORT PERP' },
  { pair: 'FRONT_BACK', metric: 'term', label: 'Front ↔ Back',
    getSpread: r => r.termSlope,
    actionFor: spread => spread >= 0 ? 'SHORT FRONT / LONG BACK' : 'LONG FRONT / SHORT BACK' },
  { pair: 'BACK_PERP', metric: 'bpApy', label: 'Back ↔ Perp',
    getSpread: r => r.backPerpSpread,
    actionFor: spread => spread >= 0 ? 'SHORT BACK / LONG PERP' : 'LONG BACK / SHORT PERP' },
];

let telegramWarned = false;
async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    if (!telegramWarned) {
      console.warn('[cde-basis] CDE_BASIS_TELEGRAM_BOT_TOKEN / CDE_BASIS_TELEGRAM_CHAT_ID not set — alerts will be logged to console only.');
      telegramWarned = true;
    }
    console.log('[cde-basis] ALERT (not sent, no Telegram config):\n' + message);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[cde-basis] Telegram send failed: ${res.status} ${body}`);
    }
  } catch (e) {
    console.warn('[cde-basis] Telegram send exception:', e.message);
  }
}

// Hysteresis, not a single edge-trigger: entry fires once crossing ABOVE the
// entry threshold; nothing fires again until it drops all the way below the
// separate (lower) exit threshold, which then fires its own "normalized"
// alert. This is deliberately immune to noise flickering back and forth
// across one line, which is what caused duplicate entry alerts before —
// there's a dead zone between the two thresholds where nothing happens.
// Keyed by "ROOT:PAIR" so each of the 3 legs is tracked independently.
const alertState = new Map(); // key -> { armed: boolean }

function fmtApy(v) { return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }

async function lookupZScore(root, metricKey) {
  try {
    const dayStats = await statsFromLog(LOG_PATH, { windowDays: ALERT_ZSCORE_WINDOW_DAYS });
    const rec = dayStats.stats[root] && dayStats.stats[root][metricKey];
    if (rec && rec.z != null) return `${rec.z >= 0 ? '+' : ''}${rec.z.toFixed(2)}σ (n=${rec.n} polls, past ${ALERT_ZSCORE_WINDOW_DAYS}d)`;
    if (rec) return `not enough history yet (n=${rec.n} polls, past ${ALERT_ZSCORE_WINDOW_DAYS}d)`;
    return 'insufficient history';
  } catch (e) {
    return `unavailable (${e.message})`;
  }
}

async function checkAlerts(snap) {
  for (const r of snap.rows) {
    // Never alert on data we've already decided not to trust for ranking —
    // an EXPIRING/STALE/SUSPECT reading is exactly the kind of thing that
    // shouldn't be the basis of a text message telling someone to trade.
    // Skip entirely (don't touch existing armed state) rather than clearing
    // it, so one bad poll doesn't force a spurious re-entry alert later.
    if (isUnreliable(r)) continue;

    const isMajor = alertSettings.majors.includes(r.root);
    const entryThreshold = isMajor ? alertSettings.majorThreshold : alertSettings.altThreshold;
    const exitThreshold = alertSettings.clearThreshold;

    for (const def of PAIR_DEFS) {
      const spread = def.getSpread(r);
      if (spread == null) continue;
      const mag = Math.abs(spread);
      const key = `${r.root}:${def.pair}`;
      const state = alertState.get(key) || { armed: false };

      if (!state.armed && mag >= entryThreshold) {
        state.armed = true;
        alertState.set(key, state);
        const zTxt = await lookupZScore(r.root, def.metric);
        const message =
          `🚨 <b>CDE Basis Alert — ${r.root}</b> (${isMajor ? 'major' : 'alt'}, entry ${entryThreshold}%)\n\n` +
          `<b>APY:</b> ${fmtApy(spread)} (${def.label})\n` +
          `<b>Trade:</b> ${def.actionFor(spread)}\n` +
          `<b>Z-score:</b> ${zTxt}\n` +
          (r.flags.length ? `<b>Flags:</b> ${r.flags.join(', ')}\n` : '') +
          `\n<a href="http://localhost:${PORT}/chart?root=${encodeURIComponent(r.root)}">View chart</a>`;
        await sendTelegramAlert(message);
      } else if (state.armed && mag < exitThreshold) {
        state.armed = false;
        alertState.set(key, state);
        const zTxt = await lookupZScore(r.root, def.metric);
        const message =
          `✅ <b>CDE Basis Alert CLEARED — ${r.root}</b>\n\n` +
          `${def.label} has normalized: ${fmtApy(spread)}, below the ${exitThreshold}% exit threshold.\n` +
          `<b>Original trade:</b> ${def.actionFor(spread)}\n` +
          `<b>Z-score:</b> ${zTxt}\n\n` +
          `Consider closing this position.\n` +
          `<a href="http://localhost:${PORT}/chart?root=${encodeURIComponent(r.root)}">View chart</a>`;
        await sendTelegramAlert(message);
      }
      // else: dead zone (armed and still above exit) or (unarmed and still
      // below entry) — deliberately silent either way.
    }
  }
}

let latest = null;      // last good snapshot
let latestStats = null; // last computed stats rollup (cached; recomputed alongside each poll)
let lastError = null;
let lastStatsError = null;

function hasFlag(f) { return process.argv.includes(f); }
function argv(f, def) {
  const i = process.argv.indexOf(f);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

// ---------- stale-price detection ----------
// CDE has a weekly maintenance halt (historically Fri 5-6pm ET, currently
// shrinking to 50min and being phased out per-product through Sept 2026 —
// the exact schedule is actively changing, so we deliberately do NOT
// hardcode a clock-time window here; that would go stale itself. Instead:
// if a leg's mid price is IDENTICAL across STALE_POLL_THRESHOLD consecutive
// polls, treat it as frozen (halted, or any other API staleness) and flag
// it — this self-detects whenever a halt actually happens, of whatever
// length, and self-clears the moment prices start moving again.
const STALE_POLL_THRESHOLD = (() => {
  const v = process.env.CDE_BASIS_STALE_POLLS || argv('--stale-polls', '6');
  const n = parseInt(v, 10);
  return (!isNaN(n) && n > 1) ? n : 6;
})();
const lastMid = {}; // root -> { front: {val,count}, perp: {val,count} }

function checkStaleLeg(root, leg, val) {
  if (val == null) return false;
  if (!lastMid[root]) lastMid[root] = {};
  const prev = lastMid[root][leg];
  if (prev && prev.val === val) {
    prev.count++;
  } else {
    lastMid[root][leg] = { val, count: 1 };
  }
  return lastMid[root][leg].count >= STALE_POLL_THRESHOLD;
}
// Mutates each row's flags in place. Separated from runCheck so it can be
// exercised directly in tests without needing the live network fetch.
function applyStaleFlags(rows) {
  for (const r of rows) {
    const frontStale = r.dated ? checkStaleLeg(r.root, 'front', r.dated.F) : false;
    const perpStale = r.perp ? checkStaleLeg(r.root, 'perp', r.perp.P) : false;
    if (frontStale && perpStale) r.flags.push('STALE');
    else if (frontStale) r.flags.push('STALE_FRONT');
    else if (perpStale) r.flags.push('STALE_PERP');
  }
}

async function fetchJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function runCheck() {
  const t0 = Date.now();
  try {
    const [fut, spot] = await Promise.all([fetchJSON(FUT_URL), fetchJSON(SPOT_URL)]);
    const snap = buildSnapshot(fut.products, spot.products, { horizonDays: HORIZON_DAYS });
    snap.pollMs = Date.now() - t0;
    applyStaleFlags(snap.rows);
    latest = snap;
    lastError = null;
    logPoll(snap);
    try {
      await checkAlerts(snap);
    } catch (e) {
      console.warn('[cde-basis] checkAlerts failed:', e.message);
    }
    if (DRYRUN) {
      const n = snap.rows.length;
      const ranked = snap.rows.filter(r => r.divergence != null)
        .sort((a, b) => Math.abs(b.divergence) - Math.abs(a.divergence));
      console.log(`[${snap.generatedAt}] rows=${n} poll=${snap.pollMs}ms | top divergence:`);
      for (const r of ranked.slice(0, 5)) {
        console.log(`  ${r.root.padEnd(6)} div=${r.divergence.toFixed(2)}%  ${r.verdict}`);
      }
    }
  } catch (e) {
    lastError = e.message;
    console.warn(`[${new Date().toISOString()}] poll failed: ${e.message}`);
  }

  // Stats recompute is independent of the poll outcome (it reads the log, not
  // the live API) and is guarded separately so a stats bug never takes down
  // the core poll loop.
  try {
    latestStats = await statsFromLog(LOG_PATH, { windowDays: STATS_WINDOW_DAYS });
    lastStatsError = null;
  } catch (e) {
    lastStatsError = e.message;
    console.warn(`[${new Date().toISOString()}] stats recompute failed: ${e.message}`);
  }
}

// ---------- dashboard ----------
// Default order (from buildSnapshot) ranks by raw basis APY, which is not the
// same as "biggest current opportunity" — a token can have modest basis APY
// but still be the most stretched vs. ITS OWN normal range. These two extra
// modes sort by magnitude only, since (per the user) direction doesn't matter
// for deciding what to put on — you can always take either side of the spread.
function sortRows(rows, sortMode) {
  // EXPIRING tokens (front-month within ~24h of expiry) can show an
  // artificially enormous basis APY purely from dividing by a near-zero time
  // window — mathematically real as an extrapolation, not a genuine trading
  // opportunity. Every sort mode below that ranks by a basis-derived
  // magnitude pushes these to the bottom regardless of their raw size, so
  // they can't crowd out real signals until the contract actually rolls.
  // fundapy is exempt: it ranks by perp funding alone, which doesn't depend
  // on the futures leg's time-to-expiry at all.
  const isExp = isUnreliable;
  if (sortMode === 'absdiv') {
    return rows.slice().sort((a, b) => {
      const aExp = isExp(a), bExp = isExp(b);
      if (aExp !== bExp) return aExp ? 1 : -1;
      const av = a.divergence == null ? -1 : Math.abs(a.divergence);
      const bv = b.divergence == null ? -1 : Math.abs(b.divergence);
      return bv - av;
    });
  }
  if (sortMode === 'absz') {
    return rows.slice().sort((a, b) => {
      const aExp = isExp(a), bExp = isExp(b);
      if (aExp !== bExp) return aExp ? 1 : -1;
      const az = latestStats && latestStats.stats[a.root] ? latestStats.stats[a.root].div.z : null;
      const bz = latestStats && latestStats.stats[b.root] ? latestStats.stats[b.root].div.z : null;
      const av = az == null ? -1 : Math.abs(az);
      const bv = bz == null ? -1 : Math.abs(bz);
      return bv - av;
    });
  }
  if (sortMode === 'fundapy') {
    // Ranks by funding APY magnitude alone — this is the only sort mode that
    // works for perp-only tokens (AAVE, ENA, NEAR, ONDO, PAXG, PEPE, ZEC, and
    // the synthetic indices), since it doesn't depend on a dated leg existing.
    return rows.slice().sort((a, b) => {
      const av = a.perp && a.perp.fundAPY != null ? Math.abs(a.perp.fundAPY) : -1;
      const bv = b.perp && b.perp.fundAPY != null ? Math.abs(b.perp.fundAPY) : -1;
      return bv - av;
    });
  }
  if (sortMode === 'bestspread') {
    // The headline "find the best trade" ranking: for each token, the largest
    // of its (up to) 3 pairwise spreads (front-perp, front-back, back-perp),
    // regardless of which pair that happens to be.
    return rows.slice().sort((a, b) => {
      const aExp = isExp(a), bExp = isExp(b);
      if (aExp !== bExp) return aExp ? 1 : -1;
      const av = a.bestSpread ? Math.abs(a.bestSpread.spread) : -1;
      const bv = b.bestSpread ? Math.abs(b.bestSpread.spread) : -1;
      return bv - av;
    });
  }
  return rows; // 'basis' (default): leave buildSnapshot's own ordering
}

function pct(v, d = 2) { return v == null ? '—' : `${(+v).toFixed(d)}%`; }
// Adaptive precision: a flat 1-decimal format is fine for BTC ($77,727.5) but
// makes sub-dollar tokens unreadable — SHIB in particular rounds to "0" at 1
// decimal even though its actual price is meaningfully nonzero. Scale digits
// to the price's own magnitude instead of a fixed count.
function num1(v) {
  if (v == null) return '—';
  const n = +v;
  const abs = Math.abs(n);
  let digits;
  if (abs === 0) digits = 2;
  else if (abs >= 100) digits = 1;
  else if (abs >= 1) digits = 3;
  else if (abs >= 0.01) digits = 5;
  else digits = 8; // sub-cent tokens (SHIB, PEPE, etc.)
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function zTxt(z) { return z == null ? '—' : (z >= 0 ? '+' : '') + z.toFixed(2) + 'σ'; }
function zClass(z) {
  if (z == null) return '';
  const a = Math.abs(z);
  const sign = z >= 0 ? 'pos' : 'neg';
  return a >= 2 ? `zhi ${sign}` : (a >= 1 ? `zmid ${sign}` : sign);
}

function actionLabel(verdict) {
  if (verdict === 'FUTURE cheaper') return { text: 'Long FUTURE / Short PERP', cls: 'fut' };
  if (verdict === 'PERP cheaper') return { text: 'Long PERP / Short FUTURE', cls: 'perp' };
  if (verdict === 'FUTURE only') return { text: 'Future only (no perp)', cls: '' };
  if (verdict === 'PERP only') return { text: 'Perp only (no dated)', cls: '' };
  return { text: '—', cls: '' };
}

function pairShort(pair) {
  return pair === 'FRONT_PERP' ? 'F↔P' : (pair === 'FRONT_BACK' ? 'F↔B' : 'B↔P');
}

// ---------- shared nav across all pages ----------
// Four scanning views (each a different slice of the same underlying data,
// no separate math) plus the positions tracker, which is deliberately kept
// out of this nav since it's a different job (tracking open trades, not
// finding new ones) — reached via its own badge on Overview instead.
const NAV_ITEMS = [
  ['/', 'Overview (best of all 3)'],
  ['/front-perp', 'Front vs Perp'],
  ['/front-back', 'Front vs Back'],
  ['/term-structure', 'Term Structure (all 3)'],
  ['/bidask', 'Bid/Ask (executable)'],
  ['/my-positions', 'My Positions (APY)'],
  ['/volume', 'Volume'],
  ['/calibration', 'Calibration'],
];
function navHTML(activePath) {
  const links = NAV_ITEMS.map(([href, label]) =>
    `<a href="${href}" class="${href === activePath ? 'active' : ''}">${label}</a>`).join(' · ');
  return `<div class="pagenav">${links}</div>`;
}
const SHARED_STYLE = `
  body{background:#0b0e11;color:#c9d1d9;font:13px/1.4 -apple-system,Segoe UI,Roboto,monospace;margin:0;padding:12px}
  h1{font-size:15px;margin:0 0 4px} h2{font-size:13px;margin:0 0 6px;color:#e5e7eb}
  a{color:#60a5fa}
  .meta{color:#6b7280;font-size:11px;margin-bottom:8px}
  .err{color:#f87171;margin-bottom:6px}
  .pagenav{font-size:12px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1f2937}
  .pagenav a{color:#9ca3af;text-decoration:none;margin-right:4px;padding:3px 8px;border-radius:4px}
  .pagenav a.active{color:#0b0e11;background:#60a5fa;font-weight:600}
  .pagenav a:hover:not(.active){color:#60a5fa}
  .sortnav{font-size:11px;color:#9ca3af;margin-bottom:10px}
  .sortnav a{color:#9ca3af;text-decoration:none;margin:0 2px;padding:2px 6px;border-radius:4px}
  .sortnav a.active{color:#0b0e11;background:#60a5fa;font-weight:600}
  .sortnav a:hover:not(.active){color:#60a5fa}
  table{border-collapse:collapse;width:100%;margin-bottom:16px}
  th,td{border:1px solid #1f2937;padding:4px 7px;text-align:right;white-space:nowrap}
  th{background:#111827;color:#9ca3af;position:sticky;top:0;font-weight:600}
  td.root{text-align:left;font-weight:600;color:#e5e7eb}
  td.root a{color:#e5e7eb;text-decoration:none;border-bottom:1px dotted #4b5563}
  .hideform{display:inline-block;margin-left:6px}
  .hidebtn{background:transparent;color:#4b5563;border:none;cursor:pointer;font:inherit;font-size:11px;padding:0 2px;line-height:1}
  .hidebtn:hover{color:#f87171}
  td.root a:hover{color:#60a5fa;border-bottom-color:#60a5fa}
  .pos{color:#34d399}.neg{color:#f87171}.perp{color:#60a5fa}.fut{color:#fbbf24}.flip{color:#c084fc;font-weight:700}
  .fl{font-size:9px;color:#f59e0b;margin-left:4px}
  .fl.expiring{color:#0b0e11;background:#f87171;font-weight:700;padding:1px 4px;border-radius:3px}
  .fl.stale{color:#0b0e11;background:#9ca3af;font-weight:700;padding:1px 4px;border-radius:3px}
  .zhi{font-weight:700}
  tr:nth-child(even){background:#0f141a}
  form{margin:0} .pinbtn{background:#111827;color:#9ca3af;border:1px solid #1f2937;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit;font-size:11px}
  .pinbtn:hover{border-color:#60a5fa;color:#60a5fa} .pinbtn.pinned{color:#fbbf24;border-color:#fbbf24}
  .bspair{font-size:9px;color:#6b7280;border:1px solid #374151;border-radius:3px;padding:0 3px;margin-left:3px}
  .bsaction{font-size:10px;color:#9ca3af;font-weight:400}
  .posbadge{margin-bottom:10px}
  .posbadge a{display:inline-block;background:#111827;border:1px solid #1f2937;border-radius:6px;padding:6px 12px;color:#e5e7eb;text-decoration:none;font-size:12px}
  .posbadge a:hover{border-color:#60a5fa;color:#60a5fa}
  .empty{color:#6b7280;font-size:12px;padding:16px;background:#111827;border:1px solid #1f2937;border-radius:8px}
  .pospanel{background:#111827;border:1px solid #1f2937;border-radius:8px;padding:10px 12px;margin-bottom:16px}
  .postable{margin-bottom:0}
  .shape{font-size:11px;color:#9ca3af}
`;

function trackButtonHTML(root, positions) {
  const pinned = !!(positions && positions[root]);
  return `<form method="POST" action="${pinned ? '/positions/unpin' : '/positions/pin'}">
    <input type="hidden" name="root" value="${root}">
    <button type="submit" class="pinbtn${pinned ? ' pinned' : ''}">${pinned ? '★ tracked' : '☆ track'}</button>
  </form>`;
}
// Small inline "hide" control placed in the token cell itself (not its own
// column — the table already has enough columns) so hiding a token off the
// scanning pages is a one-click action right next to its name.
function hideButtonHTML(root) {
  return `<form method="POST" action="/hide" class="hideform" title="Hide ${root} from this page">
    <input type="hidden" name="root" value="${root}">
    <button type="submit" class="hidebtn">✕</button>
  </form>`;
}
// Renders flags with an actual countdown for EXPIRING (not just a static
// tag) so the imminent-expiry annualization artifact is verifiable at a
// glance, not something you have to trust. EXPIRING gets its own louder CSS
// class distinct from the routine NEAR_DATED/LOW_LIQ/NO_S tags.
function flagsHTML(r) {
  if (!r.flags.length) return '';
  return r.flags.map(f => {
    if (f === 'EXPIRING' && r.dated && r.dated.hoursToExpiry != null) {
      const h = r.dated.hoursToExpiry;
      const txt = h < 1 ? Math.round(h * 60) + 'm' : h.toFixed(1) + 'h';
      return `<span class="fl expiring" title="Front-month expires in ~${txt}. Annualized figures (Basis APY, Rich/Cheap %, Best Spread) are inflated by the near-zero time denominator right now — this is a math artifact, not a real opportunity. Excluded from magnitude-based rankings until it rolls.">EXPIRING ${txt}</span>`;
    }
    if (f === 'NEAR_DATED' && r.dated && r.dated.hoursToExpiry != null) {
      const d = (r.dated.hoursToExpiry / 24).toFixed(1);
      return `<span class="fl">NEAR_DATED ${d}d</span>`;
    }
    if (f === 'STALE' || f === 'STALE_FRONT' || f === 'STALE_PERP') {
      const which = f === 'STALE' ? 'both legs' : (f === 'STALE_FRONT' ? 'the front-month price' : 'the perp price');
      return `<span class="fl stale" title="${which} hasn't changed across the last ${STALE_POLL_THRESHOLD}+ polls — likely a CDE maintenance halt (weekly Friday window) or a feed outage, not a live price. Excluded from magnitude-based rankings until it starts moving again.">STALE</span>`;
    }
    if (f === 'SUSPECT') {
      return `<span class="fl expiring" title="One of this token's figures exceeds a sanity ceiling (${SANITY_CAP_PCT}%) — likely a broken/glitched data point (e.g. a bad tick during a fast market move) rather than a real reading. Excluded from magnitude-based rankings and from the logged history/z-score for this poll.">SUSPECT</span>`;
    }
    return `<span class="fl">${f}</span>`;
  }).join(' ');
}
// Used by every ranking sort to keep questionable data (near-zero-Tms
// annualization artifacts, frozen prices during a maintenance halt, or
// sanity-cap violations) from topping the list purely due to the artifact
// rather than a real signal.
function isUnreliable(r) {
  return r.flags && r.flags.some(f => f === 'EXPIRING' || f === 'STALE' || f === 'STALE_FRONT' || f === 'STALE_PERP' || f === 'SUSPECT');
}
function zFor(root) {
  const zRec = latestStats && latestStats.stats[root] ? latestStats.stats[root].div : null;
  const z = zRec ? zRec.z : null;
  const title = zRec ? `n=${zRec.n} mean=${zRec.mean == null ? '—' : zRec.mean.toFixed(2)} std=${zRec.std == null ? '—' : zRec.std.toFixed(2)}` : 'no history yet';
  return { z, title };
}

function rowHTML(r, positions) {
  const flags = flagsHTML(r);
  const d = r.dated, p = r.perp, b = r.back;
  const divCls = r.divergence == null ? '' : (r.divergence > 0 ? 'pos' : 'neg');
  const action = actionLabel(r.verdict);
  const bs = r.bestSpread;
  const bsCls = bs == null ? '' : (bs.spread >= 0 ? 'pos' : 'neg');
  const bsCell = bs == null
    ? '—'
    : `${pct(bs.spread)} <span class="bspair">${pairShort(bs.pair)}</span><br><span class="bsaction">${bs.action}</span>`;
  const { z, title: zTitle } = zFor(r.root);
  return `<tr>
    <td class="root"><a href="/chart?root=${encodeURIComponent(r.root)}" title="full detail: spot/index, gap%, all-in%">${r.root}</a> ${flags}${hideButtonHTML(r.root)}</td>
    <td>${p ? num1(p.P) : '—'}</td>
    <td>${d ? num1(d.F) : '—'}</td>
    <td>${b ? num1(b.F) : '—'}</td>
    <td class="${d && d.basisAPY < 0 ? 'neg' : 'pos'}">${d ? pct(d.basisAPY) : '—'}</td>
    <td class="${r.termSlope == null ? '' : (r.termSlope > 0 ? 'pos' : 'neg')}" title="${r.hasBack ? 'front basis APY minus back basis APY' : 'no back-month contract for this token'}">${r.termSlope == null ? '—' : pct(r.termSlope)}</td>
    <td>${p ? (p.fundingRate * 1e6).toFixed(1) + 'µ' : '—'}</td>
    <td class="${p && p.fundAPY < 0 ? 'neg' : 'pos'}">${p ? pct(p.fundAPY) : '—'}</td>
    <td class="${divCls}">${r.divergence == null ? '—' : pct(r.divergence, 2)}</td>
    <td class="${zClass(z)}" title="${zTitle}">${zTxt(z)}</td>
    <td class="${bsCls}" title="Best of the 3 pairwise spreads (front-perp, front-back, back-perp) for this token">${bsCell}</td>
    <td class="${action.cls}" title="Front-vs-perp specific (may differ from Best Spread's pair)">${action.text}</td>
    <td>${trackButtonHTML(r.root, positions)}</td>
  </tr>`;
}

// ---------- Front vs Perp page: only tokens with BOTH legs ----------
function frontPerpRowHTML(r, positions) {
  const d = r.dated, p = r.perp;
  const divCls = r.divergence == null ? '' : (r.divergence > 0 ? 'pos' : 'neg');
  const action = actionLabel(r.verdict);
  const { z, title: zTitle } = zFor(r.root);
  const flags = flagsHTML(r);
  return `<tr>
    <td class="root"><a href="/chart?root=${encodeURIComponent(r.root)}">${r.root}</a> ${flags}${hideButtonHTML(r.root)}</td>
    <td>${num1(p.P)}</td><td>${num1(d.F)}</td>
    <td class="${d.basisAPY < 0 ? 'neg' : 'pos'}">${pct(d.basisAPY)}</td>
    <td class="${p.fundAPY < 0 ? 'neg' : 'pos'}">${pct(p.fundAPY)}</td>
    <td class="${divCls}">${r.divergence == null ? '—' : pct(r.divergence, 2)}</td>
    <td class="${zClass(z)}" title="${zTitle}">${zTxt(z)}</td>
    <td class="${action.cls}">${action.text}</td>
    <td>${trackButtonHTML(r.root, positions)}</td>
  </tr>`;
}
function frontPerpPageHTML(snap, positions, hidden) {
  const rows = snap.rows.filter(r => r.hasDated && r.hasPerp && !hidden[r.root])
    .sort((a, b) => {
      const aExp = isUnreliable(a), bExp = isUnreliable(b);
      if (aExp !== bExp) return aExp ? 1 : -1;
      return (b.divergence == null ? -1 : Math.abs(b.divergence)) - (a.divergence == null ? -1 : Math.abs(a.divergence));
    });
  const excluded = snap.rows.length - rows.length;
  const body = rows.length
    ? rows.map(r => frontPerpRowHTML(r, positions)).join('\n')
    : '<tr><td colspan="9" class="empty">No tokens currently have both a dated front-month AND a perp.</td></tr>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Front vs Perp — CDE Basis</title>
<style>${SHARED_STYLE}</style></head><body>
${navHTML('/front-perp')}
${hiddenBadgeHTML(hidden)}
<h1>Front vs Perp</h1>
<div class="meta">generated ${snap.generatedAt} · ${rows.length} tokens shown (${excluded} excluded — no dated future, or perp-only) · sorted by biggest |Rich/Cheap %| · Rich/Cheap % = front basis APY minus perp funding APY; positive = short future / long perp</div>
<table>
<thead><tr><th>Token</th><th>Perp</th><th>Front</th><th>Basis APY</th><th>Funding APY</th><th>Rich/Cheap %</th><th>Z-score</th><th>Action</th><th>Track</th></tr></thead>
<tbody>${body}</tbody>
</table>
<script>setTimeout(()=>location.reload(),5000);</script>
</body></html>`;
}

// ---------- Front vs Back page: only tokens with a back-month contract ----------
function frontBackRowHTML(r, positions) {
  const d = r.dated, b = r.back;
  const termCls = r.termSlope == null ? '' : (r.termSlope > 0 ? 'pos' : 'neg');
  const action = r.termSlope == null ? { text: '—', cls: '' } :
    (r.termSlope >= 0 ? { text: 'Short FRONT / Long BACK', cls: 'fut' } : { text: 'Long FRONT / Short BACK', cls: 'perp' });
  const flags = flagsHTML(r);
  return `<tr>
    <td class="root"><a href="/chart?root=${encodeURIComponent(r.root)}">${r.root}</a> ${flags}${hideButtonHTML(r.root)}</td>
    <td>${num1(d.F)}</td><td>${num1(b.F)}</td>
    <td class="${d.basisAPY < 0 ? 'neg' : 'pos'}">${pct(d.basisAPY)}</td>
    <td class="${b.basisAPY < 0 ? 'neg' : 'pos'}">${pct(b.basisAPY)}</td>
    <td class="${termCls}">${r.termSlope == null ? '—' : pct(r.termSlope)}</td>
    <td class="${action.cls}">${action.text}</td>
    <td>${trackButtonHTML(r.root, positions)}</td>
  </tr>`;
}
function frontBackPageHTML(snap, positions, hidden) {
  const rows = snap.rows.filter(r => r.hasBack && !hidden[r.root])
    .sort((a, b) => {
      const aExp = isUnreliable(a), bExp = isUnreliable(b);
      if (aExp !== bExp) return aExp ? 1 : -1;
      return (b.termSlope == null ? -1 : Math.abs(b.termSlope)) - (a.termSlope == null ? -1 : Math.abs(a.termSlope));
    });
  const body = rows.length
    ? rows.map(r => frontBackRowHTML(r, positions)).join('\n')
    : '<tr><td colspan="8" class="empty">No tokens currently have two simultaneous dated tenors listed.</td></tr>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Front vs Back — CDE Basis</title>
<style>${SHARED_STYLE}</style></head><body>
${navHTML('/front-back')}
${hiddenBadgeHTML(hidden)}
<h1>Front vs Back (calendar spread)</h1>
<div class="meta">generated ${snap.generatedAt} · ${rows.length} tokens have a listed back-month contract · sorted by biggest |Term (F−B)| · Term = front basis APY minus back basis APY; positive = front is rich vs. back</div>
<table>
<thead><tr><th>Token</th><th>Front</th><th>Back</th><th>Front Basis APY</th><th>Back Basis APY</th><th>Term (F−B)</th><th>Action</th><th>Track</th></tr></thead>
<tbody>${body}</tbody>
</table>
<script>setTimeout(()=>location.reload(),5000);</script>
</body></html>`;
}

// ---------- Term Structure page: all 3 points (perp, front, back) together ----------
// This is where the "extremes pairing = biggest spread" shortcut is most
// directly useful: Rising/Falling means front is the MIDDLE value, so
// back<->perp is mathematically guaranteed to be the widest spread — no need
// to check all 3 pairs by hand, the shape tells you directly.
function curveShape(P, F, B) {
  if (P == null || F == null || B == null) return { label: 'N/A (no back month)', cls: '' };
  if (P <= F && F <= B) return { label: 'Rising: Perp < Front < Back — Back↔Perp is guaranteed the widest spread', cls: 'pos' };
  if (P >= F && F >= B) return { label: 'Falling: Perp > Front > Back — Back↔Perp is guaranteed the widest spread', cls: 'neg' };
  if (F < P && F < B) return { label: 'Dip at Front (front is the low point)', cls: '' };
  if (F > P && F > B) return { label: 'Hump at Front (front is the high point)', cls: '' };
  return { label: 'Flat / mixed', cls: '' };
}
function termStructureRowHTML(r, positions) {
  const p = r.perp, d = r.dated, b = r.back;
  const shape = curveShape(p ? p.fundAPY : null, d ? d.basisAPY : null, b ? b.basisAPY : null);
  const bs = r.bestSpread;
  const bsCls = bs == null ? '' : (bs.spread >= 0 ? 'pos' : 'neg');
  const bsCell = bs == null ? '—' : `${pct(bs.spread)} <span class="bspair">${pairShort(bs.pair)}</span><br><span class="bsaction">${bs.action}</span>`;
  const flags = flagsHTML(r);
  return `<tr>
    <td class="root"><a href="/chart?root=${encodeURIComponent(r.root)}">${r.root}</a> ${flags}${hideButtonHTML(r.root)}</td>
    <td class="${p && p.fundAPY < 0 ? 'neg' : 'pos'}">${p ? pct(p.fundAPY) : '—'}</td>
    <td class="${d && d.basisAPY < 0 ? 'neg' : 'pos'}">${d ? pct(d.basisAPY) : '—'}</td>
    <td class="${b && b.basisAPY < 0 ? 'neg' : 'pos'}">${b ? pct(b.basisAPY) : '—'}</td>
    <td class="shape ${shape.cls}">${shape.label}</td>
    <td class="${bsCls}">${bsCell}</td>
    <td>${trackButtonHTML(r.root, positions)}</td>
  </tr>`;
}
function termStructurePageHTML(snap, positions, hidden) {
  const rows = snap.rows.filter(r => r.hasPerp && r.hasDated && !hidden[r.root])
    .sort((a, b) => {
      const aExp = isUnreliable(a), bExp = isUnreliable(b);
      if (aExp !== bExp) return aExp ? 1 : -1;
      return (b.bestSpread ? Math.abs(b.bestSpread.spread) : -1) - (a.bestSpread ? Math.abs(a.bestSpread.spread) : -1);
    });
  const body = rows.length
    ? rows.map(r => termStructureRowHTML(r, positions)).join('\n')
    : '<tr><td colspan="7" class="empty">No tokens currently have both a perp and a front-month dated future.</td></tr>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Term Structure — CDE Basis</title>
<style>${SHARED_STYLE}</style></head><body>
${navHTML('/term-structure')}
${hiddenBadgeHTML(hidden)}
<h1>Term Structure — Perp → Front → Back</h1>
<div class="meta">generated ${snap.generatedAt} · ${rows.length} tokens shown · sorted by |Best Spread| · Rising/Falling shapes mean the back↔perp spread is mathematically guaranteed to be the biggest of the 3 — Dip/Hump means front itself is the extreme, so check Best Spread's pair tag instead</div>
<table>
<thead><tr><th>Token</th><th>Perp Funding APY</th><th>Front Basis APY</th><th>Back Basis APY</th><th>Curve Shape</th><th>Best Spread</th><th>Track</th></tr></thead>
<tbody>${body}</tbody>
</table>
<script>setTimeout(()=>location.reload(),5000);</script>
</body></html>`;
}

// ---------- My Positions: manually-entered positions ranked by the APY you're earning ----------
// Uses the same mid-price APYs as the Overview / Front-vs-Perp tabs (perp = funding APY,
// future = basis APY, spread = difference). Positions are saved to disk
// (data/cde_basis_my_positions.json) and pinned to the specific contracts you
// entered, so they survive restarts and contract expiries.
const MY_POSITIONS_PATH = path.join(path.dirname(LOG_PATH), 'cde_basis_my_positions.json');

function fmtUsdSigned(v) { return v == null ? '—' : `${v < 0 ? '−' : '+'}${fmtDollar(Math.abs(v))}`; }

function myPositionsPageHTML(snap, errMsg) {
  const esc = myPos.esc;
  const positions = myPos.loadMyPositions(MY_POSITIONS_PATH);
  const evals = myPos.rankEvaluated(myPos.evaluateAll(positions, snap.rows));
  const sum = myPos.summarize(evals);
  const options = {};
  for (const r of snap.rows) { const a = myPos.availableInstruments(r); if (a.length) options[r.root] = a; }
  const roots = Object.keys(options).sort();
  const optsJson = JSON.stringify(options).replace(/</g, '\\u003c');

  const rowHTML = (e) => {
    const bad = e.status !== 'OK' || e.unreliable;
    const statusTag = e.status === 'EXPIRED' ? ' <span class="neg">EXPIRED</span>'
      : e.status !== 'OK' ? ` <span class="neg">no APY</span>`
      : e.unreliable ? ' <span class="neg">(unreliable)</span>' : '';
    const yourCls = e.yourApy == null ? '' : (e.yourApy >= 0 ? 'pos' : 'neg');
    return `<tr data-bad="${bad ? 1 : 0}" data-token="${esc(e.root)}" data-mkt="${e.marketApy == null ? '' : e.marketApy}" data-your="${e.yourApy == null ? '' : e.yourApy}" data-notional="${e.notionalUsd == null ? '' : e.notionalUsd}" data-est="${e.estUsdYr == null ? '' : e.estUsdYr}"${bad ? ' style="opacity:.55"' : ''}>
    <td class="root"><a href="/chart?root=${encodeURIComponent(e.root)}">${esc(e.root)}</a></td>
    <td style="text-align:left" title="${esc(e.detail || e.reason || '')}">${esc(e.label)}${statusTag}${e.nowAs ? `<div class="meta" style="margin:0">now: ${esc(e.nowAs)}</div>` : ''}${e.reason ? `<div class="meta" style="margin:0">${esc(e.reason)}</div>` : ''}</td>
    <td class="${e.side === 'LONG' ? 'perp' : 'fut'}">${e.side === 'LONG' ? 'Long' : 'Short'}</td>
    <td>${e.notionalUsd == null ? '—' : fmtDollar(e.notionalUsd)}</td>
    <td>${e.marketApy == null ? '—' : sgnPct(e.marketApy)}</td>
    <td class="${yourCls}"><b>${e.yourApy == null ? '—' : sgnPct(e.yourApy)}</b></td>
    <td class="${e.estUsdYr == null ? '' : (e.estUsdYr >= 0 ? 'pos' : 'neg')}">${fmtUsdSigned(e.estUsdYr)}</td>
    <td style="text-align:left;color:#9ca3af">${esc(e.note)}</td>
    <td style="text-align:left;white-space:nowrap">
      <button type="button" class="editbtn" data-id="${esc(e.id)}" data-label="${esc(e.label)}" data-side="${esc(e.side)}" data-notional="${e.notionalUsd == null ? '' : e.notionalUsd}" data-note="${esc(e.note)}">edit</button>
      <form method="POST" action="/my-positions/delete" class="hideform" onsubmit="return confirm('Delete this position?')"><input type="hidden" name="id" value="${esc(e.id)}"><button class="hidebtn" title="Delete position">✕</button></form>
    </td>
  </tr>`;
  };
  const body = evals.length ? evals.map(rowHTML).join('\n')
    : '<tr><td colspan="9" class="empty">No positions yet — add one above.</td></tr>';
  const sumLine = evals.length
    ? `${sum.count} position${sum.count === 1 ? '' : 's'}` +
      (sum.weightedCount ? ` · notional-weighted Your APY <b class="${sum.weightedYourApy >= 0 ? 'pos' : 'neg'}">${sgnPct(sum.weightedYourApy)}</b> across ${sum.weightedCount} with a notional (${fmtDollar(sum.totalNotional)}) · est. <b class="${sum.totalEstUsdYr >= 0 ? 'pos' : 'neg'}">${fmtUsdSigned(sum.totalEstUsdYr)}</b>/yr` : ' · add notionals to see a weighted average and $/yr') +
      (sum.unscored ? ` · ${sum.unscored} not scored (expired, no data, or unreliable — excluded from the average)` : '')
    : '';
  const rootOpts = roots.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>My Positions — CDE Basis</title>
<style>${SHARED_STYLE}
  form#pform{background:#111827;border:1px solid #1f2937;border-radius:8px;padding:10px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  form#pform select, form#pform input[type=text]{background:#0b0e11;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:4px 6px;font:inherit}
  form#pform button, button.editbtn{background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:4px 10px;font:inherit;cursor:pointer}
  form#pform button.primary{background:#60a5fa;color:#0b0e11;border-color:#60a5fa;font-weight:600}
  button.editbtn{padding:1px 6px;font-size:11px;color:#9ca3af}
  button.editbtn:hover{color:#60a5fa}
  th.srt{cursor:pointer;text-decoration:underline dotted #6b7280;user-select:none}
  th.srt:hover{color:#60a5fa} th.srt.on{color:#0b0e11;background:#60a5fa}
</style></head><body>
${navHTML('/my-positions')}
<h1>My Positions — ranked by the APY you're earning</h1>
${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}
<form method="POST" action="/my-positions/save" id="pform">
  <input type="hidden" name="id" id="f_id" value="">
  <span id="pickers" style="display:contents">
    <select name="root" id="f_root" required><option value="" disabled selected>— token —</option>${rootOpts}</select>
    <select name="instrument" id="f_inst" required style="min-width:300px"><option value="" disabled selected>— instrument —</option></select>
  </span>
  <b id="editing" hidden></b>
  <select name="side" id="f_side" required><option value="" disabled selected>— side —</option><option value="LONG">Long</option><option value="SHORT">Short</option></select>
  <input type="text" name="notional" id="f_notional" placeholder="notional $ per leg (optional, e.g. 250k)" size="30" autocomplete="off">
  <input type="text" name="note" id="f_note" placeholder="note (optional)" size="26" maxlength="120" autocomplete="off">
  <button class="primary" id="f_submit">Add position</button>
  <button type="button" id="f_cancel" hidden>Cancel edit</button>
</form>
<div class="meta">${sumLine}</div>
<div class="sortnav"><b>Sorted by: <span id="sortlabel">…</span></b> <span style="color:#6b7280">(click an underlined header to change; best = highest Your APY)</span></div>
<table id="t">
<thead><tr><th class="srt" data-sort="token" style="text-align:left">Token</th><th style="text-align:left">Position</th><th>Side</th><th class="srt" data-sort="notional">Notional</th><th class="srt" data-sort="mkt">Market APY (mid)</th><th class="srt" data-sort="your">Your APY</th><th class="srt" data-sort="est">Est. $/yr</th><th style="text-align:left">Note</th><th></th></tr></thead>
<tbody>${body}</tbody>
</table>
<div class="meta"><b>Market APY (mid)</b> is the same mid-price number the Overview and Front-vs-Perp tabs show: for a Perp it's the funding APY, for a future (1 = front, 2 = back) it's the basis APY vs the index, and for a spread it's first leg − second leg (1–Perp = front basis − perp funding, 2–Perp = back basis − perp funding, 1–2 = front basis − back basis; positive = the first leg is rich). <b>Your APY</b> is what you're actually earning: you <b>receive</b> when you're <b>short and the APY is positive</b>, or <b>long and it's negative</b>, so Your APY = Market APY if short, −Market APY if long. Positive/green = you're being paid; negative/red = you're paying. A <b>Long spread</b> is long the first leg and short the second. <b>Notional</b> is per leg; Est. $/yr = notional × Your APY. Rates move: funding changes each interval, and the basis APY will drift as expiry approaches. Positions are pinned to the exact contracts you picked — when a month expires the position shows EXPIRED rather than switching to the next month, and a position on Nov simply becomes the "1" once Oct is gone. Rows with under 24h to expiry, no data or an expired contract are dimmed and sorted last.</div>
<script>
(function(){
  var OPTS = ${optsJson};
  function sget(k){ try { return localStorage.getItem(k); } catch(e) { return null; } }
  function sset(k,v){ try { localStorage.setItem(k,v); } catch(e) {} }
  var $ = function(id){ return document.getElementById(id); };
  var root=$('f_root'), inst=$('f_inst'), form=$('pform'), dirty=false;
  function fillInst(){
    inst.innerHTML = '<option value="" disabled selected>— instrument —</option>';
    (OPTS[root.value] || []).forEach(function(o){ var e=document.createElement('option'); e.value=o.key; e.textContent=o.name; inst.appendChild(e); });
  }
  root.addEventListener('change', fillInst);
  form.addEventListener('input', function(){ dirty = true; });
  document.querySelectorAll('button.editbtn').forEach(function(b){
    b.addEventListener('click', function(){
      $('f_id').value = b.dataset.id;
      $('pickers').style.display = 'none'; root.required = false; inst.required = false;
      $('editing').hidden = false; $('editing').textContent = 'Editing: ' + b.dataset.label;
      $('f_side').value = b.dataset.side; $('f_notional').value = b.dataset.notional; $('f_note').value = b.dataset.note;
      $('f_submit').textContent = 'Save changes'; $('f_cancel').hidden = false; dirty = true;
      form.scrollIntoView({behavior:'smooth', block:'center'});
    });
  });
  $('f_cancel').addEventListener('click', function(){ location.href = '/my-positions'; });

  var NAMES = { your: 'Your APY', mkt: 'Market APY', notional: 'Notional', est: 'Est. $/yr', token: 'Token' };
  var sortKey = sget('cde_mypos_sort') || 'your', sortDir = sget('cde_mypos_dir') || 'desc';
  var tbody = document.querySelector('#t tbody');
  function applySort(){
    var trs = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-token]'));
    trs.sort(function(a, c){
      if (a.dataset.bad !== c.dataset.bad) return a.dataset.bad === '1' ? 1 : -1;
      if (sortKey === 'token') { var r = a.dataset.token.localeCompare(c.dataset.token); return sortDir === 'desc' ? -r : r; }
      var av = parseFloat(a.dataset[sortKey]), cv = parseFloat(c.dataset[sortKey]), an = isNaN(av), cn = isNaN(cv);
      if (an || cn) return (an && cn) ? 0 : (an ? 1 : -1);
      return sortDir === 'desc' ? cv - av : av - cv;
    });
    trs.forEach(function(tr){ tbody.appendChild(tr); });
    document.querySelectorAll('th.srt').forEach(function(th){
      var on = th.dataset.sort === sortKey;
      th.className = 'srt' + (on ? ' on' : '');
      th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (on ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '');
    });
    $('sortlabel').textContent = NAMES[sortKey] + (sortKey === 'token' ? (sortDir === 'desc' ? ' — Z to A' : ' — A to Z') : (sortDir === 'desc' ? ' — highest first' : ' — lowest first'));
  }
  document.querySelectorAll('th.srt').forEach(function(th){
    th.addEventListener('click', function(){
      if (sortKey === th.dataset.sort) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      else { sortKey = th.dataset.sort; sortDir = th.dataset.sort === 'token' ? 'asc' : 'desc'; }
      sset('cde_mypos_sort', sortKey); sset('cde_mypos_dir', sortDir); applySort();
    });
  });
  applySort();
  setInterval(function(){
    var a = document.activeElement;
    if (dirty || (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))) return;   // never reload under someone who's typing
    location.reload();
  }, 10000);
})();
</script>
</body></html>`;
}

// ---------- Bid/Ask: spread APYs at EXECUTABLE prices ----------
// Every other page prices legs at mid. This one pulls the live order book for
// each leg (the bulk products list has empty bid/ask fields) and shows what the
// spread annualizes to if you actually cross it: sell at the bid, buy at the
// ask. Books are fetched on demand when this page loads and cached ~8s, so
// nothing extra is polled while nobody is looking at it.
// Spreads move far less than outright prices, so books are refreshed
// leisurely: each is cached 30s and requests are paced 200ms apart (5/s), which
// keeps a full ~75-book sweep (~15s) comfortably under Coinbase's rate limit.
const BIDASK_PAGE_BUILD = 'columns-v8';
const BOOK_INTERVAL_MS = parseInt(process.env.CDE_BASIS_BOOK_INTERVAL_MS || '') || 200;
const BOOK_TTL_MS = parseInt(process.env.CDE_BASIS_BOOK_TTL_MS || '') || 30000;
const BOOK_PAGE_REFRESH_S = Math.max(5, Math.round(BOOK_TTL_MS / 1000));
// The page must never make a click feel dead: answer within ~0.7s with whatever
// books are ready (the rest fill in on the next quick refresh), instead of
// waiting for a whole sweep.
const BOOK_PAGE_MAX_WAIT_MS = 700;
const BOOK_LOADING_REFRESH_MS = 2000;
// Keep books warm in the background for a while after the tab was last viewed,
// so coming back to it is instant instead of a cold sweep. Stops by itself
// (no requests at all) once nobody has looked for BOOK_WARM_WINDOW_MS.
const BOOK_WARM_WINDOW_MS = 15 * 60 * 1000;
let lastBookInterest = 0;
function warmBooks() {
  if (!latest || Date.now() - lastBookInterest > BOOK_WARM_WINDOW_MS) return;
  bookFetcher.getBooks(bidask.productIdsNeeded(latest.rows, loadHidden()))
    .catch(e => console.warn('[cde-basis] book warm-up failed:', e.message));
}
const bookFetcher = bidask.createBookFetcher((u) => fetchJSON(u), { minIntervalMs: BOOK_INTERVAL_MS, ttlMs: BOOK_TTL_MS, maxStaleMs: BOOK_TTL_MS * 4 });

function sgnPct(v, d = 2) { return v == null ? '—' : `${v >= 0 ? '+' : ''}${(+v).toFixed(d)}%`; }
// Spread prices are small and in the underlying's own units (AVAX: 0.03), so
// show up to 5 significant digits and trim trailing zeros rather than using a
// fixed decimal count.
function fmtSpreadPx(v) { return v == null ? '—' : String(+(+v).toPrecision(5)); }
const SPREAD_LABEL = { FRONT_PERP: '1–Perp', BACK_PERP: '2–Perp', FRONT_BACK: '1–2' };

async function bidAskPageHTML(snap, hidden, pairFilter) {
  const ids = bidask.productIdsNeeded(snap.rows, hidden);
  // Don't make the page wait for a whole paced sweep: serve what's ready (plus
  // last-good quotes) after a few seconds; the rest keeps loading in the
  // background and the page re-checks quickly until everything is in.
  lastBookInterest = Date.now();
  const books = await bookFetcher.getBooks(ids, { maxWaitMs: BOOK_PAGE_MAX_WAIT_MS });
  const loadingLegs = ids.filter(id => books.get(id) && books.get(id).error === 'loading').length;
  // Failures that are worth retrying soon (timeouts, 429s, 5xx, network) vs.
  // ones that are just the market's state (404 not listed, empty/one-sided book).
  const transientFails = ids.filter(id => { const b = books.get(id); return b && b.error && b.error !== 'loading' && !/^HTTP 404|one-sided|empty book|crossed/.test(b.error); }).length;
  const recheckMs = loadingLegs ? BOOK_LOADING_REFRESH_MS : (transientFails ? 5000 : BOOK_PAGE_REFRESH_S * 1000);
  const built = bidask.buildBidAskRows(snap.rows, books, hidden);
  const validFilters = ['ALL', 'FRONT_PERP', 'BACK_PERP', 'FRONT_BACK'];
  const filt = validFilters.includes(pairFilter) ? pairFilter : 'ALL';
  const rows = built.rows.filter(r => filt === 'ALL' || r.pair === filt);
  const good = rows.filter(r => !r.error);
  const bad = rows.filter(r => r.error && r.error !== 'loading');
  // Default order mirrors what the in-browser script does after load: best
  // immediate trade (funding included) first, unreliable rows last.
  const bestOf = (r) => {
    const f = r.pairFundAPY || 0;
    return Math.max(r.bidLevel - f, -(r.askLevel - f));
  };
  good.sort((a, b) => (a.unreliable !== b.unreliable) ? (a.unreliable ? 1 : -1) : bestOf(b) - bestOf(a));
  const filterLinks = validFilters.map(f => {
    const label = f === 'ALL' ? 'All spreads' : { FRONT_PERP: '1–Perp (front vs perp)', BACK_PERP: '2–Perp (back vs perp)', FRONT_BACK: '1–2 (front vs back)' }[f];
    return `<a href="/bidask?pair=${f}" class="${f === filt ? 'active' : ''}">${label}</a>`;
  }).join(' ');
  const rowHTML = (r) => {
    const stale = r.maxBookAgeSec != null && r.maxBookAgeSec > 90;
    const key = `${r.idA}|${r.idB}`;
    const tag = `${r.root}${SPREAD_LABEL[r.pair]}`.replace('–', '-');
    const spreadsTitle = `${r.nameA} minus ${r.nameB}; leg spreads ${r.spreadBpsA != null ? r.spreadBpsA.toFixed(1) : '?'} / ${r.spreadBpsB != null ? r.spreadBpsB.toFixed(1) : '?'} bps; book age ${r.maxBookAgeSec != null ? Math.max(0, r.maxBookAgeSec).toFixed(0) + 's' : '?'}`;
    return `<tr data-fundpx="${r.fundPerCyclePx == null ? '' : r.fundPerCyclePx}" data-fundsec="${r.fundIntervalSec || ''}" data-token="${r.root}" data-tickknown="${r.tickFromTable ? 1 : 0}" data-tick0="${r.spreadTick == null ? '' : r.spreadTick}" data-ref="${r.refMid}" data-ann="${r.annFactor}" data-fund="${r.pairFundAPY == null ? 0 : r.pairFundAPY}" data-unrel="${r.unreliable ? 1 : 0}" data-key="${key}"${r.unreliable ? ' style="opacity:.45"' : ''}>
    <td class="root"><a href="/chart?root=${encodeURIComponent(r.root)}">${r.root}</a>${hideButtonHTML(r.root)}</td>
    <td title="${spreadsTitle}">${r.root}${SPREAD_LABEL[r.pair].replace('–', '-')}${stale ? ' <span class="neg">⚠stale</span>' : ''}${r.unreliable ? ' <span class="neg">(&lt;24h)</span>' : ''}</td>
    <td>${fmtSpreadPx(r.spreadBid)}</td><td data-px="${r.spreadBid}"></td>
    <td>${fmtSpreadPx(r.spreadAsk)}</td><td data-px="${r.spreadAsk}"></td>
    <td><input class="tickin" size="8" title="Minimum price move for this token's spreads. Pre-filled with a guess from the quote's decimals; type the real tick and it is remembered for every spread of this token."></td><td data-role="tickapy">—</td><td data-role="fundtick">—</td>
    <td data-role="fund">${r.pairFundAPY == null ? '—' : sgnPct(r.pairFundAPY)}</td>
    <td><input class="mypx" data-out="b_${tag}" data-kind="bid" size="7" placeholder="bid"></td><td id="b_${tag}">—</td>
    <td><input class="mypx" data-out="o_${tag}" data-kind="offer" size="7" placeholder="offer"></td><td id="o_${tag}">—</td>
  </tr>`;
  };
  const body = good.length
    ? good.map(rowHTML).join('\n')
    : `<tr><td colspan="14" class="empty">${loadingLegs ? 'Loading order books…' : 'No spreads with live quotes on both legs right now.'}</td></tr>`;
  const errBlock = bad.length
    ? `<div class="meta">No usable quote for ${bad.length} spread(s): ${bad.map(r => `${r.root} ${SPREAD_LABEL[r.pair]} (${r.error})`).join(' · ')}</div>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Bid/Ask — CDE Basis</title>
<style>${SHARED_STYLE}
  input.mypx{background:#0b0e11;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:2px 4px;font:inherit;text-align:right}
  input.mypx:focus{outline:1px solid #60a5fa}
  input.tickin{background:#0b0e11;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:2px 4px;font:inherit;text-align:right;width:7em}
  td.best{white-space:nowrap}
  th.srt{cursor:pointer;text-decoration:underline dotted #6b7280;user-select:none}
  th.srt:hover{color:#60a5fa}
  th.srt.on{color:#0b0e11;background:#60a5fa}
</style></head><body>
${navHTML('/bidask')}
${hiddenBadgeHTML(hidden)}
<h1>Spreads priced in APY — at the bid, the ask, and your own prices</h1>
<div class="meta">Live leg order books · ${good.length} spreads shown · ${built.stats.legsOk} legs quoted, ${built.stats.legsFailed} without a quote${loadingLegs ? ` (${loadingLegs} still loading — requests are paced to stay under Coinbase's rate limit; this page re-checks every 2s until they're in)` : ''} · quotes up to ${built.rows.reduce((mx, r) => Math.max(mx, r.maxBookAgeSec || 0), 0).toFixed(0)}s old (legs are fetched in sequence, grouped by token) · refreshes every ${recheckMs / 1000}s${transientFails ? ` (retrying ${transientFails} leg${transientFails === 1 ? '' : 's'} that failed to load)` : ''} (paused while you're typing)</div>
<div class="sortnav">${filterLinks} &nbsp;·&nbsp; <label><input type="checkbox" id="fundcb" checked> include perp funding in the APYs</label> &nbsp;·&nbsp; <b>Sorted by: <span id="sortlabel">…</span></b> <span style="color:#6b7280">(click an underlined header to change)</span> &nbsp;·&nbsp; <span style="color:#4b5563">page build ${BIDASK_PAGE_BUILD}</span></div>
<table id="t">
<thead><tr><th class="srt" data-sort="token" style="text-align:left">Token</th><th>Spread</th><th>Spread bid</th><th class="srt" data-sort="bid">Bid APY</th><th>Spread ask</th><th class="srt" data-sort="ask">Ask APY</th><th title="Minimum spread price move (tick). Editable, saved per token.">Tick</th><th class="srt" data-sort="tick" title="How much the spread's APY changes for one minimum price move (one tick)">APY per tick</th><th class="srt" data-sort="fundtick" title="Ticks of spread value from ONE funding payment if you BUY the spread (long first leg, short the perp) and hold through it. Positive = you receive, negative = you pay. Selling the spread is the opposite sign. 1–2 spreads have no perp, so no funding.">Funding / cycle (ticks)</th><th>Perp funding (1y)</th><th>My bid</th><th class="srt" data-sort="mybid">My bid APY</th><th>My offer</th><th class="srt" data-sort="myoffer">My offer APY</th></tr></thead>
<tbody>${body}</tbody>
</table>
${errBlock}
<div class="meta"><b>Spread</b> = first leg minus second leg, in price units, the same way your synthetic spreads are quoted (AVA1-Perp = AVAX front − AVAX perp; 2 = next month; 1–2 = front − back). <b>Spread bid</b> = bid of the first leg − ask of the second: the price you could sell the spread at right now by hitting both legs. <b>Spread ask</b> = ask of the first leg − bid of the second: the price you could buy it at right now. These should match the market shown on your synthetic spread ladders.<br>
<b>APY</b> = spread price ÷ perp (or front) price, annualized over the time until the legs converge (front expiry for 1–Perp, back expiry for 2–Perp, the gap between expiries for 1–2). Higher = richer front/back. With the funding box ticked, the perp's current funding rate is subtracted, so the number is a "rich vs. perp including funding" level comparable to the Rich/Cheap % on the other tabs. Type a spread price in <b>My bid</b> / <b>My offer</b> to see its APY (saved in this browser). <b>Click any underlined APY header to sort by it</b> (click again to flip high/low); rows where you haven't typed a price always sink to the bottom when sorting by your own prices. <b>Funding / cycle (ticks)</b> = one perp funding payment at the current rate (rate × perp price), expressed in spread ticks, for buying the spread (long the first leg, short the perp). Positive: you'd be paid that many ticks for holding through the next payment; negative: you'd pay. Sell the spread and it flips. It uses the rate as of now, which can change before the payment, and the Tick box, so correct ticks matter. <b>APY per tick</b> = how many APY points the spread moves for one minimum price move (<b>Tick</b> is pre-filled from CDE's published minimum tick per contract; for a token not in that list it is a guess from the quote's decimals. You can overwrite any tick; it is saved and applies to all of that token's spreads). This tab prices spreads leg-to-leg (future price vs perp price), so it will not exactly match the other tabs, which measure each leg against the index.</div>
<script>
(function(){
  function sget(k){ try { return localStorage.getItem(k); } catch(e) { return null; } }
  function sset(k,v){ try { localStorage.setItem(k,v); } catch(e) {} }
  var cb = document.getElementById('fundcb');
  var savedF = sget('cde_bidask_fund'); if (savedF !== null) cb.checked = savedF === '1';
  function fmt(v){ return (v>=0?'+':'') + v.toFixed(2) + '%'; }
  function lvl(tr, price){
    var l = price / (+tr.dataset.ref) * (+tr.dataset.ann);
    if (cb.checked) l -= (+tr.dataset.fund || 0);
    return l;
  }
  var tbody = document.querySelector('#t tbody');
  var sortKey = sget('cde_bidask_sort') || 'bid';
  if (['bid','ask','tick','fundtick','token','mybid','myoffer'].indexOf(sortKey) < 0) sortKey = 'bid';
  var sortDir = sget('cde_bidask_dir') || 'desc';
  function recalc(doSort){
    var trs = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-ref]'));
    trs.forEach(function(tr){
      var v = { bid: NaN, ask: NaN, mybid: NaN, myoffer: NaN, tick: NaN, fundtick: NaN, token: tr.dataset.token };
      var names = ['bid', 'ask'];
      tr.querySelectorAll('td[data-px]').forEach(function(td, i){
        var p = parseFloat(td.dataset.px);
        if (isNaN(p)) { td.textContent = '—'; return; }
        v[names[i]] = lvl(tr, p);
        td.textContent = fmt(v[names[i]]);
      });
      var ti = tr.querySelector('input.tickin');
      if (ti && !ti._init) {
        ti._init = true;
        var sv = sget('cde_bidask_tick:' + tr.dataset.token);
        ti.value = (sv !== null && sv !== '') ? sv : (tr.dataset.tick0 || '');
        ti.addEventListener('input', function(){
          sset('cde_bidask_tick:' + tr.dataset.token, ti.value);
          tbody.querySelectorAll('tr[data-token="' + tr.dataset.token + '"] input.tickin').forEach(function(o){ if (o !== ti) o.value = ti.value; });
          recalc(false);
        });
        ti.addEventListener('change', function(){ recalc(true); });
      }
      var tk = ti ? parseFloat(ti.value) : NaN, tcell = tr.querySelector('td[data-role="tickapy"]');
      if (!isNaN(tk) && tk > 0) { v.tick = tk / (+tr.dataset.ref) * (+tr.dataset.ann); tcell.textContent = '±' + v.tick.toFixed(2) + '%'; }
      else tcell.textContent = '—';
      var fcell = tr.querySelector('td[data-role="fundtick"]'), fpx = parseFloat(tr.dataset.fundpx);
      if (!isNaN(fpx) && !isNaN(tk) && tk > 0) {
        v.fundtick = fpx / tk;
        var fs = (+tr.dataset.fundsec) ? ' per ' + ((+tr.dataset.fundsec) % 3600 === 0 ? ((+tr.dataset.fundsec) / 3600) + 'h' : (+tr.dataset.fundsec) + 's') + ' payment' : '';
        fcell.textContent = (v.fundtick >= 0 ? '+' : '') + (Math.abs(v.fundtick) >= 100 ? v.fundtick.toFixed(0) : v.fundtick.toFixed(2));
        fcell.className = v.fundtick >= 0 ? 'pos' : 'neg';
        fcell.title = 'Buying this spread receives ' + (fpx >= 0 ? '+' : '') + fpx.toPrecision(3) + ' in spread price' + fs + ' (= ' + v.fundtick.toFixed(2) + ' ticks). Selling pays the opposite.';
      } else { fcell.textContent = '—'; fcell.className = ''; fcell.title = ''; }
      tr.querySelectorAll('input.mypx').forEach(function(inp){
        var out = document.getElementById(inp.dataset.out), p = parseFloat(inp.value);
        if (inp.value.trim() === '' || isNaN(p)) { out.textContent = '—'; return; }
        var l = lvl(tr, p);
        v[inp.dataset.kind === 'bid' ? 'mybid' : 'myoffer'] = l;
        out.textContent = fmt(l);
      });
      tr._v = v;
    });
    document.querySelectorAll('th.srt').forEach(function(th){
      var on = th.dataset.sort === sortKey;
      th.className = 'srt' + (on ? ' on' : '');
      th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (on ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '');
    });
    var SORT_NAMES = { token: 'Token', bid: 'Bid APY', ask: 'Ask APY', tick: 'APY per tick', fundtick: 'Funding per cycle (ticks)', mybid: 'My bid APY', myoffer: 'My offer APY' };
    var sl = document.getElementById('sortlabel');
    if (sl) sl.textContent = (SORT_NAMES[sortKey] || sortKey) + (sortKey === 'token' ? (sortDir === 'desc' ? ' — Z to A' : ' — A to Z') : (sortDir === 'desc' ? ' — highest first' : ' — lowest first'));
    if (doSort === false) return;   // don't reorder rows while the user is mid-typing
    trs.sort(function(a, c){
      if (a.dataset.unrel !== c.dataset.unrel) return a.dataset.unrel === '1' ? 1 : -1;
      if (sortKey === 'token') { var r = a._v.token.localeCompare(c._v.token) || a.dataset.key.localeCompare(c.dataset.key); return sortDir === 'desc' ? -r : r; }
      var av = a._v[sortKey], cv = c._v[sortKey], an = isNaN(av), cn = isNaN(cv);
      if (an || cn) return (an && cn) ? 0 : (an ? 1 : -1);   // blanks always last
      return sortDir === 'desc' ? cv - av : av - cv;
    });
    trs.forEach(function(tr){ tbody.appendChild(tr); });
  }
  document.querySelectorAll('th.srt').forEach(function(th){
    th.title = 'Click to sort by this column; click again to flip';
    th.addEventListener('click', function(){
      if (sortKey === th.dataset.sort) sortDir = (sortDir === 'desc') ? 'asc' : 'desc';
      else { sortKey = th.dataset.sort; sortDir = (sortKey === 'token') ? 'asc' : 'desc'; }
      sset('cde_bidask_sort', sortKey); sset('cde_bidask_dir', sortDir);
      recalc(true);
    });
  });
  tbody.querySelectorAll('tr[data-key]').forEach(function(tr){
    tr.querySelectorAll('input.mypx').forEach(function(inp){
      var v = sget('cde_bidask:' + tr.dataset.key + ':' + inp.dataset.kind);
      if (v !== null) inp.value = v;
      inp.addEventListener('input', function(){
        sset('cde_bidask:' + tr.dataset.key + ':' + inp.dataset.kind, inp.value);
        recalc(false);
      });
      inp.addEventListener('change', function(){ recalc(true); });
    });
  });
  cb.addEventListener('change', function(){ sset('cde_bidask_fund', cb.checked ? '1' : '0'); recalc(true); });
  recalc(true);
  setInterval(function(){
    var a = document.activeElement;
    if (!(a && a.tagName === 'INPUT' && a.type === 'text')) location.reload();
  }, ${recheckMs});
})();
</script>
</body></html>`;
}

// ---------- Volume summary: average daily volume across every token ----------
// Reuses latestStats (already computed each poll) directly — frontVol/backVol
// are ordinary logged metrics, so their mean/std/n come for free from the
// same rollup used for every other metric's z-score.
function buildVolumeRows(hidden = {}) {
  if (!latestStats) return [];
  const rows = [];
  for (const [root, m] of Object.entries(latestStats.stats)) {
    if (hidden[root]) continue;
    const f = m.frontVol, b = m.backVol;
    if ((!f || f.n === 0) && (!b || b.n === 0)) continue;
    rows.push({
      root,
      frontMean: f && f.n ? f.mean : null, frontStd: f && f.n ? f.std : null, frontN: f ? f.n : 0,
      backMean: b && b.n ? b.mean : null, backStd: b && b.n ? b.std : null, backN: b ? b.n : 0,
    });
  }
  rows.sort((a, b) => {
    const av = (a.frontMean || 0) + (a.backMean || 0);
    const bv = (b.frontMean || 0) + (b.backMean || 0);
    return bv - av;
  });
  return rows;
}
function fmtDollar(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}
function volumePageHTML(hidden = {}) {
  const rows = buildVolumeRows(hidden);
  const body = rows.length ? rows.map(r => `<tr>
    <td class="root"><a href="/chart?root=${encodeURIComponent(r.root)}">${r.root}</a>${hideButtonHTML(r.root)}</td>
    <td>${fmtDollar(r.frontMean)}</td>
    <td>${r.frontStd != null ? fmtDollar(r.frontStd) : '—'}</td>
    <td>${r.frontN}</td>
    <td>${fmtDollar(r.backMean)}</td>
    <td>${r.backStd != null ? fmtDollar(r.backStd) : '—'}</td>
    <td>${r.backN}</td>
  </tr>`).join('\n') : '<tr><td colspan="7" class="empty">No volume history logged yet — check back after a few polls.</td></tr>';
  const statsN = latestStats ? latestStats.n : 0;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Volume — CDE Basis</title>
<style>${SHARED_STYLE}</style></head><body>
${navHTML('/volume')}
${hiddenBadgeHTML(hidden)}
<h1>Average Daily Volume — Front &amp; Back Month</h1>
<div class="meta">${rows.length} tokens with logged volume history (${statsN} total logged polls) · averaged across each metric's own rolling window (${STATS_WINDOW_DAYS}d, server default) · sorted by combined front+back volume, highest first · <a href="/volume.csv">⬇ download as CSV</a></div>
<table>
<thead><tr><th>Token</th><th>Front Avg Vol</th><th>Front Std</th><th>Front N</th><th>Back Avg Vol</th><th>Back Std</th><th>Back N</th></tr></thead>
<tbody>${body}</tbody>
</table>
<script>setTimeout(()=>location.reload(),30000);</script>
</body></html>`;
}
function volumeCSV() {
  const rows = buildVolumeRows();
  const header = 'token,front_avg_volume_usd,front_std_usd,front_n_polls,back_avg_volume_usd,back_std_usd,back_n_polls';
  const lines = rows.map(r => [
    r.root,
    r.frontMean != null ? r.frontMean.toFixed(0) : '',
    r.frontStd != null ? r.frontStd.toFixed(0) : '',
    r.frontN,
    r.backMean != null ? r.backMean.toFixed(0) : '',
    r.backStd != null ? r.backStd.toFixed(0) : '',
    r.backN,
  ].join(','));
  return [header, ...lines].join('\n') + '\n';
}

// ---------- Calibration: measures real market behavior from the logged
// history, to replace guessed simulator parameters with real ones as
// history accumulates. Not filtered by hidden tokens — hiding is a display
// preference, not a signal that a token shouldn't count toward calibrating
// overall market behavior. ----------
function fmtDays(v) { return v == null ? '—' : v.toFixed(2) + 'd'; }
function fmtPerDay(v) { return v == null ? '—' : v.toFixed(2) + '/day'; }

async function calibrationPageHTML() {
  const panel = await calibration.loadPanel(LOG_PATH);
  const nav = navHTML('/calibration');

  if (panel.length < 50) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Calibration — CDE Basis</title>
<style>${SHARED_STYLE}</style></head><body>
${nav}
<h1>Calibration</h1>
<div class="empty">Only ${panel.length} polls logged so far — not enough history yet to compute meaningful statistics (need at least 50). Check back once the monitor has been running longer.</div>
</body></html>`;
  }

  const spanDays = (panel[panel.length - 1].tMs - panel[0].tMs) / 86_400_000;
  // Use the CURRENTLY CONFIGURED alert thresholds as the default lens, so
  // this page stays consistent with whatever /alerts/settings has live —
  // change the thresholds there and this page's numbers follow.
  const entryThreshold = alertSettings.altThreshold;
  const exitThreshold = alertSettings.clearThreshold;

  const arrivals = calibration.arrivalStats(panel, entryThreshold);
  const persistence = calibration.persistenceStats(panel);
  const epStats = calibration.episodeStats(panel, entryThreshold, exitThreshold);
  const corr = calibration.correlationStats(panel);
  const replay = calibration.replayRolls(panel, {
    entryThreshold, exitThreshold, assumedHoldDays: 1,
    notional: 100000, leverage: 5, makerFee: 0.04, takerFee: 0.06, contractsPerLeg: 200,
  });

  const topArrivals = [...arrivals.perSeries].sort((a, b) => (b.perDay || 0) - (a.perDay || 0)).slice(0, 8);

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Calibration — CDE Basis</title>
<style>${SHARED_STYLE}
  .calgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px}
  .calcard{background:#111827;border:1px solid #1f2937;border-radius:8px;padding:14px}
  .calcard .lab{font-size:10px;text-transform:uppercase;color:#6b7280;margin-bottom:6px}
  .calcard .big{font-size:20px;font-weight:700}
  .calcard .sub{font-size:11px;color:#9ca3af;margin-top:4px}
  .simbox{background:#111827;border:1px solid #60a5fa;border-radius:8px;padding:14px;margin-bottom:16px;font-size:12px;color:#9ca3af;line-height:1.7}
  .simbox b{color:#60a5fa}
</style></head><body>
${nav}
<h1>Calibration</h1>
<div class="meta">Measures real market behavior directly from ${panel.length} logged polls spanning ${spanDays.toFixed(1)} days — no new data source, this is the same log the dashboard already writes to. Uses the currently configured alert thresholds (entry ${entryThreshold}%, exit ${exitThreshold}%) from <a href="/alerts/settings">Alert Settings</a> as the lens for these calculations.</div>
${spanDays < 14 ? `<div class="err">Only ${spanDays.toFixed(1)} days of history — these numbers will move around a lot as more data accumulates. Treat everything below as provisional, not a settled calibration, until you have at least a few weeks.</div>` : ''}

<h2>Arrival rate — how often does something cross the entry bar</h2>
<div class="calgrid">
  <div class="calcard">
    <div class="lab">Any of the 51 spreads</div>
    <div class="big">${fmtPerDay(arrivals.aggregate.perDay)}</div>
    <div class="sub">${arrivals.aggregate.crossings} crossings over ${arrivals.aggregate.spanDays.toFixed(1)}d — this is "how often will we find A good trade"</div>
  </div>
</div>
<table>
<thead><tr><th>Token</th><th>Pair</th><th>Crossings</th><th>Per day</th></tr></thead>
<tbody>${topArrivals.map(a => `<tr><td class="root">${a.root}</td><td>${a.pairKey}</td><td>${a.crossings}</td><td>${fmtPerDay(a.perDay)}</td></tr>`).join('\n')}</tbody>
</table>

<h2>Persistence — how fast a rich spread decays (empirical half-life)</h2>
<div class="calgrid">
  <div class="calcard">
    <div class="lab">Median half-life</div>
    <div class="big">${fmtDays(persistence.summary.medianHalfLifeDays)}</div>
    <div class="sub">across ${persistence.summary.nEstimable} series with enough data (${persistence.summary.nLowConfidence} flagged low-confidence — near-random-walk, treat with caution)</div>
  </div>
  <div class="calcard">
    <div class="lab">Mean half-life</div>
    <div class="big">${fmtDays(persistence.summary.meanHalfLifeDays)}</div>
  </div>
</div>

<h2>Episode duration — how long a qualifying opportunity actually lasts</h2>
<div class="calgrid">
  <div class="calcard">
    <div class="lab">Median duration</div>
    <div class="big">${fmtDays(epStats.summary.medianDurationDays)}</div>
    <div class="sub">${epStats.summary.nClosedEpisodes} closed episodes, ${epStats.summary.nStillOpen} still open at end of log</div>
  </div>
  <div class="calcard">
    <div class="lab">Mean duration</div>
    <div class="big">${fmtDays(epStats.summary.meanDurationDays)}</div>
  </div>
</div>

<h2>Roll frequency — replaying the real roll rule against real history</h2>
<div class="calgrid">
  <div class="calcard">
    <div class="lab">Rolls / month (projected)</div>
    <div class="big">${replay.rollsPerMonth != null ? replay.rollsPerMonth.toFixed(1) : '—'}</div>
    <div class="sub">${replay.rolls} actual rolls, ${replay.entries} entries, ${replay.exits} exits over ${replay.spanDays.toFixed(1)}d</div>
  </div>
  <div class="calcard">
    <div class="lab">Median hold between transitions</div>
    <div class="big">${fmtDays(replay.medianHoldDaysBetweenTransitions)}</div>
    <div class="sub">mean: ${fmtDays(replay.meanHoldDaysBetweenTransitions)}</div>
  </div>
</div>

<h2>Correlation across spreads</h2>
<div class="calgrid">
  <div class="calcard">
    <div class="lab">Mean pairwise correlation</div>
    <div class="big">${corr.mean != null ? corr.mean.toFixed(2) : '—'}</div>
    <div class="sub">median ${corr.median != null ? corr.median.toFixed(2) : '—'} · P10 ${corr.p10 != null ? corr.p10.toFixed(2) : '—'} · P90 ${corr.p90 != null ? corr.p90.toFixed(2) : '—'} · ${corr.nPairs} pairs with enough overlap</div>
  </div>
</div>

<div class="simbox">
  <b>What to plug into the simulator</b><br>
  Mean-reversion half-life: <b>${fmtDays(persistence.summary.medianHalfLifeDays)}</b> (simulator's "Mean-reversion half-life" slider)<br>
  Correlation: <b>${corr.mean != null ? corr.mean.toFixed(2) : '—'}</b> (simulator's "Correlation across spreads" slider)<br>
  Assumed holding period: <b>${fmtDays(replay.medianHoldDaysBetweenTransitions)}</b> (simulator's "Expected holding period" slider — this replaces the earlier 1-day guess with a real measurement)<br>
  <span style="color:#6b7280">These are measurements from ${spanDays.toFixed(1)} days of real history, not guarantees about the future — revisit this page periodically as more data accumulates, especially after living through a genuinely different volatility regime.</span>
</div>
</body></html>`;
}

// ---------- "My Positions" panel: pinned tokens with entry vs. current ----------
function positionsTableHTML(snap, positions) {
  const roots = Object.keys(positions);
  if (!roots.length) {
    return `<div class="pospanel empty">No positions tracked yet — click <b>☆ track</b> next to a token on the main dashboard to start tracking it.</div>`;
  }
  const rowsHTML = roots.map(root => {
    const pos = positions[root];
    const row = snap.rows.find(rr => rr.root === root);
    const currentDiv = row ? row.divergence : null;
    const zRec = latestStats && latestStats.stats[root] ? latestStats.stats[root].div : null;
    const currentZ = zRec ? zRec.z : null;
    const movement = (pos.entryDiv != null && currentDiv != null) ? (currentDiv - pos.entryDiv) : null;
    const status = positionStatus(pos.entryDiv, currentDiv);
    const ageMin = Math.round((Date.now() - Date.parse(pos.addedAt)) / 60000);
    const ageTxt = ageMin < 60 ? `${ageMin}m` : `${(ageMin / 60).toFixed(1)}h`;
    return `<tr>
      <td class="root">${root}</td>
      <td>${sideLabel(pos.entryDiv)}</td>
      <td>${pos.entryDiv == null ? '—' : pos.entryDiv.toFixed(2) + '%'}</td>
      <td>${currentDiv == null ? '—' : pct(currentDiv, 2)}</td>
      <td class="${movement == null ? '' : (movement >= 0 ? 'pos' : 'neg')}">${movement == null ? '—' : (movement >= 0 ? '+' : '') + movement.toFixed(2) + '%'}</td>
      <td>${pos.entryZ == null ? '—' : (pos.entryZ >= 0 ? '+' : '') + pos.entryZ.toFixed(2) + 'σ'}</td>
      <td class="${zClass(currentZ)}">${zTxt(currentZ)}</td>
      <td class="${status.cls}">${status.label}</td>
      <td>${ageTxt} ago</td>
      <td><form method="POST" action="/positions/unpin"><input type="hidden" name="root" value="${root}"><button type="submit" class="pinbtn">remove</button></form></td>
    </tr>`;
  }).join('\n');
  return `<div class="pospanel">
  <table class="postable">
  <thead><tr><th>Token</th><th>Side (at entry)</th><th>Entry Rich/Cheap %</th><th>Current Rich/Cheap %</th><th>Move</th><th>Entry Z</th><th>Current Z</th><th>Status</th><th>Age</th><th></th></tr></thead>
  <tbody>${rowsHTML}</tbody>
  </table>
  </div>`;
}

// Compact badge shown on the main dashboard — opportunity-scanning and
// position-tracking are different jobs, so the full detail lives on its own
// page and the main table just shows a count + link.
function positionsBadgeHTML(positions) {
  const n = Object.keys(positions).length;
  return `<div class="posbadge"><a href="/positions">📌 My Positions (${n})${n ? ' — CONVERGING / DIVERGING / FLIPPED status →' : ' — start tracking a token below →'}</a></div>`;
}

// Same badge-plus-dedicated-page pattern as positions: hiding a token is a
// one-click action from any table row, but the LIST of what's hidden lives
// on its own page so nothing disappears silently forever.
function hiddenBadgeHTML(hidden) {
  const n = Object.keys(hidden).length;
  if (!n) return '';
  return `<div class="posbadge"><a href="/hidden">🙈 ${n} token${n > 1 ? 's' : ''} hidden — manage →</a></div>`;
}
function hiddenPageHTML(hidden) {
  const roots = Object.keys(hidden);
  const body = roots.length
    ? roots.map(root => `<tr>
        <td class="root">${root}</td>
        <td>${hidden[root] && hidden[root].hiddenAt ? new Date(hidden[root].hiddenAt).toLocaleString() : '—'}</td>
        <td><form method="POST" action="/unhide"><input type="hidden" name="root" value="${root}"><button type="submit" class="pinbtn">✕ unhide</button></form></td>
      </tr>`).join('\n')
    : '<tr><td colspan="3" class="empty">No tokens hidden — click the ✕ next to any token name on the scanning pages to hide it.</td></tr>';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Hidden Tokens — CDE Basis</title>
<style>${SHARED_STYLE}</style></head><body>
${navHTML(null)}
<h1>Hidden Tokens</h1>
<div class="meta">Hidden tokens are excluded from Overview, Front vs Perp, Front vs Back, Term Structure, and Volume — they're still fully monitored and logged, just not shown on those pages.</div>
<table>
<thead><tr><th>Token</th><th>Hidden Since</th><th></th></tr></thead>
<tbody>${body}</tbody>
</table>
</body></html>`;
}

function alertSettingsPageHTML(saved, error) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Alert Settings — CDE Basis</title>
<style>${SHARED_STYLE}
  .settingsform{background:#111827;border:1px solid #1f2937;border-radius:8px;padding:16px;max-width:480px}
  .settingsform label{display:block;font-size:12px;color:#9ca3af;margin:14px 0 4px}
  .settingsform label:first-child{margin-top:0}
  .settingsform input[type=number],.settingsform input[type=text]{background:#0b0e11;color:#c9d1d9;border:1px solid #1f2937;border-radius:4px;padding:6px 8px;font:inherit;width:100%;box-sizing:border-box}
  .settingsform .hint{font-size:11px;color:#6b7280;margin-top:4px}
  .settingsform button{margin-top:18px;background:#60a5fa;color:#0b0e11;border:none;border-radius:4px;padding:8px 16px;font-weight:600;cursor:pointer;font:inherit}
  .settingsform button:hover{background:#93c5fd}
  .saved{color:#34d399;font-size:12px;margin-bottom:12px}
  .formerr{color:#f87171;font-size:12px;margin-bottom:12px}
</style></head><body>
${navHTML(null)}
<h1>Alert Settings</h1>
<div class="meta">Changes take effect on the next poll (within ${Math.round(POLL_MS / 1000)}s) — no restart needed. Persisted to disk, so they survive restarts too. Each of the 3 possible legs (front↔perp, front↔back, back↔perp) is tracked independently: an ENTRY alert fires once when a leg crosses above its threshold, then nothing fires again until it drops below the exit threshold, which fires its own "normalized" alert. This gap between the two lines is deliberate — it stops noise near a single threshold from re-firing the same alert repeatedly.</div>
${saved ? '<div class="saved">✓ Saved.</div>' : ''}
${error ? `<div class="formerr">✗ ${error}</div>` : ''}
<form class="settingsform" method="POST" action="/alerts/settings">
  <label>Major token ENTRY threshold (%)</label>
  <input type="number" step="0.1" min="0" name="majorThreshold" value="${alertSettings.majorThreshold}" required>
  <div class="hint">A major's leg alerts once it reaches this magnitude or higher.</div>

  <label>Alt token ENTRY threshold (%)</label>
  <input type="number" step="0.1" min="0" name="altThreshold" value="${alertSettings.altThreshold}" required>
  <div class="hint">Same, for every token NOT listed as a major below.</div>

  <label>EXIT threshold (%) — applies to both majors and alts</label>
  <input type="number" step="0.1" min="0" name="clearThreshold" value="${alertSettings.clearThreshold}" required>
  <div class="hint">Once alerted, a leg must drop back below THIS level to fire the "normalized, consider closing" alert. Must be lower than the entry thresholds above, or every entry alert will immediately clear.</div>

  <label>Major tokens (comma-separated)</label>
  <input type="text" name="majors" value="${alertSettings.majors.join(', ')}">
  <div class="hint">e.g. BTC, ETH — anything else is treated as an alt.</div>

  <button type="submit">Save</button>
</form>
</body></html>`;
}

function positionsPageHTML(snap, positions) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>My Positions — CDE Basis</title>
<style>${SHARED_STYLE}</style></head><body>
${navHTML(null)}
<h1>My Positions</h1>
<div class="meta">Status: CONVERGING (working) / DIVERGING (against you) / FLIPPED (rich side swapped since entry) / FLAT (little movement yet) · this page refreshes every 5s</div>
${positionsTableHTML(snap, positions)}
<script>setTimeout(()=>location.reload(),5000);</script>
</body></html>`;
}

function html(snap, opts = {}) {
  const sortMode = ['basis', 'absdiv', 'absz', 'bestspread', 'fundapy'].includes(opts.sortMode) ? opts.sortMode : 'bestspread';
  const positions = opts.positions || {};
  const hidden = opts.hidden || {};
  const visibleRows = snap.rows.filter(r => !hidden[r.root]);
  const sortedRows = sortRows(visibleRows, sortMode);
  const rows = sortedRows.map(r => rowHTML(r, positions)).join('\n');
  const errLine = lastError ? `<div class="err">last poll error: ${lastError}</div>` : '';
  const statsErrLine = lastStatsError ? `<div class="err">last stats error: ${lastStatsError}</div>` : '';
  const statsN = latestStats ? latestStats.n : 0;
  const navLink = (mode, label) => `<a href="/?sort=${mode}" class="${sortMode === mode ? 'active' : ''}">${label}</a>`;
  const sortNav = `<div class="sortnav">Sort by: ${navLink('bestspread', 'Best Spread (any pair)')} · ${navLink('basis', 'Basis APY')} · ${navLink('absdiv', 'Biggest Rich/Cheap %')} · ${navLink('absz', 'Biggest Z-score')} · ${navLink('fundapy', 'Highest Funding APY (incl. perp-only)')}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>CDE Basis vs Funding — Overview</title>
<style>${SHARED_STYLE}</style></head><body>
${navHTML('/')}
<h1>Overview — every token, ranked by its single best opportunity</h1>
<div class="meta">generated ${snap.generatedAt} · horizon=${snap.horizonDays}d${snap.horizonOverride ? ' (override: all rows)' : ' (each row uses its own front-dated expiry)'} · poll ${snap.pollMs}ms · refresh 5s · Rich/Cheap % = basis APY minus funding APY (front vs. perp only) · Term (F−B) = front basis APY minus back basis APY · Best Spread = the largest of all 3 possible pairwise spreads (front↔perp, front↔back, back↔perp) for that token, with the actual trade to put on · Z-score = how unusual today's Rich/Cheap % is vs. this token's own ${STATS_WINDOW_DAYS}d history (${statsN} logged polls) · flags: NEAR_DATED(<30d to expiry) LOW_LIQ NO_S(no valid spot/index) · click a token name for full detail and history chart</div>
${errLine}${statsErrLine}
${positionsBadgeHTML(positions)}
${hiddenBadgeHTML(hidden)}
${sortNav}
<table>
<thead><tr>
<th>Token</th>
<th>Perp</th><th>Front</th><th>Back</th><th>Basis APY</th><th>Term (F−B)</th><th>Funding (1h)</th><th>Funding APY</th>
<th>Rich/Cheap %</th><th>Z-score</th><th>Best Spread</th><th>Action (Front↔Perp)</th><th>Track</th>
</tr></thead>
<tbody>
${rows}
</tbody></table>
<script>
setTimeout(()=>location.reload(),5000);
</script></body></html>`;
}

// ---------- per-token history chart page ----------
// Self-contained page; fetches /api/history client-side and plots with Chart.js
// (loaded from cdnjs — requires the browser to have internet access, same as
// any other CDN-based dashboard).
function chartPageHTML(root) {
  const safeRoot = String(root).replace(/[^A-Za-z0-9_]/g, '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${safeRoot} — basis vs funding history</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js"></script>
<style>
  body{background:#0b0e11;color:#c9d1d9;font:13px/1.4 -apple-system,Segoe UI,Roboto,monospace;margin:0;padding:16px}
  h1{font-size:16px;margin:0 0 4px}
  a{color:#60a5fa}
  .meta{color:#6b7280;font-size:11px;margin-bottom:14px}
  .zbox{display:inline-block;background:#111827;border:1px solid #1f2937;border-radius:6px;padding:8px 12px;margin:0 8px 12px 0}
  .zbox .lab{color:#9ca3af;font-size:10px;text-transform:uppercase}
  .zbox .val{font-size:18px;font-weight:700}
  select{background:#111827;color:#c9d1d9;border:1px solid #1f2937;padding:4px 8px;margin-bottom:12px}
  .rangebtn{background:#111827;color:#9ca3af;border:1px solid #1f2937;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px;margin-bottom:12px}
  .rangebtn:first-of-type{border-radius:4px 0 0 4px}
  .rangebtn:last-of-type{border-radius:0 4px 4px 0}
  .rangebtn + .rangebtn{border-left:none}
  .rangebtn:hover:not(.active){border-color:#60a5fa;color:#60a5fa}
  .rangebtn.active{background:#60a5fa;color:#0b0e11;font-weight:600;border-color:#60a5fa}
  .togglebtn{background:#111827;color:#9ca3af;border:1px solid #1f2937;border-radius:4px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px;margin-bottom:12px}
  .togglebtn:hover:not(.active){border-color:#60a5fa;color:#60a5fa}
  .togglebtn.active{background:#1e3a5f;color:#93c5fd;border-color:#60a5fa;font-weight:600}
  canvas{max-height:440px}
</style></head><body>
<h1>${safeRoot} — dated basis vs perp funding, historical</h1>
<div class="meta"><a href="/">&larr; back to dashboard</a> · metric:
  <select id="metric">
    <option value="div">divergence (basis − funding)</option>
    <option value="bApy">basis APY</option>
    <option value="fApy">funding APY</option>
    <option value="gap">perp gap %</option>
    <option value="aD">dated all-in %</option>
    <option value="aP">perp all-in %</option>
    <option value="bkApy">back-month basis APY</option>
    <option value="term">term slope (front − back)</option>
    <option value="bpApy">back↔perp spread</option>
    <option value="frontVol">front 24h volume ($)</option>
    <option value="backVol">back 24h volume ($)</option>
  </select>
  · range:
  <button class="rangebtn" data-days="1" type="button">24 Hours</button><button class="rangebtn" data-days="7" type="button">1 Week</button><button class="rangebtn" data-days="30" type="button">30 Days</button>
  &nbsp;<button class="togglebtn active" id="autoScaleBtn" type="button" title="Sizes the y-axis around RECENT behavior (last ~25% of the loaded window), not the whole thing — so old noise (like a pre-roll volatile stretch) doesn't force the scale wide and flatten what's happening now. Older data still plots, it just may run off the edge.">📏 Auto-scale (recent levels)</button>
</div>
<div id="zboxes"></div>
<div id="rollnote"></div>
<canvas id="chart"></canvas>
<script>
const ROOT = ${JSON.stringify(safeRoot)};
const METRIC_LABEL = {div:'Divergence %',bApy:'Basis APY %',fApy:'Funding APY %',gap:'Perp gap %',aD:'Dated all-in %',aP:'Perp all-in %',bkApy:'Back-month basis APY %',term:'Term slope (F−B) %',bpApy:'Back↔Perp spread %',frontVol:'Front 24h Volume ($)',backVol:'Back 24h Volume ($)'};
const DOLLAR_METRICS = ['frontVol', 'backVol'];
function fmtVal(metric, v) {
  if (v == null) return '—';
  if (DOLLAR_METRICS.includes(metric)) {
    const abs = Math.abs(v);
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }
  return v.toFixed(2) + '%';
}
let chart = null;

function zColor(z) {
  if (z == null) return '#60a5fa'; // blue: unknown / not enough history
  const a = Math.abs(z);
  return a >= 2 ? '#f87171' : (a >= 1 ? '#fbbf24' : '#34d399'); // red / amber / green
}

async function load(metric, windowDays) {
  const url = '/api/history?root=' + encodeURIComponent(ROOT) + '&metric=' + metric + (windowDays ? '&windowDays=' + windowDays : '');
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) { document.getElementById('zboxes').innerHTML = '<div style="color:#f87171">' + data.error + '</div>'; return; }
  const points = data.points || [];
  const labels = points.map(p => new Date(p.t).toLocaleString());
  const vals = points.map(p => p.v);
  const n = vals.length;
  const mean = data.stats ? data.stats.mean : null;
  const std = data.stats ? data.stats.std : null;
  const z = data.stats ? data.stats.z : null;
  const latest = vals.length ? vals[vals.length - 1] : null;
  const curColor = zColor(z);

  document.getElementById('zboxes').innerHTML =
    '<div class="zbox"><div class="lab">n polls</div><div class="val">' + n + '</div></div>' +
    '<div class="zbox"><div class="lab">latest</div><div class="val" style="color:' + curColor + '">' + fmtVal(metric, latest) + '</div></div>' +
    '<div class="zbox"><div class="lab">mean (= avg over window)</div><div class="val">' + fmtVal(metric, mean) + '</div></div>' +
    '<div class="zbox"><div class="lab">std</div><div class="val">' + fmtVal(metric, std) + '</div></div>' +
    '<div class="zbox"><div class="lab">z-score</div><div class="val" style="color:' + curColor + '">' + (z == null ? '— (need 5+ polls)' : (z >= 0 ? '+' : '') + z.toFixed(2) + 'σ') + '</div></div>';

  const band2Upper = (mean != null && std != null) ? labels.map(() => mean + 2 * std) : [];
  const band2Lower = (mean != null && std != null) ? labels.map(() => mean - 2 * std) : [];
  const band3Upper = (mean != null && std != null) ? labels.map(() => mean + 3 * std) : [];
  const band3Lower = (mean != null && std != null) ? labels.map(() => mean - 3 * std) : [];
  const meanLine = (mean != null) ? labels.map(() => mean) : [];
  const currentLine = (latest != null) ? labels.map(() => latest) : [];

  // Make the last point on the main line stand out: everything else is a thin
  // dot, the most recent reading is a large marker colored by its z-severity.
  const pointRadii = vals.map((_, i) => (i === vals.length - 1 ? 6 : 1));
  const pointColors = vals.map((_, i) => (i === vals.length - 1 ? curColor : '#60a5fa'));

  // Roll markers: a thin bar spanning the y-range at each index where the
  // front contract changed (e.g. Aug -> Sep). The underlying line stays
  // continuous by design — this is annotation only, drawn as a mixed
  // bar+line dataset so no extra plugin/CDN dependency is needed.
  const rolls = data.rolls || [];
  const allVals = vals.filter(v => v != null);
  const dataMax = allVals.length ? Math.max(...allVals) : 0;
  const dataMin = allVals.length ? Math.min(...allVals) : 0;
  const band3Top = (mean != null && std != null) ? mean + 3 * std : dataMax;
  const band3Bot = (mean != null && std != null) ? mean - 3 * std : dataMin;
  const yTop = Math.max(dataMax, band3Top) * (dataMax >= 0 ? 1.15 : 0.85) || 1;
  const yBot = Math.min(dataMin, band3Bot) * (dataMin >= 0 ? 0.85 : 1.15) || -1;

  // Auto-scale: size the visible y-axis around RECENT behavior, not the
  // whole window. Percentile-trimming alone isn't enough here — the noisy
  // pre-roll period isn't a rare 2% outlier, it can be a big fraction of a
  // 1-week view, so trimming only the extreme tails still leaves a wide
  // range. Instead, take the percentile bounds from just the last quarter of
  // the loaded window (whatever "recent" means for the selected range —
  // last ~6h on a 24h view, last ~1.75d on a 1-week view, etc.), so the
  // scale reflects "what does normal look like right now." Older noise
  // still plots — it just runs off the edge instead of setting the scale.
  // Deliberately does NOT force the axis wide enough to fit the full ±3σ
  // band, since that band's width is itself inflated by the same old,
  // whole-window noise this is trying to get away from — the bands still
  // render, they just may run off-screen too when they're wider than the
  // recent view, same as the raw data.
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function niceRound(v, roundUp) {
    if (v === 0) return 0;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v))));
    const step = mag / 2;
    return roundUp ? Math.ceil(v / step) * step : Math.floor(v / step) * step;
  }
  const recentCount = Math.max(20, Math.ceil(allVals.length * 0.25));
  const recentVals = allVals.slice(-recentCount);
  const sortedRecent = [...recentVals].sort((a, b) => a - b);
  const p2 = percentile(sortedRecent, 2);
  const p98 = percentile(sortedRecent, 98);
  let autoYMin = null, autoYMax = null;
  if (p2 != null && p98 != null) {
    const range = p98 - p2;
    const pad = range > 0 ? range * 0.3 : (Math.abs(p98) * 0.3 || 1);
    autoYMin = niceRound(p2 - pad, false);
    autoYMax = niceRound(p98 + pad, true);
  }

  const rollBarData = labels.map((_, i) => rolls.some(r => r.index === i) ? yTop : null);
  const rollSummary = rolls.length
    ? '<div style="font-size:11px;color:#c084fc;margin-top:6px">↻ ' + rolls.length + ' roll' + (rolls.length > 1 ? 's' : '') + ' in this window: ' +
      rolls.map(r => (r.from || '?') + ' → ' + (r.to || '?')).join(', ') + '</div>'
    : '';
  document.getElementById('rollnote').innerHTML = rollSummary;

  const datasets = [];
  // Layered sigma bands, drawn back-to-front via "order" (Chart.js: lower
  // order = drawn later = on top). The 3sigma band is drawn FIRST (furthest
  // back) as a wide amber zone; the 2sigma band is drawn on top of it as a
  // narrower, more solid blue zone — so the visual result reads as three
  // clear tiers: solid blue center (within 2sigma), amber ring (2-3sigma),
  // plain background beyond 3sigma. Each band's own boundary line is also
  // drawn more solidly than before so it doesn't disappear into the grid.
  if (std != null) {
    // Outer band: +/-3sigma, amber. Fill target uses ARRAY position (the
    // dataset immediately before it), independent of the "order" property.
    datasets.push({ label: '+3σ', data: band3Upper, borderColor: 'rgba(251,146,60,0.55)', borderWidth: 1.5, pointRadius: 0, borderDash: [5,3], fill: false, order: 8 });
    datasets.push({ label: '±3σ band', data: band3Lower, borderColor: 'rgba(251,146,60,0.55)', borderWidth: 1.5, pointRadius: 0, borderDash: [5,3], fill: '-1', backgroundColor: 'rgba(251,146,60,0.12)', order: 8 });
    // Inner band: +/-2sigma, blue. Drawn with a lower "order" so it layers
    // ON TOP of the 3sigma band within the overlapping +/-2sigma range.
    datasets.push({ label: '+2σ', data: band2Upper, borderColor: 'rgba(96,165,250,0.75)', borderWidth: 1.5, pointRadius: 0, borderDash: [5,3], fill: false, order: 7 });
    datasets.push({ label: '±2σ band', data: band2Lower, borderColor: 'rgba(96,165,250,0.75)', borderWidth: 1.5, pointRadius: 0, borderDash: [5,3], fill: '-1', backgroundColor: 'rgba(96,165,250,0.22)', order: 7 });
  }
  if (mean != null) {
    datasets.push({ label: 'mean', data: meanLine, borderColor: '#c9a86a', borderWidth: 2, pointRadius: 0, borderDash: [6,3], order: 6 });
  }
  if (latest != null) {
    datasets.push({ label: 'current level', data: currentLine, borderColor: curColor, borderWidth: 1.5, pointRadius: 0, borderDash: [2,4], order: 5 });
  }
  if (rolls.length) {
    datasets.push({
      type: 'bar', label: '↻ contract roll', data: rollBarData,
      backgroundColor: 'rgba(192,132,252,0.25)', barPercentage: 1, categoryPercentage: 0.06,
      base: yBot, order: 2,
    });
  }
  datasets.push({
    label: METRIC_LABEL[metric], data: vals, borderColor: '#60a5fa', backgroundColor: 'transparent',
    pointRadius: pointRadii, pointBackgroundColor: pointColors, pointBorderColor: pointColors,
    tension: 0.15, borderWidth: 1.5, order: 1,
  });

  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: {
          labels: {
            color: '#c9d1d9',
            // Hide the invisible upper-boundary helper datasets ("+2σ",
            // "+3σ") from the legend — only the labeled, filled band entries
            // and the real data series should show.
            filter: (item) => !item.text.startsWith('+'),
          },
        },
      },
      scales: {
        x: { ticks: { color: '#6b7280', maxTicksLimit: 8 }, grid: { color: '#1f2937' } },
        y: {
          ticks: { color: '#6b7280' }, grid: { color: '#1f2937' },
          min: (autoScaleEnabled && autoYMin != null) ? autoYMin : undefined,
          max: (autoScaleEnabled && autoYMax != null) ? autoYMax : undefined,
        },
      },
    },
  });
}

let currentRangeDays = '30';
let autoScaleEnabled = true;
function selectRange(days) {
  currentRangeDays = String(days);
  document.querySelectorAll('.rangebtn').forEach(b => b.classList.toggle('active', b.dataset.days === currentRangeDays));
  load(document.getElementById('metric').value, currentRangeDays);
}
document.querySelectorAll('.rangebtn').forEach(b => b.addEventListener('click', () => selectRange(b.dataset.days)));
document.getElementById('metric').addEventListener('change', e => load(e.target.value, currentRangeDays));
document.getElementById('autoScaleBtn').addEventListener('click', () => {
  autoScaleEnabled = !autoScaleEnabled;
  document.getElementById('autoScaleBtn').classList.toggle('active', autoScaleEnabled);
  load(document.getElementById('metric').value, currentRangeDays);
});
selectRange('30');
setInterval(() => load(document.getElementById('metric').value, currentRangeDays), 30000);
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/snapshot') {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(latest || { error: lastError || 'no data yet' }));
    return;
  }

  if (url.pathname === '/api/stats') {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    const windowDays = parseFloat(url.searchParams.get('windowDays') || '');
    if (!isNaN(windowDays) && windowDays > 0) {
      // explicit window requested -> fresh compute (not the cached default-window one)
      try {
        const fresh = await statsFromLog(LOG_PATH, { windowDays });
        res.end(JSON.stringify(fresh));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    res.end(JSON.stringify(latestStats || { error: lastStatsError || 'no stats yet' }));
    return;
  }

  if (url.pathname === '/api/history') {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    const root = url.searchParams.get('root');
    const metric = url.searchParams.get('metric') || 'div';
    const windowDays = parseFloat(url.searchParams.get('windowDays') || '');
    if (!root) { res.statusCode = 400; res.end(JSON.stringify({ error: 'missing ?root=' })); return; }
    if (!METRICS.includes(metric)) { res.statusCode = 400; res.end(JSON.stringify({ error: `metric must be one of ${METRICS.join(', ')}` })); return; }
    try {
      const opts = (!isNaN(windowDays) && windowDays > 0) ? { windowDays } : { windowDays: STATS_WINDOW_DAYS };
      const hist = await historyFor(LOG_PATH, root, opts);
      const points = hist[metric] || [];
      const vals = points.map(p => p.v);
      const n = vals.length;
      let statsOut = null;
      if (n > 0) {
        const mu = vals.reduce((a, b) => a + b, 0) / n;
        const sd = n >= 2 ? Math.sqrt(vals.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (n - 1)) : null;
        const z = (n >= 5 && sd != null && sd > 0) ? (vals[n - 1] - mu) / sd : null;
        statsOut = { n, mean: mu, std: sd, z };
      }
      // Roll markers: index into `points` where the front contract's expiry
      // changed vs. the previous logged poll. The underlying series stays
      // continuous by design (front-month basis is a role, not a fixed
      // contract) — this only ANNOTATES where a roll happened, it doesn't
      // alter or split the values themselves.
      const expiryByT = {};
      for (const e of (hist.frontExpiry || [])) expiryByT[e.t] = e.v;
      const rolls = [];
      let lastExpiry = null;
      points.forEach((p, i) => {
        const exp = expiryByT[p.t];
        if (exp != null) {
          if (lastExpiry != null && exp !== lastExpiry) rolls.push({ index: i, from: lastExpiry, to: exp });
          lastExpiry = exp;
        }
      });
      res.end(JSON.stringify({ root, metric, points, stats: statsOut, rolls }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/chart') {
    const root = url.searchParams.get('root');
    if (!root) { res.statusCode = 400; res.end('missing ?root='); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    res.end(chartPageHTML(root));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/positions') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    if (latest) res.end(positionsPageHTML(latest, loadPositions()));
    else res.end('<p>loading… <a href="/">back to dashboard</a></p>');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/hidden') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    res.end(hiddenPageHTML(loadHidden()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/alerts/settings') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    res.end(alertSettingsPageHTML(url.searchParams.get('saved') === '1', url.searchParams.get('error') || null));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/alerts/settings') {
    const body = parseFormBody(await readBody(req));
    const majorThreshold = parseFloat(body.majorThreshold);
    const altThreshold = parseFloat(body.altThreshold);
    const clearThreshold = parseFloat(body.clearThreshold);
    const majors = (body.majors || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const valid = !isNaN(majorThreshold) && majorThreshold >= 0
      && !isNaN(altThreshold) && altThreshold >= 0
      && !isNaN(clearThreshold) && clearThreshold >= 0;
    if (!valid) {
      res.statusCode = 303;
      res.setHeader('location', '/alerts/settings?error=' + encodeURIComponent('All three thresholds must be non-negative numbers.'));
      res.end();
      return;
    }
    if (clearThreshold >= majorThreshold || clearThreshold >= altThreshold) {
      res.statusCode = 303;
      res.setHeader('location', '/alerts/settings?error=' + encodeURIComponent('Exit threshold must be lower than both entry thresholds, or entries would clear immediately.'));
      res.end();
      return;
    }
    alertSettings = { majorThreshold, altThreshold, clearThreshold, majors };
    saveAlertSettings(alertSettings);
    res.statusCode = 303;
    res.setHeader('location', '/alerts/settings?saved=1');
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/front-perp') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    if (latest) res.end(frontPerpPageHTML(latest, loadPositions(), loadHidden()));
    else res.end('<p>loading… <a href="/">back to dashboard</a></p>');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/front-back') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    if (latest) res.end(frontBackPageHTML(latest, loadPositions(), loadHidden()));
    else res.end('<p>loading… <a href="/">back to dashboard</a></p>');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/term-structure') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    if (latest) res.end(termStructurePageHTML(latest, loadPositions(), loadHidden()));
    else res.end('<p>loading… <a href="/">back to dashboard</a></p>');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/my-positions') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    if (!latest) { res.end('<p>loading… <a href="/">back to dashboard</a></p>'); return; }
    res.end(myPositionsPageHTML(latest, (url.searchParams.get('err') || '').slice(0, 300)));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/my-positions/save') {
    const body = parseFormBody(await readBody(req));
    const back = (err) => {
      res.statusCode = 303;
      res.setHeader('location', '/my-positions' + (err ? '?err=' + encodeURIComponent(err) : ''));
      res.end();
    };
    if (!latest) return back('Market data is still loading — try again in a few seconds.');
    const positions = myPos.loadMyPositions(MY_POSITIONS_PATH);
    if (body.id) {
      const idx = positions.findIndex(p => p.id === body.id);
      if (idx < 0) return back('That position no longer exists.');
      const r = myPos.buildPosition(body, latest.rows, positions[idx]);
      if (r.error) return back(r.error);
      positions[idx] = r.position;
    } else {
      if (positions.length >= myPos.MAX_POSITIONS) return back(`Limit of ${myPos.MAX_POSITIONS} positions reached.`);
      const r = myPos.buildPosition(body, latest.rows);
      if (r.error) return back(r.error);
      positions.push(r.position);
    }
    try { myPos.saveMyPositions(MY_POSITIONS_PATH, positions); }
    catch (e) { return back('Could not save: ' + e.message); }
    return back(null);
  }

  if (req.method === 'POST' && url.pathname === '/my-positions/delete') {
    const body = parseFormBody(await readBody(req));
    const positions = myPos.loadMyPositions(MY_POSITIONS_PATH).filter(p => p.id !== body.id);
    try { myPos.saveMyPositions(MY_POSITIONS_PATH, positions); } catch (e) { console.warn('[cde-basis] delete position failed:', e.message); }
    res.statusCode = 303; res.setHeader('location', '/my-positions'); res.end();
    return;
  }

  if (url.pathname === '/api/my-positions') {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    const evals = latest ? myPos.rankEvaluated(myPos.evaluateAll(myPos.loadMyPositions(MY_POSITIONS_PATH), latest.rows)) : [];
    res.end(JSON.stringify({ positions: evals, summary: myPos.summarize(evals) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/bidask') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    if (!latest) { res.end('<p>loading… <a href="/">back to dashboard</a></p>'); return; }
    try {
      res.end(await bidAskPageHTML(latest, loadHidden(), (url.searchParams.get('pair') || 'ALL').toUpperCase()));
    } catch (e) {
      res.statusCode = 500;
      res.end(`<p>Bid/Ask page failed: ${e.message}</p>`);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/volume') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    res.end(volumePageHTML(loadHidden()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/calibration') {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    try {
      res.end(await calibrationPageHTML());
    } catch (e) {
      res.statusCode = 500;
      res.end(`<p>Calibration failed: ${e.message}</p>`);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/volume.csv') {
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="cde_volume_summary.csv"');
    res.setHeader('cache-control', 'no-store');
    res.end(volumeCSV());
    return;
  }

  if (url.pathname === '/health') { res.end('ok'); return; }

  if (req.method === 'POST' && url.pathname === '/positions/pin') {
    const body = parseFormBody(await readBody(req));
    const root = (body.root || '').toUpperCase().trim();
    if (root) {
      const row = latest ? latest.rows.find(r => r.root === root) : null;
      const zRec = latestStats && latestStats.stats[root] ? latestStats.stats[root].div : null;
      const positions = loadPositions();
      // Don't clobber an existing entry if already tracked (e.g. accidental
      // double-submit) — first pin wins as "the" entry point.
      if (!positions[root]) {
        positions[root] = {
          addedAt: new Date().toISOString(),
          entryDiv: row ? row.divergence : null,
          entryZ: zRec ? zRec.z : null,
        };
        savePositions(positions);
      }
    }
    res.statusCode = 303;
    res.setHeader('location', req.headers.referer || '/');
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/positions/unpin') {
    const body = parseFormBody(await readBody(req));
    const root = (body.root || '').toUpperCase().trim();
    if (root) {
      const positions = loadPositions();
      delete positions[root];
      savePositions(positions);
    }
    res.statusCode = 303;
    res.setHeader('location', req.headers.referer || '/');
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/hide') {
    const body = parseFormBody(await readBody(req));
    const root = (body.root || '').toUpperCase().trim();
    if (root) {
      const hidden = loadHidden();
      if (!hidden[root]) {
        hidden[root] = { hiddenAt: new Date().toISOString() };
        saveHidden(hidden);
      }
    }
    res.statusCode = 303;
    res.setHeader('location', req.headers.referer || '/');
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/unhide') {
    const body = parseFormBody(await readBody(req));
    const root = (body.root || '').toUpperCase().trim();
    if (root) {
      const hidden = loadHidden();
      delete hidden[root];
      saveHidden(hidden);
    }
    res.statusCode = 303;
    res.setHeader('location', req.headers.referer || '/');
    res.end();
    return;
  }

  if (url.pathname === '/api/positions') {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(loadPositions()));
    return;
  }

  if (url.pathname === '/api/hidden') {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(loadHidden()));
    return;
  }

  res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store');
  if (latest) {
    const sortMode = url.searchParams.get('sort') || undefined; // let html() apply its own default
    const positions = loadPositions();
    const hidden = loadHidden();
    res.end(html(latest, { sortMode, positions, hidden }));
  } else {
    res.end('<p>loading…</p>');
  }
});

// ---- Why-did-it-stop diagnostics -------------------------------------------
// A silent return to the prompt is hard to debug, so say what ended the process.
function installDiagnostics() {
  const ts = () => new Date().toISOString();
  const mem = () => { const m = process.memoryUsage(); return `rss=${(m.rss / 1048576).toFixed(0)}MB heap=${(m.heapUsed / 1048576).toFixed(0)}MB`; };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => { console.log(`[${ts()}] [cde-basis] received ${sig} (${mem()}), shutting down`); process.exit(0); }); } catch (e) { /* signal not supported on this OS */ }
  }
  process.on('uncaughtException', (e) => { console.error(`[${ts()}] [cde-basis] UNCAUGHT EXCEPTION (${mem()}):`, e && e.stack || e); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error(`[${ts()}] [cde-basis] UNHANDLED REJECTION (kept running):`, e && e.stack || e); });
  process.on('beforeExit', (code) => { console.error(`[${ts()}] [cde-basis] event loop became empty (code ${code}, ${mem()}) - nothing left to run`); });
  process.on('exit', (code) => { console.error(`[${ts()}] [cde-basis] process exiting with code ${code} (${mem()})`); });
  // Heartbeat so a log shows the monitor was alive, and memory growth over time.
  setInterval(() => console.log(`[${ts()}] [cde-basis] alive ${mem()} lastError=${lastError || 'none'}`), 10 * 60_000).unref();
}

async function start() {
  installDiagnostics();
  console.log(`[cde-basis] port=${PORT} poll=${POLL_MS}ms once=${ONCE} dryrun=${DRYRUN} statsWindowDays=${STATS_WINDOW_DAYS}`);
  console.log(`[cde-basis] alerts: majors=[${alertSettings.majors.join(',')}] majorThreshold=${alertSettings.majorThreshold}% altThreshold=${alertSettings.altThreshold}% (editable at /alerts/settings) telegram=${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'configured' : 'NOT CONFIGURED (console-only)'}`);
  console.log(`[cde-basis] log=${LOG_PATH}`);

  try {
    const rot = await rotateLogIfNeeded(LOG_PATH, MAX_ACTIVE_LOG_DAYS);
    if (rot.rotated) {
      console.log(`[cde-basis] rotated log: kept ${rot.kept} recent polls, archived ${rot.archived} older polls to ${rot.archivePath}${rot.corrupt ? ` (${rot.corrupt} corrupt lines dropped)` : ''}`);
    }
  } catch (e) {
    console.warn('[cde-basis] log rotation check failed (continuing anyway):', e.message);
  }

  await runCheck();
  if (ONCE) { console.log('[cde-basis] --once: exiting after one poll'); process.exit(0); }
  server.listen(PORT, '127.0.0.1', () => console.log(`[cde-basis] dashboard http://localhost:${PORT}`));
  setInterval(() => runCheck().catch(e => console.warn('poll error:', e.message)), POLL_MS);
  setInterval(warmBooks, Math.round(BOOK_TTL_MS / 2));
  setInterval(() => {
    rotateLogIfNeeded(LOG_PATH, MAX_ACTIVE_LOG_DAYS)
      .then(rot => { if (rot.rotated) console.log(`[cde-basis] rotated log: kept ${rot.kept}, archived ${rot.archived}`); })
      .catch(e => console.warn('[cde-basis] periodic rotation check failed:', e.message));
  }, 24 * 3600_000);
}

if (require.main === module) start();
else module.exports = {
  runCheck, buildSnapshot, fetchJSON, server, applyStaleFlags, checkAlerts,
  _setLatestForTest: (s) => { latest = s; },
  _setLatestStatsForTest: (s) => { latestStats = s; },
  _resetStaleStateForTest: () => { for (const k of Object.keys(lastMid)) delete lastMid[k]; },
  _resetAlertStateForTest: () => { alertState.clear(); },
  _getAlertStateForTest: () => new Map(alertState),
  _setSendTelegramAlertForTest: (fn) => { sendTelegramAlert = fn; },
};
