'use strict';
// analysis/cde_funding_trend.js
//
// Funding direction tracker. Perp funding follows the perp's premium to its index
// (perp mid vs index price). Each poll we record that premium per token, then compare the
// average of the last `winMs` with the average of the `winMs` before it:
//   higher -> funding is trending up, lower -> trending down.
// This uses only observed prices; it does not guess the exchange's funding formula.
// In-memory only (a restart starts the trend over; it needs ~`minN` samples per window).

const WIN_MS = 15 * 60_000;
const KEEP_MS = 2 * WIN_MS + 60_000;
const MIN_N = 8;
const FLAT_BP = 0.3;

function createTrendTracker(opts = {}) {
  const winMs = opts.winMs || WIN_MS, minN = opts.minN || MIN_N, flatBp = opts.flatBp ?? FLAT_BP;
  const keepMs = 2 * winMs + 60_000;
  const m = new Map();
  const mean = (a) => a.reduce((s, x) => s + x.bp, 0) / a.length;
  return {
    add(root, tMs, premBp) {
      if (premBp == null || !isFinite(premBp)) return;
      let a = m.get(root); if (!a) { a = []; m.set(root, a); }
      if (a.length && tMs <= a[a.length - 1].t) return;
      a.push({ t: tMs, bp: premBp });
      const cut = tMs - keepMs; let k = 0; while (k < a.length && a[k].t < cut) k++; if (k) a.splice(0, k);
    },
    trend(root, nowMs) {
      const a = m.get(root) || [];
      const recent = a.filter(x => x.t > nowMs - winMs), prior = a.filter(x => x.t <= nowMs - winMs && x.t > nowMs - 2 * winMs);
      if (recent.length < minN || prior.length < minN) return { dir: null, recentBp: recent.length ? mean(recent) : null, priorBp: null, deltaBp: null, nRecent: recent.length, nPrior: prior.length };
      const r = mean(recent), p = mean(prior), d = r - p;
      return { dir: d > flatBp ? 'UP' : d < -flatBp ? 'DOWN' : 'FLAT', recentBp: r, priorBp: p, deltaBp: d, nRecent: recent.length, nPrior: prior.length };
    },
  };
}
module.exports = { createTrendTracker, WIN_MS, MIN_N, FLAT_BP };
