// analysis/cde_basis_calibration.js
//
// Measures how the market has ACTUALLY behaved, straight from the same log
// the live dashboard already writes to (data/cde_basis_LOG.jsonl) — no new
// polling, no new data source. This exists to replace the Monte Carlo
// simulator's guessed parameters (arrival rate, persistence/half-life,
// correlation, roll frequency) with real measurements as history accumulates.
//
// Every estimator here is a genuine statistical calculation, not a
// heuristic — see test_calibration.js for ground-truth verification of each
// one against synthetic data with a known correct answer.

const { scanLines, parseLineInWindow } = require('./cde_basis_stats');

const PAIR_KEYS = ['div', 'term', 'bpApy']; // front-perp, front-back, back-perp

// ---- panel construction ----
// One row per logged poll, aligned by the SAME timestamp across all tokens
// (logPoll already writes one combined record per poll covering every
// token, so this is naturally aligned — no interpolation needed).
async function loadPanel(logPath, opts = {}) {
  // Streams the log and keeps ONLY the three pair columns per token (not whole
  // entries), so a long history doesn't exhaust memory.
  const sinceMs = opts.windowDays != null ? Date.now() - opts.windowDays * 86_400_000 : null;
  const rows = [];
  await scanLines(logPath, 0, (line) => {
    const e = parseLineInWindow(line, sinceMs);
    if (!e) return;
    const tMs = Date.parse(e.t);
    if (isNaN(tMs)) return;
    if (sinceMs != null && tMs < sinceMs) return;
    const tokens = {};
    for (const [root, rec] of Object.entries(e.tokens || {})) {
      const slim = {};
      for (const k of PAIR_KEYS) if (rec[k] != null) slim[k] = rec[k];
      tokens[root] = slim;
    }
    rows.push({ t: e.t, tMs, tokens });
  });
  rows.sort((a, b) => a.tMs - b.tMs);
  return rows;
}

// Extract one (token, pairKey) series as [{t, tMs, v}], nulls dropped.
function seriesFor(panel, root, pairKey) {
  const out = [];
  for (const row of panel) {
    const rec = row.tokens[root];
    const v = rec ? rec[pairKey] : null;
    if (v != null && !isNaN(v)) out.push({ t: row.t, tMs: row.tMs, v });
  }
  return out;
}

function allSeriesKeys(panel) {
  const roots = new Set();
  for (const row of panel) for (const root of Object.keys(row.tokens)) roots.add(root);
  const keys = [];
  for (const root of roots) for (const pairKey of PAIR_KEYS) keys.push({ root, pairKey });
  return keys;
}

// ---- 1. arrival rate: how often does |value| cross UP through a threshold ----
function countCrossings(series, threshold) {
  if (series.length === 0) return 0;
  let crossings = 0;
  // Initialize from the FIRST point's own state rather than `false` — the
  // very first observation can't be a "crossing" since there's no prior
  // point to transition from. Without this, a series that happens to start
  // already elevated (just an artifact of when logging began, not a real
  // event) would count as a spurious arrival.
  let wasAbove = Math.abs(series[0].v) >= threshold;
  for (let i = 1; i < series.length; i++) {
    const above = Math.abs(series[i].v) >= threshold;
    if (above && !wasAbove) crossings++;
    wasAbove = above;
  }
  return crossings;
}
function arrivalStats(panel, threshold) {
  const keys = allSeriesKeys(panel);
  const perSeries = [];
  for (const { root, pairKey } of keys) {
    const series = seriesFor(panel, root, pairKey);
    if (series.length < 2) continue;
    const spanDays = (series[series.length - 1].tMs - series[0].tMs) / 86_400_000;
    const crossings = countCrossings(series, threshold);
    perSeries.push({ root, pairKey, n: series.length, spanDays, crossings, perDay: spanDays > 0 ? crossings / spanDays : null });
  }
  // aggregate: how often does the CROSS-SECTIONAL MAX (best of all 51) cross
  // up through the threshold — this is "how often will we find A good trade"
  const maxSeries = panel.map(row => {
    let mx = null;
    for (const root of Object.keys(row.tokens)) {
      for (const pairKey of PAIR_KEYS) {
        const v = row.tokens[root][pairKey];
        if (v != null && !isNaN(v)) { const a = Math.abs(v); if (mx == null || a > mx) mx = a; }
      }
    }
    return { tMs: row.tMs, v: mx };
  }).filter(p => p.v != null);
  const spanDaysAgg = maxSeries.length > 1 ? (maxSeries[maxSeries.length - 1].tMs - maxSeries[0].tMs) / 86_400_000 : 0;
  const aggCrossings = countCrossings(maxSeries, threshold);
  return {
    perSeries,
    aggregate: { n: maxSeries.length, spanDays: spanDaysAgg, crossings: aggCrossings, perDay: spanDaysAgg > 0 ? aggCrossings / spanDaysAgg : null },
  };
}

// ---- 2. persistence: AR(1)-implied mean-reversion half-life ----
// Regresses X(t+dt) on X(t) using only consecutive LOGGED points whose gap
// is close to the typical poll interval — a big gap (an outage) would make
// the series look like it "reverted" instantly, which isn't real
// persistence, just missing data, so those pairs are excluded.
function halfLifeDays(series, opts = {}) {
  const maxGapMinutes = opts.maxGapMinutes ?? 5;
  const pairs = [];
  for (let i = 1; i < series.length; i++) {
    const gapMin = (series[i].tMs - series[i - 1].tMs) / 60000;
    if (gapMin > 0 && gapMin <= maxGapMinutes) pairs.push({ x: series[i - 1].v, y: series[i].v, dtDays: gapMin / 1440 });
  }
  if (pairs.length < 20) return { halfLifeDays: null, n: pairs.length, reason: 'not enough consecutive-poll pairs yet' };

  const meanX = pairs.reduce((s, p) => s + p.x, 0) / pairs.length;
  const meanY = pairs.reduce((s, p) => s + p.y, 0) / pairs.length;
  let num = 0, den = 0;
  for (const p of pairs) { num += (p.x - meanX) * (p.y - meanY); den += (p.x - meanX) ** 2; }
  const b = den !== 0 ? num / den : null;
  const avgDt = pairs.reduce((s, p) => s + p.dtDays, 0) / pairs.length;

  if (b == null || b <= 0 || b >= 1) {
    return { halfLifeDays: null, n: pairs.length, b, reason: b >= 1 ? 'no mean reversion detected in this window' : 'estimate unstable' };
  }
  const hl = (-Math.log(2) / Math.log(b)) * avgDt;
  // Known limitation: OLS on a near-unit-root series is biased toward
  // finding SOME mean reversion even when there's genuinely none (a true
  // random walk's true b=1, but finite-sample estimates land slightly below
  // 1 just from noise). A properly rigorous fix needs real unit-root testing
  // (e.g. an Augmented Dickey-Fuller test), which isn't implemented here —
  // instead, flag estimates where b is close to 1 as low-confidence rather
  // than presenting a precise-looking number that may just be noise.
  const lowConfidence = b > 0.97;
  return { halfLifeDays: hl, n: pairs.length, b, avgDtDays: avgDt, lowConfidence };
}
function persistenceStats(panel) {
  const keys = allSeriesKeys(panel);
  const perSeries = [];
  for (const { root, pairKey } of keys) {
    const series = seriesFor(panel, root, pairKey);
    const hl = halfLifeDays(series);
    if (hl.halfLifeDays != null) perSeries.push({ root, pairKey, ...hl });
  }
  perSeries.sort((a, b) => a.halfLifeDays - b.halfLifeDays);
  const vals = perSeries.map(s => s.halfLifeDays);
  const median = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  const mean = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
  const nLowConfidence = perSeries.filter(s => s.lowConfidence).length;
  return { perSeries, summary: { nEstimable: vals.length, nLowConfidence, medianHalfLifeDays: median, meanHalfLifeDays: mean } };
}

// ---- 3. episode duration: how long does a crossing actually last ----
function episodes(series, entryThreshold, exitThreshold) {
  const out = [];
  let inEpisode = false, start = null, lastInTime = null;
  for (const p of series) {
    const mag = Math.abs(p.v);
    if (!inEpisode && mag >= entryThreshold) {
      inEpisode = true; start = p.tMs; lastInTime = p.tMs;
    } else if (inEpisode) {
      if (mag < exitThreshold) {
        out.push({ startMs: start, endMs: lastInTime, durationDays: (lastInTime - start) / 86_400_000 });
        inEpisode = false;
      } else {
        lastInTime = p.tMs;
      }
    }
  }
  if (inEpisode) out.push({ startMs: start, endMs: lastInTime, durationDays: (lastInTime - start) / 86_400_000, stillOpen: true });
  return out;
}
function episodeStats(panel, entryThreshold, exitThreshold) {
  const keys = allSeriesKeys(panel);
  const all = [];
  for (const { root, pairKey } of keys) {
    const series = seriesFor(panel, root, pairKey);
    for (const ep of episodes(series, entryThreshold, exitThreshold)) all.push({ root, pairKey, ...ep });
  }
  const closed = all.filter(e => !e.stillOpen);
  const durations = closed.map(e => e.durationDays).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const mean = durations.length ? durations.reduce((s, x) => s + x, 0) / durations.length : null;
  return {
    episodes: all,
    summary: { nClosedEpisodes: closed.length, nStillOpen: all.length - closed.length, medianDurationDays: median, meanDurationDays: mean },
  };
}

// ---- 4. empirical roll frequency: replay the real roll rule against real history ----
function replayRolls(panel, opts) {
  const { entryThreshold, exitThreshold, assumedHoldDays, notional, leverage, makerFee, takerFee, contractsPerLeg } = opts;
  const roundTripCost = 2 * (makerFee + takerFee) * contractsPerLeg; // 2 maker + 2 taker legs
  const exposure = notional * leverage;

  let position = null; // { root, pairKey }
  let rolls = 0, entries = 0, exits = 0;
  const holdDurations = [];
  let lastTransitionMs = null;

  for (const row of panel) {
    let best = null;
    for (const root of Object.keys(row.tokens)) {
      for (const pairKey of PAIR_KEYS) {
        const v = row.tokens[root][pairKey];
        if (v == null || isNaN(v)) continue;
        const mag = Math.abs(v);
        if (!best || mag > best.mag) best = { root, pairKey, mag };
      }
    }
    if (!best) continue;
    let curMag = null;
    if (position) {
      const rec = row.tokens[position.root];
      const v = rec ? rec[position.pairKey] : null;
      curMag = v != null && !isNaN(v) ? Math.abs(v) : null;
    }

    if (!position) {
      if (best.mag >= entryThreshold) {
        position = { root: best.root, pairKey: best.pairKey };
        entries++;
        lastTransitionMs = row.tMs;
      }
    } else if (curMag != null) {
      const isSamePosition = best.root === position.root && best.pairKey === position.pairKey;
      const extraCarry = !isSamePosition ? ((best.mag - curMag) / 100) * exposure * (assumedHoldDays / 365) : -Infinity;
      if (!isSamePosition && extraCarry - roundTripCost > 0) {
        rolls++;
        if (lastTransitionMs != null) holdDurations.push((row.tMs - lastTransitionMs) / 86_400_000);
        lastTransitionMs = row.tMs;
        position = { root: best.root, pairKey: best.pairKey };
      } else if (curMag < exitThreshold && best.mag < entryThreshold) {
        exits++;
        if (lastTransitionMs != null) holdDurations.push((row.tMs - lastTransitionMs) / 86_400_000);
        position = null;
        lastTransitionMs = null;
      }
    }
  }

  const spanDays = panel.length > 1 ? (panel[panel.length - 1].tMs - panel[0].tMs) / 86_400_000 : 0;
  const medianHold = holdDurations.length ? [...holdDurations].sort((a, b) => a - b)[Math.floor(holdDurations.length / 2)] : null;
  const meanHold = holdDurations.length ? holdDurations.reduce((s, x) => s + x, 0) / holdDurations.length : null;

  return {
    entries, rolls, exits, spanDays,
    rollsPerMonth: spanDays > 0 ? rolls * (30 / spanDays) : null,
    medianHoldDaysBetweenTransitions: medianHold,
    meanHoldDaysBetweenTransitions: meanHold,
  };
}

// ---- 5. correlation across all logged spreads ----
function pearson(aVals, bVals) {
  const n = aVals.length;
  const meanA = aVals.reduce((s, x) => s + x, 0) / n;
  const meanB = bVals.reduce((s, x) => s + x, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = aVals[i] - meanA, db = bVals[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  if (denA === 0 || denB === 0) return null;
  return num / Math.sqrt(denA * denB);
}
function correlationStats(panel, opts = {}) {
  const minOverlap = opts.minOverlap ?? 20;
  const keys = allSeriesKeys(panel);
  const indexed = keys.map(({ root, pairKey }) => {
    const m = new Map();
    for (const row of panel) {
      const v = row.tokens[root] && row.tokens[root][pairKey];
      if (v != null && !isNaN(v)) m.set(row.tMs, v);
    }
    return { root, pairKey, m };
  }).filter(s => s.m.size >= minOverlap);

  const corrs = [];
  for (let i = 0; i < indexed.length; i++) {
    for (let j = i + 1; j < indexed.length; j++) {
      const a = indexed[i], b = indexed[j];
      const aVals = [], bVals = [];
      for (const [tMs, v] of a.m) { if (b.m.has(tMs)) { aVals.push(v); bVals.push(b.m.get(tMs)); } }
      if (aVals.length < minOverlap) continue;
      const r = pearson(aVals, bVals);
      if (r != null) corrs.push(r);
    }
  }
  corrs.sort((a, b) => a - b);
  const mean = corrs.length ? corrs.reduce((s, x) => s + x, 0) / corrs.length : null;
  const median = corrs.length ? corrs[Math.floor(corrs.length / 2)] : null;
  return {
    nPairs: corrs.length,
    mean, median,
    p10: corrs.length ? corrs[Math.floor(corrs.length * 0.1)] : null,
    p90: corrs.length ? corrs[Math.floor(corrs.length * 0.9)] : null,
  };
}

module.exports = {
  PAIR_KEYS, loadPanel, seriesFor, allSeriesKeys,
  countCrossings, arrivalStats,
  halfLifeDays, persistenceStats,
  episodes, episodeStats,
  replayRolls,
  pearson, correlationStats,
};
