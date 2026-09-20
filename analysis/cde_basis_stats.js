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
// In-memory cache: re-reads the file only when its mtime or size changes on
// disk. Within a single poll cycle, statsFromLog is called many times in quick
// succession (once per token×pair for z-score lookups, plus once for the
// dashboard cache) — without this cache each call re-reads and re-parses the
// ENTIRE JSONL log, which is O(N) per call and O(N²) per cycle. The cache
// turns that into O(N) once per cycle.
let logCache = { path: null, mtimeMs: null, entries: [] };

async function loadLog(logPath) {
  if (!fs.existsSync(logPath)) {
    logCache = { path: null, mtimeMs: null, entries: [] };
    return [];
  }
  const stat = fs.statSync(logPath);
  if (logCache.path === logPath && logCache.mtimeMs === stat.mtimeMs && logCache.entries !== null) {
    return logCache.entries;
  }
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
  logCache = { path: logPath, mtimeMs: stat.mtimeMs, entries };
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

// ---- convenience: log file -> full stats in one call ----
// opts.windowDays: only include polls from the last N days (default: all history)
async function statsFromLog(logPath, opts = {}) {
  const entries = await loadLog(logPath);
  const sinceMs = opts.windowDays != null ? Date.now() - opts.windowDays * 86_400_000 : null;
  const series = buildSeries(entries, { sinceMs });
  return { generatedAt: new Date().toISOString(), n: entries.length, windowDays: opts.windowDays ?? null, stats: rollup(series) };
}

// history for a single root/metric, for charting — returns [{t, v}, ...]
async function historyFor(logPath, root, opts = {}) {
  const entries = await loadLog(logPath);
  const sinceMs = opts.windowDays != null ? Date.now() - opts.windowDays * 86_400_000 : null;
  const series = buildSeries(entries, { sinceMs });
  const metrics = series[root] || {};
  const out = {};
  for (const m of METRICS) out[m] = metrics[m] || [];
  out.frontExpiry = metrics.frontExpiry || [];
  return out;
}

module.exports = {
  METRICS, MIN_N_FOR_Z,
  loadLog, loadLogSync, buildSeries,
  mean, stdev, percentile, rollup,
  statsFromLog, historyFor,
  _purgeLogCache: () => { logCache = { path: null, mtimeMs: null, entries: [] }; },
};
