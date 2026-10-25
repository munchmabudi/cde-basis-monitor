// analysis/cde_basis.js
const fs = require('fs');
const path = require('path');

const DAY_MS = 86_400_000;
const FALLBACK_HORIZON_DAYS = 30;
const LOW_LIQ_USD = 100_000;
// Firm sanity ceiling for any annualized % figure. Deliberately generous —
// this exists to catch broken/extreme data (near-zero-Tms blowups, bad
// ticks), not to second-guess a real large-but-plausible number.
const SANITY_CAP_PCT = 3000;

const LOG_PATH = process.env.CDE_BASIS_LOG
  ? path.resolve(process.env.CDE_BASIS_LOG)
  : path.join(__dirname, '..', 'data', 'cde_basis_LOG.jsonl');

function parseInterval(s) {
  if (!s) return null;
  const m = /(\d+)s/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}
function periodsPerYear(sec) {
  return sec ? (365 * 24 * 3600) / sec : null;
}
function num(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function datedBasisAPY(F, S, Tms) {
  if (F == null || S == null || !Tms) return null;
  return (F - S) / S * (365 * 24 * 3600 * 1000 / Tms) * 100;
}
function perpFundingAPY(rate, sec) {
  if (rate == null || !sec) return null;
  return rate * periodsPerYear(sec) * 100;
}
function perpGapPct(P, idx) {
  if (P == null || idx == null) return null;
  return (P - idx) / idx * 100;
}
function allInDatedPct(F, S, Tms, hMs) {
  if (F == null || S == null || !Tms || !hMs) return null;
  return (F - S) / S * (hMs / Tms) * 100;
}
function allInPerpPct(P, idx, rate, sec, hMs) {
  if (P == null || idx == null || rate == null || !sec || !hMs) return null;
  const gap = (P - idx) / idx * 100;
  const fund = rate * (hMs / 1000 / sec) * 100;
  return gap + fund;
}

// Generic annualized-carry spread between any two legs (front dated, back
// dated, perp). Higher annualized APY = more expensive to hold long = "rich"
// = the leg to short; the other leg is the one to go long. This is the same
// convention already used for divergence (front vs perp) and termSlope
// (front vs back) — this just generalizes it to any pair so a third pair
// (back vs perp) can use identical logic.
function pairSpread(apyA, nameA, apyB, nameB) {
  if (apyA == null || apyB == null) return null;
  const spread = apyA - apyB;
  const action = spread >= 0 ? `Short ${nameA} / Long ${nameB}` : `Long ${nameA} / Short ${nameB}`;
  return { spread, action };
}

function buildSnapshot(futureProducts, spotProducts, opts = {}) {
  const fallbackDays = opts.fallbackHorizonDays ?? FALLBACK_HORIZON_DAYS;
  const horizonOverrideMs = (opts.horizonDays != null) ? opts.horizonDays * DAY_MS : null;

  const spotById = {}, spotByRoot = {};
  for (const p of (spotProducts || [])) {
    const id = p.product_id || p.productId;
    if (!id) continue;
    const pr = num(p.price);
    if (pr == null) continue;
    spotById[id] = pr;
    if (id.endsWith('-USD')) spotByRoot[id.slice(0, -4)] = pr;
  }

  const byRoot = {};
  for (const p of (futureProducts || [])) {
    const d = p.future_product_details || {};
    const root = d.contract_root_unit || d.contract_code;
    if (!root) continue;
    const isPerp = !!d.funding_interval;
    const rec = {
      productId: p.product_id || p.productId, code: d.contract_code, root, isPerp,
      mid: num(p.mid_market_price), price: num(p.price), expiry: d.contract_expiry,
      Tms: num(d.time_to_expiry_ms), fundingInterval: d.funding_interval || null,
      fundingSec: parseInterval(d.funding_interval), fundingRate: num(d.funding_rate),
      fundingTime: d.funding_time || null, index: num(d.index_price),
      contractSize: num(d.contract_size), oi: num(d.open_interest),
      tickSize: num(p.quote_increment) || num(p.price_increment) || num(d.quote_increment) || num(d.tick_size) || null,
      vol24: num(p.approximate_quote_24h_volume),
    };
    (byRoot[root] = byRoot[root] || []).push(rec);
  }

  const rows = [];
  let frontTmsChosen = null;
  for (const [root, recs] of Object.entries(byRoot)) {
    // Guard against a contract that's already expired but briefly lingers in
    // the API response with Tms <= 0: without this filter, a negative Tms
    // would (a) sort FIRST under ascending order, incorrectly blocking the
    // real new front month from taking over, and (b) flip the sign of the
    // annualization factor in datedBasisAPY, producing a wildly wrong number
    // for a contract that should already be excluded. This is exactly the
    // failure mode that matters at a rollover boundary.
    const dated = recs.filter(r => !r.isPerp && r.Tms != null && r.Tms > 0)
      .sort((a, b) => a.Tms - b.Tms);
    const perps = recs.filter(r => r.isPerp);
    const perp = perps[0] || null;
    const front = dated[0] || null;
    // "Back month" = second-soonest-to-expire dated contract for this root.
    // Not every root has one — only present when the exchange lists 2+
    // simultaneous dated tenors for that underlying.
    const back = dated[1] || null;

    const perpIdx = perp && perp.index && perp.index > 0 ? perp.index : null;
    const spotS = spotByRoot[root] ?? spotById[root + '-USD'] ?? null;
    const anchor = (perp && perp.mid > 0) ? perp.mid : (front && front.mid > 0 ? front.mid : null);
    let S_dated = null;
    if (perpIdx != null) {
      S_dated = perpIdx;
    } else if (spotS != null && anchor != null) {
      if (Math.abs(spotS - anchor) / anchor < 0.5) S_dated = spotS;
    }
    const S_perp = perpIdx;
    const frontMidOk = front && front.mid > 0;
    const backMidOk = back && back.mid > 0;
    const perpMidOk = perp && perp.mid > 0;

    const hMs = horizonOverrideMs != null ? horizonOverrideMs
      : (front && front.Tms ? front.Tms : fallbackDays * DAY_MS);
    if (front && front.Tms && (frontTmsChosen == null || front.Tms < frontTmsChosen)) {
      frontTmsChosen = front.Tms;
    }

    const basisAPY = (frontMidOk && S_dated != null) ? datedBasisAPY(front.mid, S_dated, front.Tms) : null;
    // Back month uses the SAME S_dated anchor as front — both legs are the
    // same underlying, so they should be compared against one shared fair
    // value, not two independently-sourced ones (that would just reintroduce
    // the feed-scale-mismatch risk the front/perp guard already exists for).
    const backBasisAPY = (backMidOk && S_dated != null) ? datedBasisAPY(back.mid, S_dated, back.Tms) : null;
    const fundAPY = perp ? perpFundingAPY(perp.fundingRate, perp.fundingSec) : null;
    const gapPct = (perpMidOk && S_perp != null) ? perpGapPct(perp.mid, S_perp) : null;

    const allInDated = (frontMidOk && S_dated != null) ? allInDatedPct(front.mid, S_dated, front.Tms, hMs) : null;
    const allInPerp = (perpMidOk && S_perp != null) ? allInPerpPct(perp.mid, S_perp, perp.fundingRate, perp.fundingSec, hMs) : null;

    const divergence = (basisAPY != null && fundAPY != null) ? basisAPY - fundAPY : null;
    // Term slope: front basis APY minus back basis APY. Positive = front is
    // richer (annualized) than back — calendar trade = sell front / buy back.
    // Negative = back is richer — buy front / sell back.
    const termSlope = (basisAPY != null && backBasisAPY != null) ? basisAPY - backBasisAPY : null;
    // Third pairwise spread, named explicitly (not just a candidate buried in
    // bestSpread selection) so it can be logged and get its own z-score
    // history, same as divergence (front-perp) and termSlope (front-back)
    // already do. Without this, an alert or ranking that happens to pick
    // BACK_PERP as the best pair would have no historical context for it.
    const backPerpSpread = (backBasisAPY != null && fundAPY != null) ? backBasisAPY - fundAPY : null;

    // Rank ALL available pairwise spreads for this token (front-vs-perp,
    // front-vs-back, back-vs-perp) and surface whichever is largest in
    // magnitude. A token might have its best opportunity in a pair other
    // than front-vs-perp — e.g. the front month could look ordinary but the
    // back month could be badly mispriced vs. the perp. Values are identical
    // to divergence/termSlope/backPerpSpread where they overlap; this doesn't
    // replace those fields, it just adds the "pick the best of the three"
    // layer on top.
    const spreadCandidates = [
      basisAPY != null && fundAPY != null ? { pair: 'FRONT_PERP', ...pairSpread(basisAPY, 'FRONT', fundAPY, 'PERP') } : null,
      basisAPY != null && backBasisAPY != null ? { pair: 'FRONT_BACK', ...pairSpread(basisAPY, 'FRONT', backBasisAPY, 'BACK') } : null,
      backPerpSpread != null ? { pair: 'BACK_PERP', spread: backPerpSpread, action: backPerpSpread >= 0 ? 'Short BACK / Long PERP' : 'Long BACK / Short PERP' } : null,
    ].filter(Boolean);
    let bestSpread = null;
    for (const c of spreadCandidates) {
      if (bestSpread == null || Math.abs(c.spread) > Math.abs(bestSpread.spread)) bestSpread = c;
    }

    let verdict = null;
    if (allInDated != null && allInPerp != null) {
      verdict = allInPerp < allInDated ? 'PERP cheaper' : 'FUTURE cheaper';
    } else if (allInDated != null) {
      verdict = 'FUTURE only';
    } else if (allInPerp != null) {
      verdict = 'PERP only';
    }

    const liqVol = perp ? perp.vol24 : (front ? front.vol24 : null);
    const lowLiq = (liqVol != null && liqVol < LOW_LIQ_USD);
    const frontHoursToExpiry = front && front.Tms ? front.Tms / 3600000 : null;
    const flags = [];
    if (S_dated == null && S_perp == null) flags.push('NO_S');
    else if (front && S_dated == null) flags.push('NO_S_DATED');
    if (lowLiq) flags.push('LOW_LIQ');
    if (front && front.Tms && front.Tms < 30 * DAY_MS) flags.push('NEAR_DATED');
    // Distinct from NEAR_DATED (<30d, informational): this catches the hours
    // just before front-month expiry, where a tiny raw basis gets divided by
    // a near-zero time window and annualizes into a huge, misleading APY —
    // mathematically correct as an extrapolation, not a real opportunity.
    if (frontHoursToExpiry != null && frontHoursToExpiry < 24) flags.push('EXPIRING');
    // Firm sanity ceiling, independent of EXPIRING: catches anything beyond
    // a generous bound regardless of cause — an even-more-extreme near-zero
    // Tms case, a single bad/glitched tick during a fast market move, etc.
    // 3000% (30x) is deliberately generous — real basis/funding/spreads
    // should never legitimately approach this; if they do, treat it as
    // broken data, not a signal.
    const suspectVals = [basisAPY, backBasisAPY, fundAPY, divergence, termSlope, bestSpread ? bestSpread.spread : null];
    if (suspectVals.some(v => v != null && Math.abs(v) > SANITY_CAP_PCT)) flags.push('SUSPECT');

    rows.push({
      root, hasDated: !!front, hasPerp: !!perp, hasBack: !!back,
      dated: front ? { productId: front.productId, code: front.code, F: front.mid, S: S_dated, Tms: front.Tms,
        expiry: front.expiry, hoursToExpiry: frontHoursToExpiry, basisAPY, allInPct: allInDated, contractSize: front.contractSize, tick: front.tickSize, oi: front.oi, vol24: front.vol24 } : null,
      back: back ? { productId: back.productId, code: back.code, F: back.mid, S: S_dated, Tms: back.Tms,
        expiry: back.expiry, basisAPY: backBasisAPY, contractSize: back.contractSize, tick: back.tickSize, oi: back.oi, vol24: back.vol24 } : null,
      perp: perp ? { productId: perp.productId, code: perp.code, P: perp.mid, S: S_perp, gapPct,
        fundingRate: perp.fundingRate, fundingSec: perp.fundingSec, fundingInterval: perp.fundingInterval, fundingTime: perp.fundingTime, fundAPY,
        allInPct: allInPerp, contractSize: perp.contractSize, tick: perp.tickSize, oi: perp.oi, vol24: perp.vol24 } : null,
      hDays: +(hMs / DAY_MS).toFixed(2), divergence, termSlope, backPerpSpread, bestSpread, verdict, flags,
    });
  }

  rows.sort((a, b) => {
    const aKey = a.hasDated ? 0 : 1;
    const bKey = b.hasDated ? 0 : 1;
    if (aKey !== bKey) return aKey - bKey;
    if (aKey === 0) return (b.dated.basisAPY ?? -1e9) - (a.dated.basisAPY ?? -1e9);
    return (a.root || '').localeCompare(b.root || '');
  });

  const outHorizonDays = horizonOverrideMs != null ? +(horizonOverrideMs / DAY_MS).toFixed(2)
    : +(frontTmsChosen ? frontTmsChosen / DAY_MS : fallbackDays).toFixed(2);
  return { generatedAt: new Date().toISOString(), horizonDays: outHorizonDays, horizonOverride: horizonOverrideMs != null, rows };
}

function logPoll(snap, ts = new Date().toISOString()) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    const tokens = {};
    for (const r of snap.rows) {
      const suspect = r.flags.includes('SUSPECT');
      const expiring = r.flags.includes('EXPIRING');
      // SUSPECT: something about this token's numbers is broken this poll,
      // but not necessarily clear which field — exclude everything derived
      // for this token rather than risk logging a partially-bad reading.
      // EXPIRING (without SUSPECT): only the front-derived figures are an
      // artifact of the near-zero time denominator; funding/perp-only
      // figures and the back month's own reading are still valid.
      const frontTainted = suspect || expiring;
      tokens[r.root] = {
        v: r.verdict,
        bApy: frontTainted ? null : (r.dated ? r.dated.basisAPY : null),
        fApy: suspect ? null : (r.perp ? r.perp.fundAPY : null),
        gap: suspect ? null : (r.perp ? r.perp.gapPct : null),
        aD: frontTainted ? null : (r.dated ? r.dated.allInPct : null),
        aP: suspect ? null : (r.perp ? r.perp.allInPct : null),
        // Volume is a raw exchange-reported figure, not derived from the
        // annualization math that SUSPECT/EXPIRING guard against — log it
        // unconditionally whenever the leg exists.
        frontVol: r.dated ? r.dated.vol24 : null,
        backVol: r.back ? r.back.vol24 : null,
        div: frontTainted ? null : r.divergence,
        bkApy: suspect ? null : (r.back ? r.back.basisAPY : null),
        term: frontTainted ? null : r.termSlope,
        bpApy: suspect ? null : r.backPerpSpread,
        frontExpiry: r.dated ? r.dated.expiry : null, fl: r.flags,
      };
    }
    fs.appendFileSync(LOG_PATH, JSON.stringify({ t: ts, tokens }) + '\n');
  } catch (e) {
    console.warn('[cde-basis] logPoll failed:', e.message);
  }
}

module.exports = {
  DAY_MS, FALLBACK_HORIZON_DAYS, LOW_LIQ_USD, SANITY_CAP_PCT, LOG_PATH,
  parseInterval, periodsPerYear, num,
  datedBasisAPY, perpFundingAPY, perpGapPct, allInDatedPct, allInPerpPct, pairSpread,
  buildSnapshot, logPoll,
};
