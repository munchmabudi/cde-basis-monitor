// analysis/cde_basis_stats.js
//
// Reads data/cde_basis_LOG.jsonl (append-only, one line per poll, written by
// analysis/cde_basis.js#logPoll) and turns it into per-token historical stats:
// mean, sample stdev, z-score of the latest reading, min/max, and percentiles,
// for each of the logged metrics (bApy, fApy, gap, aD, aP, div).
//
// Pure functions + a thin fs reader, so the math is unit-testable without a
// real log file on disk.

const fs = require('fs');
const readline = require('readline');
const { SANITY_CAP_PCT } = require('./cde_basis');

const METRICS = ['bApy', 'fApy', 'gap', 'aD', 'aP', 'div', 'bkApy', 'term', 'bpApy', 'frontVol', 'backVol'];
// SANITY_CAP_PCT guards against broken annualized-percentage readings (see
// cde_basis.js). It does NOT apply to volume, which is dollar-denominated —
// a real $5M reading isn't "suspect" just because it's a big number.
const PCT_METRICS = ['bApy', 'fApy', 'gap', 'aD', 'aP', 'div', 'bkApy', 'term', 'bpApy'];
const MIN_N_FOR_Z = 5; // fewer points than this -> z is not meaningful yet

// ---- log I/O ----
// Reads the JSONL file line-by-line (tolerant of a trailing partial line from
// a poll that was interrupted mid-write) and returns parsed entries in file
// order: [{ t: ISOString, tokens: { ROOT: {v,bApy,fApy,gap,aD,aP,div,fl} } }, ...]
async function loadLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const entries = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip a truncated/corrupt line (e.g. process killed mid-append) rather
      // than aborting the whole read
    }
  }
  return entries;
}

// Synchronous variant for callers that already have the file read into memory
// or want a blocking read (e.g. a CLI script). Same tolerance for bad lines.
function loadLogSync(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip corrupt/truncated line
    }
  }
  return entries;
}

// ---- reshape: log entries -> per-root, per-metric time series ----
// series[root][metric] = [{t, v}, ...] in chronological order, nulls dropped.
function buildSeries(entries, opts = {}) {
  const sinceMs = opts.sinceMs ?? null; // optional lower bound (Date.now() - windowMs)
  const series = {};
  for (const entry of entries) {
    const t = entry.t;
    const tMs = Date.parse(t);
    if (sinceMs != null && !isNaN(tMs) && tMs < sinceMs) continue;
    const tokens = entry.tokens || {};
    for (const [root, rec] of Object.entries(tokens)) {
      if (!series[root]) {
        series[root] = { frontExpiry: [] };
        for (const m of METRICS) series[root][m] = [];
      }
      for (const m of METRICS) {
        const v = rec[m];
        // Retroactive guard: even though logPoll now avoids WRITING values
        // this extreme, older entries logged before this fix (or written by
        // a different process) can still contain broken near-zero-Tms or
        // bad-tick spikes. Drop them on READ so existing corrupted history
        // stops skewing mean/stdev/z-score and charts immediately, without
        // waiting for the window to age the bad point out.
        if (v != null && !isNaN(v) && (!PCT_METRICS.includes(m) || Math.abs(v) <= SANITY_CAP_PCT)) series[root][m].push({ t, v });
      }
      // Metadata only — a string (contract expiry date), not a number, so it
      // stays out of METRICS entirely and rollup() never sees it. Used only
      // to detect and mark roll boundaries on charts.
      if (rec.frontExpiry != null) series[root].frontExpiry.push({ t, v: rec.frontExpiry });
    }
  }
  return series;
}

// ---- stats primitives ----
function mean(vals) {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
// sample standard deviation (n-1 denominator); null if fewer than 2 points
function stdev(vals, m) {
  if (vals.length < 2) return null;
  const mu = m ?? mean(vals);
  const variance = vals.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (vals.length - 1);
  return Math.sqrt(variance);
}
function percentile(sortedVals, p) {
  if (!sortedVals.length) return null;
  if (sortedVals.length === 1) return sortedVals[0];
  const idx = (p / 100) * (sortedVals.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedVals[lo];
  const frac = idx - lo;
  return sortedVals[lo] + (sortedVals[hi] - sortedVals[lo]) * frac;
}

// ---- per-root, per-metric rollup ----
// stats(root)[metric] = { n, latest, latestT, mean, std, z, min, max, p10, p50, p90 }
// z = (latest - mean) / std, computed against the FULL provided window
// (including the latest point itself) — i.e. "how many stdevs from its own
// window's average is the most recent reading". null when std is null/0 or
// n < MIN_N_FOR_Z (too little history to trust a z-score yet).
function rollup(series) {
  const out = {};
  for (const [root, metrics] of Object.entries(series)) {
    out[root] = {};
    for (const m of METRICS) {
      const points = metrics[m] || [];
      const vals = points.map(p => p.v);
      const n = vals.length;
      if (n === 0) {
        out[root][m] = { n: 0, latest: null, latestT: null, mean: null, std: null, z: null, min: null, max: null, p10: null, p50: null, p90: null };
        continue;
      }
      const latestPoint = points[points.length - 1];
      const mu = mean(vals);
      const sd = stdev(vals, mu);
      const sorted = [...vals].sort((a, b) => a - b);
      const z = (n >= MIN_N_FOR_Z && sd != null && sd > 0) ? (latestPoint.v - mu) / sd : null;
      out[root][m] = {
        n, latest: latestPoint.v, latestT: latestPoint.t,
        mean: mu, std: sd, z,
        min: sorted[0], max: sorted[sorted.length - 1],
        p10: percentile(sorted, 10), p50: percentile(sorted, 50), p90: percentile(sorted, 90),
      };
    }
  }
  return out;
}

// ---- streaming log scan (memory-safe) ----
// The old path parsed EVERY line of the log into objects and held them all
// (plus a {t,v} object per data point) just to compute a handful of numbers,
// every 30s, twice. With weeks of history that is gigabytes of heap and ends in
// a fatal out-of-memory crash. These helpers read the file in chunks, keep
// nothing but bare numbers, and only parse lines inside the requested window.

// Calls onLine(str) for each COMPLETE (newline-terminated) line starting at
// byte `startOffset`. Resolves to the byte offset just after the last complete
// line, so a later call can continue from there (incremental reads).
function scanLines(logPath, startOffset, onLine) {
  return new Promise((resolve, reject) => {
    let size;
    try { size = fs.statSync(logPath).size; } catch (e) { return e.code === 'ENOENT' ? resolve(0) : reject(e); }
    if (startOffset >= size) return resolve(startOffset);
    let offset = startOffset;       // bytes consumed through last complete line
    let carry = Buffer.alloc(0);
    const rs = fs.createReadStream(logPath, { start: startOffset, end: size - 1, highWaterMark: 1 << 20 });
    rs.on('error', reject);
    rs.on('data', (chunk) => {
      let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let from = 0, nl;
      while ((nl = buf.indexOf(10, from)) !== -1) {
        const line = buf.toString('utf8', from, nl);
        offset += (nl - from) + 1;
        from = nl + 1;
        onLine(line);
      }
      carry = from < buf.length ? Buffer.from(buf.subarray(from)) : Buffer.alloc(0);
    });
    rs.on('end', () => resolve(offset));
  });
}

const T_PREFIX = /^\s*\{\s*"t"\s*:\s*"([^"]+)"/;
// Parse a line only if it could be inside the window. Returns the entry,
// null for blank/corrupt lines, or undefined for "valid but too old, skipped".
function parseLineInWindow(line, sinceMs) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (sinceMs != null) {
    const m = T_PREFIX.exec(trimmed);
    if (m) { const tMs = Date.parse(m[1]); if (!isNaN(tMs) && tMs < sinceMs) return undefined; }
  }
  try { return JSON.parse(trimmed); } catch { return null; }
}

function newAcc() { return { vals: {}, latestT: {}, polls: 0 }; }
function ingestEntry(acc, entry, sinceMs) {
  const t = entry.t, tMs = Date.parse(t);
  if (sinceMs != null && !isNaN(tMs) && tMs < sinceMs) return;
  for (const [root, rec] of Object.entries(entry.tokens || {})) {
    let r = acc.vals[root];
    if (!r) { r = acc.vals[root] = {}; acc.latestT[root] = {}; for (const m of METRICS) r[m] = []; }
    for (const m of METRICS) {
      const v = rec[m];
      if (v != null && !isNaN(v) && (!PCT_METRICS.includes(m) || Math.abs(v) <= SANITY_CAP_PCT)) { r[m].push(v); acc.latestT[root][m] = t; }
    }
  }
}

const PCT_SAMPLE_CAP = 30000; // percentiles come from an even sample above this many points
function summarize(vals, latestT) {
  const n = vals.length;
  if (n === 0) return { n: 0, latest: null, latestT: null, mean: null, std: null, z: null, min: null, max: null, p10: null, p50: null, p90: null };
  let sum = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) { const v = vals[i]; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; }
  const mu = sum / n;
  let sd = null;
  if (n >= 2) { let acc = 0; for (let i = 0; i < n; i++) acc += (vals[i] - mu) ** 2; sd = Math.sqrt(acc / (n - 1)); }
  let sample = vals;
  if (n > PCT_SAMPLE_CAP) { const step = n / PCT_SAMPLE_CAP; sample = new Array(PCT_SAMPLE_CAP); for (let i = 0; i < PCT_SAMPLE_CAP; i++) sample[i] = vals[Math.floor(i * step)]; }
  const sorted = Float64Array.from(sample).sort();
  const latest = vals[n - 1];
  const z = (n >= MIN_N_FOR_Z && sd != null && sd > 0) ? (latest - mu) / sd : null;
  return { n, latest, latestT: latestT || null, mean: mu, std: sd, z, min: mn, max: mx,
    p10: percentile(sorted, 10), p50: percentile(sorted, 50), p90: percentile(sorted, 90) };
}
function rollupAcc(acc) {
  const out = {};
  for (const [root, metrics] of Object.entries(acc.vals)) {
    out[root] = {};
    for (const m of METRICS) out[root][m] = summarize(metrics[m], acc.latestT[root][m]);
  }
  return out;
}

// ---- convenience: log file -> full stats in one call ----
// opts.windowDays: only include polls from the last N days (default: all history)
// The accumulated numbers are cached per (file, window): each call reads only
// the bytes appended since the last one, and everything is rebuilt from scratch
// every 30 minutes (ages old points out of the window) or if the file shrank
// (log rotation). Calls for the same key are serialized.
const REBUILD_MS = 30 * 60_000;
const _statsCache = new Map();
async function statsFromLog(logPath, opts = {}) {
  const key = logPath + '|' + (opts.windowDays ?? 'all');
  let st = _statsCache.get(key);
  if (!st) { st = { acc: null, offset: 0, builtAt: 0, polls: 0, result: null, resultOffset: -1, chain: Promise.resolve() }; _statsCache.set(key, st); }
  const run = st.chain.then(async () => {
    let size = 0;
    try { size = fs.statSync(logPath).size; } catch { size = 0; }
    const now = Date.now();
    if (!st.acc || size < st.offset || now - st.builtAt > REBUILD_MS) {
      st.acc = newAcc(); st.offset = 0; st.polls = 0; st.builtAt = now; st.result = null;
    }
    const sinceMs = opts.windowDays != null ? now - opts.windowDays * 86_400_000 : null;
    st.offset = await scanLines(logPath, st.offset, (line) => {
      const e = parseLineInWindow(line, sinceMs);
      if (e === null) return;
      st.polls++;
      if (e !== undefined) ingestEntry(st.acc, e, sinceMs);
    });
    if (!st.result || st.resultOffset !== st.offset) {
      st.result = { generatedAt: new Date().toISOString(), n: st.polls, windowDays: opts.windowDays ?? null, stats: rollupAcc(st.acc) };
      st.resultOffset = st.offset;
    }
    return st.result;
  });
  st.chain = run.catch(() => {});
  return run;
}

// history for a single root/metric, for charting — returns [{t, v}, ...]
// Streams the log and keeps only this one token's points.
async function historyFor(logPath, root, opts = {}) {
  const sinceMs = opts.windowDays != null ? Date.now() - opts.windowDays * 86_400_000 : null;
  const out = {}; for (const m of METRICS) out[m] = [];
  out.frontExpiry = [];
  await scanLines(logPath, 0, (line) => {
    const e = parseLineInWindow(line, sinceMs);
    if (!e) return;
    const tMs = Date.parse(e.t);
    if (sinceMs != null && !isNaN(tMs) && tMs < sinceMs) return;
    const rec = e.tokens && e.tokens[root];
    if (!rec) return;
    for (const m of METRICS) {
      const v = rec[m];
      if (v != null && !isNaN(v) && (!PCT_METRICS.includes(m) || Math.abs(v) <= SANITY_CAP_PCT)) out[m].push({ t: e.t, v });
    }
    if (rec.frontExpiry != null) out.frontExpiry.push({ t: e.t, v: rec.frontExpiry });
  });
  return out;
}

module.exports = {
  METRICS, MIN_N_FOR_Z,
  loadLog, loadLogSync, buildSeries, scanLines, parseLineInWindow,
  mean, stdev, percentile, rollup,
  statsFromLog, historyFor,
};
