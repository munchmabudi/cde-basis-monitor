// analysis/cde_spread_history.js
//
// Price-terms history of the front-dated-future vs perp spread for one token,
// read from data/cde_basis_LOG.jsonl.
//
//   mid  = future mid  - perp mid
//   bid  = future bid  - perp bid      (same side on both legs: the price you quote and hedge against)
//   ask  = future ask  - perp ask
//   *Pct = the same, as a percent of the index price
//
// The price fields (fm, pm, ix, fb, fa, pb, pa) are written by logPoll from the
// poll that added this feature onward. Before that the log only has the derived
// APY fields, so for older polls the MID spread is recovered as a percent of
// index from aD - gap (dated all-in % minus perp gap %, which is exactly
// (F - P) / index). Older polls therefore appear in the "% of index" view only.
//
// Two things keep this cheap on a log that can reach gigabytes:
//   - the window start is found by binary search on byte offsets (each line
//     starts with its timestamp), so a 24 hour view reads about a day of data
//     instead of the whole file;
//   - only the requested token's record is parsed, not the whole line.

const fs = require('fs');
const { scanLines } = require('./cde_basis_stats');

const T_PREFIX = /^\s*\{\s*"t"\s*:\s*"([^"]+)"/;
const PROBE_BYTES = 65536;         // lines are ~10 KB, so one chunk always holds a line start
const SEEK_SLACK_BYTES = 262144;   // stop narrowing when this close; the scan skips the rest by prefix
const STALE_FLAGS = new Set(['STALE', 'STALE_FRONT', 'STALE_PERP', 'SUSPECT']);
const BANDS_MAX_WINDOW_DAYS = 7;

// Timestamp of the first complete line that starts at or after byte `pos`
// (or at 0 when pos is 0). Returns { lineStart, tMs } or null.
function probe(fd, size, pos) {
  const buf = Buffer.alloc(PROBE_BYTES);
  const got = fs.readSync(fd, buf, 0, PROBE_BYTES, pos);
  if (got <= 0) return null;
  let start = 0;
  if (pos > 0) {
    const nl = buf.indexOf(10, 0);
    if (nl === -1 || nl + 1 >= got) return null;
    start = nl + 1;
  }
  const head = buf.toString('utf8', start, Math.min(got, start + 80));
  const m = T_PREFIX.exec(head);
  if (!m) return null;
  const tMs = Date.parse(m[1]);
  return isNaN(tMs) ? null : { lineStart: pos + start, tMs };
}

// Byte offset of a line start at or before the first line with t >= sinceMs.
// Always returns a real line start (0 or the start of a probed line), so the
// scan that follows begins on a line boundary.
function findStartOffset(logPath, sinceMs) {
  let size;
  try { size = fs.statSync(logPath).size; } catch { return 0; }
  if (size <= SEEK_SLACK_BYTES) return 0;
  const fd = fs.openSync(logPath, 'r');
  try {
    let lo = 0, hi = size;
    while (hi - lo > SEEK_SLACK_BYTES) {
      const mid = Math.floor((lo + hi) / 2);
      const p = probe(fd, size, mid);
      if (p && p.tMs < sinceMs) lo = p.lineStart;   // everything before this line is older than the window
      else hi = mid;                                // this line is in the window (or there is none after mid)
    }
    return lo;
  } finally {
    fs.closeSync(fd);
  }
}

const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
const r9 = (v) => v == null ? null : +v.toPrecision(9);

function summarize(vals) {
  const v = vals.filter(x => x != null);
  const n = v.length;
  if (!n) return { n: 0, latest: null, mean: null, std: null, z: null, min: null, max: null };
  let sum = 0, mn = Infinity, mx = -Infinity;
  for (const x of v) { sum += x; if (x < mn) mn = x; if (x > mx) mx = x; }
  const mean = sum / n;
  let std = null;
  if (n >= 2) { let a = 0; for (const x of v) a += (x - mean) ** 2; std = Math.sqrt(a / (n - 1)); }
  const latest = v[n - 1];
  const z = (n >= 5 && std != null && std > 0) ? (latest - mean) / std : null;
  return { n, latest: r9(latest), mean: r9(mean), std: r9(std), z: z == null ? null : +z.toFixed(4), min: r9(mn), max: r9(mx) };
}

// opts: { windowDays, maxPoints, horizonOverride, tick, nowMs }
// horizonOverride: the monitor was started with --horizon-days, so aD is scaled
//   by that horizon and aD - gap no longer equals the spread; skip the backfill.
async function spreadHistoryFor(logPath, root, opts = {}) {
  const windowDays = opts.windowDays > 0 ? opts.windowDays : 1;
  const maxPoints = opts.maxPoints > 100 ? opts.maxPoints : 4000;
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = nowMs - windowDays * 86_400_000;
  const startOffset = findStartOffset(logPath, sinceMs);
  const needle = '"' + root + '":{';

  const T = [], MID = [], BID = [], ASK = [], MIDP = [], BIDP = [], ASKP = [], IX = [], EXP = [];

  await scanLines(logPath, startOffset, (line) => {
    const m = T_PREFIX.exec(line);
    if (!m) return;
    const tMs = Date.parse(m[1]);
    if (isNaN(tMs) || tMs < sinceMs || tMs > nowMs + 60_000) return;
    const i = line.indexOf(needle);
    if (i < 0) return;
    const open = i + needle.length - 1;
    const j = line.indexOf('}', open);          // a token record holds no nested objects
    if (j < 0) return;
    let rec;
    try { rec = JSON.parse(line.slice(open, j + 1)); } catch { return; }

    const fl = Array.isArray(rec.fl) ? rec.fl : [];
    const frozen = fl.some(f => STALE_FLAGS.has(f));      // halted or glitched: don't draw a flat or bogus spread

    let mid = null, bid = null, ask = null, midP = null, bidP = null, askP = null;
    const fm = num(rec.fm), pm = num(rec.pm), ix = num(rec.ix);
    const fb = num(rec.fb), fa = num(rec.fa), pb = num(rec.pb), pa = num(rec.pa);
    if (!frozen) {
      if (fm != null && pm != null) mid = fm - pm;
      if (fb != null && pb != null) bid = fb - pb;
      if (fa != null && pa != null) ask = fa - pa;
      if (ix != null && ix > 0) {
        if (mid != null) midP = mid / ix * 100;
        if (bid != null) bidP = bid / ix * 100;
        if (ask != null) askP = ask / ix * 100;
      }
      if (midP == null && mid == null && !opts.horizonOverride) {
        const aD = num(rec.aD), gap = num(rec.gap);
        if (aD != null && gap != null) midP = aD - gap;  // older poll: percent of index only
      }
    }
    T.push(tMs); MID.push(mid); BID.push(bid); ASK.push(ask);
    MIDP.push(midP); BIDP.push(bidP); ASKP.push(askP);
    IX.push(ix); EXP.push(rec.frontExpiry == null ? null : rec.frontExpiry);
  });

  const n = T.length;

  // The % of index backfill (aD - gap) comes from old log lines that were never
  // price-checked, so a bad tick shows up as a lone spike. Drop a backfilled point
  // that sits far from the median of its neighbours (Hampel filter, +/-3 polls).
  // Real price rows (fm/pm present) are never touched.
  {
    const idx = [];
    for (let i = 0; i < n; i++) if (MIDP[i] != null && MID[i] == null) idx.push(i);
    const vals = idx.map(i => MIDP[i]);
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
    const drop = [];
    for (let k = 0; k < idx.length; k++) {
      const w = vals.slice(Math.max(0, k - 3), Math.min(vals.length, k + 4));
      if (w.length < 5) continue;
      const m = med(w), mad = med(w.map(x => Math.abs(x - m)));
      if (Math.abs(vals[k] - m) > Math.max(0.15, 6 * 1.4826 * mad)) drop.push(idx[k]);
    }
    for (const i of drop) MIDP[i] = null;
  }

  // contract rolls: the front expiry changed between two polls
  const rolls = [];
  let lastExp = null, lastRollIdx = 0;
  for (let i = 0; i < n; i++) {
    const e = EXP[i];
    if (e == null) continue;
    if (lastExp != null && e !== lastExp) { rolls.push({ t: T[i], from: lastExp, to: e }); lastRollIdx = i; }
    lastExp = e;
  }

  // Stats cover only the current front contract (after the last roll in the
  // window): the level jumps at a roll, so a mean across two contracts mixes
  // two different spreads.
  const seg = (arr) => arr.slice(lastRollIdx);
  const stats = {
    px:  { mid: summarize(seg(MID)), bid: summarize(seg(BID)), ask: summarize(seg(ASK)) },
    pct: { mid: summarize(seg(MIDP)), bid: summarize(seg(BIDP)), ask: summarize(seg(ASKP)) },
    segmentFromT: n ? T[lastRollIdx] : null,
  };

  let firstPriceT = null, nPrice = 0;
  for (let i = 0; i < n; i++) if (MID[i] != null) { if (firstPriceT == null) firstPriceT = T[i]; nPrice++; }

  // Decimate for the browser. Priced rows (real bid/ask data) and backfilled rows
  // are thinned separately, each to about half the point budget, so a handful of
  // fresh priced polls are never swallowed by a bucket of old backfilled ones.
  const half = Math.floor(maxPoints / 2);
  const stepP = Math.max(1, Math.ceil(nPrice / half));
  const stepU = Math.max(1, Math.ceil((n - nPrice) / half));
  const step = Math.max(stepP, stepU);
  const pick = [];
  let cp = 0, cu = 0;
  for (let i = 0; i < n; i++) {
    if (MID[i] != null) { if (cp++ % stepP === 0 || i === n - 1) pick.push(i); }
    else { if (cu++ % stepU === 0 || i === n - 1) pick.push(i); }
  }
  const col = (arr) => pick.map(i => r9(arr[i]));

  return {
    root, windowDays, since: sinceMs, until: nowMs,
    tick: opts.tick ?? null,
    n, nPrice, firstPriceT, step,
    bandsOk: windowDays <= BANDS_MAX_WINDOW_DAYS,
    t: pick.map(i => T[i]),
    mid: col(MID), bid: col(BID), ask: col(ASK),
    midPct: col(MIDP), bidPct: col(BIDP), askPct: col(ASKP),
    ix: col(IX),
    rolls, stats,
  };
}

module.exports = { spreadHistoryFor, findStartOffset, summarize };
