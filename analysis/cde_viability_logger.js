// analysis/cde_viability_logger.js
// Append-only viability logger for the CDE MM SIM.
//
// Each poll writes ONE JSON line:
//   { t: ISO, tokens: { ASSETKEY: { s:'ok'|'nodata', b:<bothProfitable>, e:<eitherProfitable> } } }
//   s='ok'     -> sim ran; b/e are booleans (both/either sides net>0)
//   s='nodata' -> token skipped this poll (no ref/hedge data) -> NOT counted as "not viable"
//
// Denominator policy for %: only 'ok' polls count. A 'nodata' poll is "unknown",
// never "not viable", so it can't drag a token's viability % down unfairly.
//
// Retention: prune entries older than RETAIN_MS (8d) so the 7d window always has
// data and the file never grows unbounded.
//
// rollup(windowMs): per-token and overall % both-profitable / either-profitable
// over the trailing window. Pure file read — safe to call from the HTML generator.
//
// Logging NEVER throws into the caller (monitor). Every fs op is guarded.
// Override log path with env CDE_VIAB_LOG (used by tests / isolated runs).

const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.CDE_VIAB_LOG
  ? path.resolve(process.env.CDE_VIAB_LOG)
  : path.join(__dirname, '..', 'data', 'cde_viability_LOG.jsonl');

const RETAIN_MS = 8 * 24 * 60 * 60 * 1000; // 8 days (covers 7d window + 1d margin)
const PRUNE_EVERY = 720;                    // prune roughly every 12h at a 1-min poll

let _polls = 0;

function _append(obj) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.warn('[viability-logger] append failed:', e.message);
  }
}

function _pruneIfNeeded() {
  _polls++;
  if (_polls % PRUNE_EVERY !== 0) return;
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const cutoff = Date.now() - RETAIN_MS;
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const kept = [];
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.t && new Date(o.t).getTime() >= cutoff) kept.push(l);
      } catch { /* drop corrupt line */ }
    }
    if (kept.length !== lines.length) fs.writeFileSync(LOG_PATH, kept.join('\n') + '\n');
  } catch (e) {
    console.warn('[viability-logger] prune failed:', e.message);
  }
}

// results: array shaped like monitor_cde runCheck() `results`:
//   each entry { assetKey, cdeCfg, sim }  (sim may be null when skipped)
function logPoll(results, ts = new Date().toISOString()) {
  try {
    const tokens = {};
    for (const r of (results || [])) {
      if (r && r.sim && r.sim.scenarioA) {
        const a = r.sim.scenarioA;
        tokens[r.assetKey] = { s: 'ok', b: !!a.bothProfitable, e: !!a.eitherProfitable };
      } else {
        tokens[r.assetKey] = { s: 'nodata' };
      }
    }
    _append({ t: ts, tokens });
    _pruneIfNeeded();
  } catch (e) {
    console.warn('[viability-logger] logPoll failed:', e.message);
  }
}

function rollup(windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  const perToken = {};
  let overallOk = 0, overallBoth = 0, overallEither = 0;
  try {
    if (!fs.existsSync(LOG_PATH)) {
      return { generatedAt: new Date().toISOString(), windowMs, empty: true, perToken, overall: null };
    }
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      let entry;
      try { entry = JSON.parse(l); } catch { continue; }
      const et = entry.t ? new Date(entry.t).getTime() : NaN;
      if (isNaN(et) || et < cutoff) continue;
      for (const [k, v] of Object.entries(entry.tokens || {})) {
        if (v.s !== 'ok') continue;
        const t = perToken[k] || (perToken[k] = { ok: 0, both: 0, either: 0 });
        t.ok++; overallOk++;
        if (v.b) { t.both++; overallBoth++; }
        if (v.e) { t.either++; overallEither++; }
      }
    }
  } catch (e) {
    console.warn('[viability-logger] rollup read failed:', e.message);
  }
  const pct = (n, d) => (d > 0 ? +(100 * n / d).toFixed(2) : null);
  const out = {};
  for (const [k, t] of Object.entries(perToken)) {
    out[k] = { ok: t.ok, bothPct: pct(t.both, t.ok), eitherPct: pct(t.either, t.ok) };
  }
  const overall = overallOk > 0
    ? { ok: overallOk, bothPct: pct(overallBoth, overallOk), eitherPct: pct(overallEither, overallOk) }
    : null;
  return { generatedAt: new Date().toISOString(), windowMs, perToken: out, overall };
}

module.exports = { logPoll, rollup, LOG_PATH };
