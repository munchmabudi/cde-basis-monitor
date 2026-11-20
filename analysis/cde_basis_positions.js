// analysis/cde_basis_positions.js
//
// Manually-entered positions, scored with the SAME mid-price APY numbers the
// Overview / Front-vs-Perp tabs use:
//   Perp (outright)        -> perp funding APY
//   Front / Back (outright) -> that contract's basis APY vs the index
//   Spread A - B            -> APY(A) - APY(B)   (front-perp, back-perp, front-back;
//                              same convention as the other tabs: positive = A rich)
//
// Sign rule: you RECEIVE the APY when you're short and it's positive, or long
// and it's negative. So  yourApy = short ? +apy : -apy  ("Long spread" = long A,
// short B). Positive yourApy = being paid; higher is better.
//
// A position is pinned to the specific CONTRACTS it was entered on (product
// ids), not to the "front"/"back" labels. When Oct expires, a position entered
// on Nov keeps tracking Nov (it just becomes the new front); a position on Oct
// reports EXPIRED instead of silently switching to Nov.

const fs = require('fs');
const path = require('path');

const MAX_POSITIONS = 300;
const DAY_MS = 86_400_000;

const INSTRUMENTS = {
  PERP:       { kind: 'OUTRIGHT', a: 'PERP' },
  FRONT:      { kind: 'OUTRIGHT', a: 'FRONT' },
  BACK:       { kind: 'OUTRIGHT', a: 'BACK' },
  FRONT_PERP: { kind: 'SPREAD', a: 'FRONT', b: 'PERP' },
  BACK_PERP:  { kind: 'SPREAD', a: 'BACK',  b: 'PERP' },
  FRONT_BACK: { kind: 'SPREAD', a: 'FRONT', b: 'BACK' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function fmtExpiry(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return '?';
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, '0')}${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
}

// The legs a snapshot row currently has, keyed by role.
function legsOf(row) {
  return {
    PERP: row.perp ? { id: row.perp.productId, apy: row.perp.fundAPY, label: 'PERP', tms: null, expiry: null } : null,
    FRONT: row.dated ? { id: row.dated.productId, apy: row.dated.basisAPY, label: fmtExpiry(row.dated.expiry), tms: row.dated.Tms, expiry: row.dated.expiry } : null,
    BACK: row.back ? { id: row.back.productId, apy: row.back.basisAPY, label: fmtExpiry(row.back.expiry), tms: row.back.Tms, expiry: row.back.expiry } : null,
  };
}

// What can be entered for each token right now (drives the form's dropdowns).
function availableInstruments(row) {
  const L = legsOf(row), out = [];
  for (const [key, def] of Object.entries(INSTRUMENTS)) {
    if (!L[def.a] || (def.b && !L[def.b])) continue;
    const name = def.kind === 'OUTRIGHT'
      ? (def.a === 'PERP' ? `${row.root} Perp` : `${row.root} ${L[def.a].label} future (${def.a === 'FRONT' ? '1' : '2'})`)
      : `${row.root} ${L[def.a].label} − ${L[def.b].label}  (${roleName(def.a)}–${roleName(def.b)} spread)`;
    out.push({ key, name });
  }
  return out;
}
function roleName(role) { return role === 'PERP' ? 'Perp' : (role === 'FRONT' ? '1' : '2'); }

// Parse "250000", "$250,000", "250k", "1.5m" -> number (or null if blank, NaN if junk)
function parseNotional(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[$,\s]/g, '');
  if (s === '') return null;
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s);
  if (!m) return NaN;
  return parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : (m[2] === 'm' ? 1e6 : 1));
}

// Turn form input into a position pinned to concrete contracts. `existing` is
// passed on edit: contract/token can't change, only side/notional/note.
function buildPosition(input, rows, existing = null, nowIso = new Date().toISOString()) {
  const side = String(input.side || '').toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') return { error: 'Pick Long or Short.' };
  const notional = parseNotional(input.notional);
  if (Number.isNaN(notional) || (notional != null && notional <= 0)) return { error: 'Notional must be a positive number (e.g. 250000, 250k, 1.5m) or left blank.' };
  const note = String(input.note || '').trim().slice(0, 120);
  if (existing) return { position: { ...existing, side, notionalUsd: notional, note, updatedAt: nowIso } };

  const root = String(input.root || '').toUpperCase().trim();
  const row = rows.find(r => r.root === root);
  if (!row) return { error: `Unknown token "${esc(root)}".` };
  const def = INSTRUMENTS[input.instrument];
  if (!def) return { error: 'Pick an instrument.' };
  const L = legsOf(row);
  if (!L[def.a] || (def.b && !L[def.b])) return { error: `${root} doesn't currently have the legs for that instrument.` };
  const A = L[def.a], B = def.b ? L[def.b] : null;
  const label = def.kind === 'OUTRIGHT'
    ? `${root} ${A.label}`
    : `${root} ${A.label} − ${B.label}`;
  return {
    position: {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      root, kind: def.kind, instrument: input.instrument,
      aId: A.id, bId: B ? B.id : null,
      aExpiry: A.expiry, bExpiry: B ? B.expiry : null,
      label, side, notionalUsd: notional, note, createdAt: nowIso,
    },
  };
}

// Find a contract's CURRENT role + apy in a snapshot row (null if it's no longer front/back/perp).
function findLeg(row, id) {
  const L = legsOf(row);
  for (const role of ['PERP', 'FRONT', 'BACK']) if (L[role] && L[role].id === id) return { role, ...L[role] };
  return null;
}

function yourApyFrom(side, apy) {
  if (apy == null) return null;
  return side === 'SHORT' ? apy : -apy;
}

// Score one position against the latest snapshot rows.
function evaluatePosition(pos, rows, nowMs = Date.now()) {
  const base = { id: pos.id, root: pos.root, label: pos.label, side: pos.side, notionalUsd: pos.notionalUsd ?? null, note: pos.note || '', kind: pos.kind };
  const row = rows.find(r => r.root === pos.root);
  if (!row) return { ...base, status: 'NO_DATA', reason: 'token not in the current feed', marketApy: null, yourApy: null, estUsdYr: null };
  const A = findLeg(row, pos.aId);
  const B = pos.bId ? findLeg(row, pos.bId) : null;
  const missing = [];
  if (!A) missing.push({ exp: pos.aExpiry });
  if (pos.bId && !B) missing.push({ exp: pos.bExpiry });
  if (missing.length) {
    const expired = missing.some(m => m.exp && Date.parse(m.exp) <= nowMs);
    return { ...base, status: expired ? 'EXPIRED' : 'NOT_TRACKED',
      reason: expired ? 'contract has expired' : 'contract is no longer front/back month, so it has no APY here',
      marketApy: null, yourApy: null, estUsdYr: null };
  }
  const apyA = A.apy, apyB = B ? B.apy : null;
  const marketApy = pos.kind === 'SPREAD' ? ((apyA != null && apyB != null) ? apyA - apyB : null) : apyA;
  const yourApy = yourApyFrom(pos.side, marketApy);
  // APY is unreliable inside 24h of an expiry (tiny basis / tiny time), if the
  // row tripped the sanity cap, or if a leg's price has gone stale.
  const legs = [A, B].filter(Boolean);
  const flags = row.flags || [];
  const unreliable = flags.includes('SUSPECT')
    || legs.some(l => l.tms != null && l.tms < DAY_MS)
    || (legs.some(l => l.role === 'PERP') && (flags.includes('STALE') || flags.includes('STALE_PERP')))
    || (legs.some(l => l.role === 'FRONT') && (flags.includes('STALE') || flags.includes('STALE_FRONT')));
  const parts = legs.map(l => `${l.role === 'PERP' ? 'perp funding' : roleName(l.role) + ' basis'} ${l.apy == null ? '—' : (l.apy >= 0 ? '+' : '') + l.apy.toFixed(2) + '%'}`);
  return {
    ...base, status: marketApy == null ? 'NO_DATA' : 'OK',
    reason: marketApy == null ? 'APY unavailable right now (missing price/funding)' : null,
    marketApy, yourApy, unreliable,
    nowAs: pos.kind === 'SPREAD' ? `${roleName(A.role)}–${roleName(B.role)} spread` : (A.role === 'PERP' ? 'Perp' : `${roleName(A.role)} (${A.role.toLowerCase()})`),
    detail: parts.join(' ; '),
    estUsdYr: (pos.notionalUsd != null && yourApy != null) ? pos.notionalUsd * yourApy / 100 : null,
  };
}

function evaluateAll(positions, rows, nowMs = Date.now()) {
  return positions.map(p => evaluatePosition(p, rows, nowMs));
}

// Best (most paid) first; unreliable / no-data rows last. Used for the default
// server-side order; the page re-sorts client-side when you click a header.
function rankEvaluated(evals) {
  const bad = (e) => e.status !== 'OK' || e.unreliable;
  return evals.slice().sort((a, b) => {
    if (bad(a) !== bad(b)) return bad(a) ? 1 : -1;
    return (b.yourApy ?? -1e18) - (a.yourApy ?? -1e18);
  });
}

// Notional-weighted average of yourApy over reliable positions that have a
// notional, plus total est. $/yr. Spread notional = per leg.
function summarize(evals) {
  const ok = evals.filter(e => e.status === 'OK' && !e.unreliable);
  const weighted = ok.filter(e => e.notionalUsd != null);
  const totalNotional = weighted.reduce((s, e) => s + e.notionalUsd, 0);
  return {
    count: evals.length,
    scored: ok.length,
    weightedCount: weighted.length,
    totalNotional,
    weightedYourApy: totalNotional > 0 ? weighted.reduce((s, e) => s + e.notionalUsd * e.yourApy, 0) / totalNotional : null,
    totalEstUsdYr: weighted.reduce((s, e) => s + e.estUsdYr, 0),
    unscored: evals.length - ok.length,
  };
}

// ---- persistence (JSON file in the data dir, like positions/hidden) ----
function loadMyPositions(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(j.positions)) return j.positions;
    throw new Error('unexpected file shape (no positions array)');
  } catch (e) {
    console.warn('[cde-basis] loadMyPositions failed:', e.message);
    // Don't let the next save silently overwrite a file we couldn't read:
    // set it aside first so nothing the user entered is lost.
    try {
      if (fs.existsSync(filePath)) {
        const aside = `${filePath}.unreadable-${Date.now()}`;
        fs.renameSync(filePath, aside);
        console.warn(`[cde-basis] moved unreadable positions file to ${aside}`);
      }
    } catch (e2) { console.warn('[cde-basis] could not set aside unreadable file:', e2.message); }
    return [];
  }
}
function saveMyPositions(filePath, positions) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, positions }, null, 2));
  fs.renameSync(tmp, filePath);   // atomic swap so a crash mid-write can't corrupt the file
}

module.exports = {
  INSTRUMENTS, MAX_POSITIONS, esc, fmtExpiry, availableInstruments, parseNotional, buildPosition,
  findLeg, yourApyFrom, evaluatePosition, evaluateAll, rankEvaluated, summarize,
  loadMyPositions, saveMyPositions,
};
