'use strict';
const assert = require('assert');
const F = require('../../analysis/cde_fills');
const Q = require('../../analysis/cde_quotes');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

// --- synthFill: the four cases (spread S = A - B, tick 0.01) ---
const qA = { bid: 10.10, ask: 10.12 }, qB = { bid: 10.00, ask: 10.01 };
// synthetic bid = 10.10-10.01 = 0.09 ; synthetic offer = 10.12-10.00 = 0.12
ok('X=A taker SELL -> maker bought A, hedge sell B at bid: bought spread', () => {
  const f = F.synthFill('A', 10.10, 'SELL', qA, qB, 0.01);
  assert.strictEqual(f.spreadSide, 'BUY'); assert.strictEqual(f.makerSide, 'BUY');
  assert.ok(Math.abs(f.price - 0.10) < 1e-9);                // 10.10 - 10.00
  assert.ok(Math.abs(f.distTicks - 1) < 1e-6);               // 0.10 is 1 tick above synthetic bid 0.09
});
ok('X=A taker BUY -> maker sold A, hedge buy B at ask: sold spread', () => {
  const f = F.synthFill('A', 10.12, 'BUY', qA, qB, 0.01);
  assert.strictEqual(f.spreadSide, 'SELL'); assert.strictEqual(f.makerSide, 'SELL');
  assert.ok(Math.abs(f.price - 0.11) < 1e-9);                // 10.12 - 10.01
  assert.ok(Math.abs(f.distTicks - 1) < 1e-6);               // 1 tick below synthetic offer 0.12
});
ok('X=B taker SELL -> maker bought B, hedge sell A at bid: sold spread', () => {
  const f = F.synthFill('B', 10.00, 'SELL', qA, qB, 0.01);
  assert.strictEqual(f.spreadSide, 'SELL');
  assert.ok(Math.abs(f.price - 0.10) < 1e-9);                // 10.10 - 10.00
});
ok('X=B taker BUY -> maker sold B, hedge buy A at ask: bought spread', () => {
  const f = F.synthFill('B', 10.01, 'BUY', qA, qB, 0.01);
  assert.strictEqual(f.spreadSide, 'BUY');
  assert.ok(Math.abs(f.price - 0.11) < 1e-9);                // 10.12 - 10.01
});
ok('bad quotes return null', () => assert.strictEqual(F.synthFill('A', 1, 'BUY', null, qB, 0.01), null));

// --- ring nearest ---
ok('ring nearest sample', () => {
  const r = F.createRing(); r.add('X', 1000, 1, 2); r.add('X', 5000, 3, 4); r.add('X', 9000, 5, 6);
  assert.strictEqual(r.at('X', 5400).bid, 3); assert.strictEqual(r.at('X', 8000).bid, 5);
  assert.ok(Math.abs(r.at('X', 5400).lagSec - 0.4) < 1e-9);
});

// --- parseTicker ---
ok('parseTicker', () => {
  const p = F.parseTicker({ trades: [{ trade_id: '2', price: '10.1', size: '3', time: '2026-10-28T12:00:02Z', side: 'SELL' }, { trade_id: '1', price: '10.2', size: '1', time: '2026-10-28T12:00:01Z', side: 'BUY' }, { trade_id: '3', price: 'x', size: '1', time: 'bad', side: 'BUY' }], best_bid: '10.0', best_ask: '10.2' });
  assert.deepStrictEqual(p.trades.map(t => t.id), ['1', '2']); assert.strictEqual(p.ask, 10.2);
});

// --- side checker: feed side is MAKER side -> auto flips ---
ok('side checker auto-detects maker-side feed', () => {
  const c = F.createSideChecker('auto');
  for (let i = 0; i < 30; i++) { c.observe('SELL', 10.12, { bid: 10.10, ask: 10.12 }); }  // trade at the ask labelled SELL => feed is maker side
  assert.strictEqual(c.takerSide('SELL'), 'BUY');
  const d = F.createSideChecker('auto');
  for (let i = 0; i < 30; i++) d.observe('BUY', 10.12, { bid: 10.10, ask: 10.12 });
  assert.strictEqual(d.takerSide('BUY'), 'BUY');
});

// --- full tape with a mock exchange ---
const BOOKS = {}; const TICKERS = {};
const mkBook = (bid, ask) => ({ pricebook: { bids: [{ price: String(bid), size: '10' }], asks: [{ price: String(ask), size: '10' }], time: new Date().toISOString() } });
const mockFetch = async (url) => {
  const id = decodeURIComponent((/product_id=([^&]+)/.exec(url) || /products\/([^/]+)\/ticker/.exec(url))[1]);
  if (url.includes('product_book')) return BOOKS[id];
  return TICKERS[id];
};
(async () => {
  BOOKS.PERP = mkBook(10.00, 10.01); BOOKS.FUT = mkBook(10.10, 10.12);
  const t0 = Date.now();
  TICKERS.FUT = { trades: [{ trade_id: 'old', price: '10.10', size: '1', time: new Date(t0 - 3600_000).toISOString(), side: 'SELL' }] };
  const scope = [{ root: 'TST', perp: { productId: 'PERP', contractSize: 1, Tms: null }, dated: { productId: 'FUT', Tms: 30 * 86400000, contractSize: 1 }, back: null }];
  const tape = F.createTape({ fetchJSON: mockFetch, getScope: () => scope, tickOf: () => 0.01, logPath: null, sleep: async () => {}, minIntervalMs: 0, sideMode: 'taker' });
  await tape.sweep();   // primes: the old trade is swallowed
  assert.strictEqual(tape.status().fills, 0);
  TICKERS.FUT = { trades: [
    { trade_id: 'a', price: '10.10', size: '2', time: new Date().toISOString(), side: 'SELL' },   // taker sold at bid -> we bought spread @ 0.10
    { trade_id: 'b', price: '10.12', size: '1', time: new Date().toISOString(), side: 'BUY' } ] }; // taker bought at ask -> we sold spread @ 0.11
  await tape.sweep();
  const f = tape.recentFills({}).reverse();
  assert.strictEqual(f.length, 2);
  assert.strictEqual(f[0].side, 'BUY'); assert.ok(Math.abs(f[0].spx - 0.10) < 1e-9); assert.strictEqual(f[0].dist, 1);
  assert.strictEqual(f[1].side, 'SELL'); assert.ok(Math.abs(f[1].spx - 0.11) < 1e-9);
  await tape.sweep(); assert.strictEqual(tape.status().fills, 2);      // dedup
  { // with pairs restricted to the perp hedge, a front trade yields one record, not one per pair
    BOOKS.BACK = mkBook(10.30, 10.34);
    const t2 = F.createTape({ fetchJSON: mockFetch, getScope: () => [{ ...scope[0], back: { productId: 'BACK', Tms: 60 * 86400000, contractSize: 1 } }], tickOf: () => 0.01, logPath: null, sleep: async () => {}, minIntervalMs: 0, sideMode: 'taker', pairs: ['FRONT_PERP', 'BACK_PERP'] });
    TICKERS.BACK = { trades: [] }; TICKERS.FUT = { trades: [] }; await t2.sweep();
    TICKERS.FUT = { trades: [{ trade_id: 'z1', price: '10.10', size: '1', time: new Date().toISOString(), side: 'SELL' }] }; await t2.sweep();
    assert.deepStrictEqual(t2.recentFills({}).map(f => f.pair), ['FRONT_PERP']);
  }
  const cv = tape.curve('TST', 'FRONT_PERP', 'BUY', { dMin: 0, dMax: 3 });
  assert.strictEqual(cv.points.find(p => p.d === 0).events, 0); assert.strictEqual(cv.points.find(p => p.d === 1).events, 1);
  assert.strictEqual(cv.points.find(p => p.d === 1).contracts, 2);
  n++; console.log('ok - tape end to end (prime, synth, dedup, curve)');

  // --- quote sheet ---
  const fv = Q.createFairValue({ halfLifeMin: 60 });
  const row = { root: 'TST', perp: { productId: 'PERP', contractSize: 100 }, dated: { productId: 'FUT', Tms: 30 * 86400000, contractSize: 100 }, back: null };
  const now = Date.now();
  // feed a steady fair spread of 0.105 over an hour so fair value is warm
  const ring = F.createRing();
  for (let i = 60; i >= 0; i--) { const t = now - i * 60_000; ring.add('PERP', t, 10.00, 10.01); ring.add('FUT', t, 10.10, 10.12); Q.updateFairValues(fv, [row], ring, t, now); }
  const env = { params: { ...Q.DEFAULTS, levels: 3, warmupMin: 30 }, ring, fv, tickOf: () => 0.01, nowMs: now, snapAtMs: now, tapeCurve: null };
  const q = Q.buildQuote(row, 'FRONT_PERP', env);
  assert.ok(!q.error, q.error);
  // dollars/tick = 0.01*100 = $1 ; fee per hedged fill = (0.03+0.02) x 2 legs = $0.10 -> 0.10 ticks ; c = 0.10 + 0 + 0.5 = 0.60
  assert.ok(Math.abs(q.feeTicks - 0.10) < 1e-9); assert.ok(Math.abs(q.cTicks - 0.60) < 1e-9);
  assert.ok(Math.abs(q.feePerFillUsd - 0.10) < 1e-9);
  const rt = Q.buildQuote(row, 'FRONT_PERP', { ...env, params: { ...env.params, feeBasis: 'roundtrip' } });
  assert.ok(Math.abs(rt.feePerFillUsd - 0.20) < 1e-9);
  // mid spread = 10.11-10.005 = 0.105 -> 10.5 ticks. ceil = floor(10.5-0.6-0.5)=floor(9.4)=9 ; floor = ceil(10.5+1.1)=12
  assert.strictEqual(q.ceil, 9); assert.strictEqual(q.floor, 12);
  assert.strictEqual(q.kSynBid, 9); assert.strictEqual(q.kSynAsk, 12);
  // bid must stay below synthetic offer (11) : top=min(9,11)=9 ; ladder 9,8,7, future bid = perp bid + spread = 10.00 + 0.09
  assert.deepStrictEqual(q.bid.levels.map(l => l.k), [9, 8, 7]);
  assert.ok(Math.abs(q.bid.levels[0].futurePx - 10.09) < 1e-9);
  assert.deepStrictEqual(q.ask.levels.map(l => l.k), [12, 13, 14]);
  assert.ok(Math.abs(q.ask.levels[0].futurePx - (10.01 + 0.12)) < 1e-9);
  assert.ok(q.bid.levels.every(l => l.edge >= 0.5)); assert.ok(q.ask.levels.every(l => l.edge >= 0.5));
  n++; console.log('ok - quote sheet ceiling/floor, ladder, future prices');

  // fair value cold -> warming message
  const cold = Q.buildQuote(row, 'FRONT_PERP', { ...env, fv: Q.createFairValue() });
  assert.ok(/warming/.test(cold.error)); n++; console.log('ok - cold fair value reports warming');

  // fill-rate picks a different top level: make deeper bids fill rarely, ceiling fills a lot
  const pts = []; for (let d = -3; d <= 20; d++) pts.push({ d, eventsPerHr: d < 0 ? 0 : d === 0 ? 1 : d === 1 ? 4 : 6, contractsPerHr: 0 });
  const withCurve = Q.buildQuote(row, 'FRONT_PERP', { ...env, tapeCurve: (r, p, side) => ({ total: 100, windowHrs: 6, points: pts }) });
  assert.strictEqual(withCurve.bid.pick, 'fill-rate'); assert.ok(withCurve.bid.levels.length > 0);
  n++; console.log('ok - fill-rate curve drives the pick');
  console.log(`\n${n} checks passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

// --- rate normalisation: old fills from before the tape was covering must not inflate the rate ---
(async () => {
  const F2 = require('../../analysis/cde_fills');
  let clock = Date.parse('2026-10-29T12:00:00Z');
  const tape = F2.createTape({ fetchJSON: async () => null, getScope: () => [], tickOf: () => 0.01, sleep: async () => {}, now: () => clock });
  // pretend: tape ran sweeps every 15s for 2 hours (480 sweeps), 100 BUY fills at dist 0 during that time
  const fills = tape.allFills();
  for (let i = 0; i < 100; i++) fills.push({ root: 'T', pair: 'FRONT_PERP', side: 'BUY', dist: 0, size: 3, tMs: clock - 3600_000 * 1.5 + i * 1000 });
  // 5000 older fills from a previous run with no coverage record must be ignored
  for (let i = 0; i < 5000; i++) fills.push({ root: 'T', pair: 'FRONT_PERP', side: 'BUY', dist: 0, size: 3, tMs: clock - 5 * 3600_000 + i * 1000 });
  const st = tape.status; // sweeps are recorded through sweep(); emulate by calling the internal path via sweep with a stepped clock
  for (let i = 0; i < 480; i++) { clock -= 0; }
  // drive real sweeps with a moving fake clock
  clock = Date.parse('2026-10-29T10:00:00Z');
  const origNow = Date.now; let realTick = 0;
  for (let i = 0; i < 480; i++) { await tape.sweep(); clock += 15_000; }
  const c = tape.curve('T', 'FRONT_PERP', 'BUY', { dMin: 0, dMax: 2, clip: 2 });
  const p0 = c.points.find(p => p.d === 0);
  // 100 fills in ~2h of coverage -> ~50/hr, contracts capped at clip 2 -> ~100/hr; certainly not thousands
  assert.ok(p0.eventsPerHr > 30 && p0.eventsPerHr < 80, 'eventsPerHr ' + p0.eventsPerHr);
  assert.ok(Math.abs(p0.clipContractsPerHr - 2 * p0.eventsPerHr) < 1e-6);
  console.log('ok - fill rate divides by covered time, ignores fills from before coverage (' + p0.eventsPerHr.toFixed(1) + '/hr)');
})().catch(e => { console.error('FAIL', e); process.exit(1); });

// --- fees $0.05/contract/leg, 2 legs per hedged fill; hedge touch smaller than the clip is flagged; pairs gate fair value ---
(async () => {
  const Q2 = require('../../analysis/cde_quotes'), F3 = require('../../analysis/cde_fills');
  const now = Date.now(), ring = F3.createRing();
  for (let i = 60; i >= 0; i--) { const t = now - i * 60_000; ring.add('PERP', t, 10.00, 10.01, 1, 50); ring.add('FUT', t, 10.10, 10.12, 5, 5); }
  const row = { root: 'TST', perp: { productId: 'PERP', contractSize: 100 }, dated: { productId: 'FUT', Tms: 30 * 86400000, contractSize: 100 }, back: null };
  const fv = Q2.createFairValue({ halfLifeMin: 60 });
  for (let i = 60; i >= 0; i--) Q2.updateFairValues(fv, [row], ring, now - i * 60_000, now, ['FRONT_PERP']);
  assert.ok(fv.get('TST|FUT|PERP')); assert.ok(!fv.get('TST|FUT|BACK'));
  const env = { params: { ...Q2.DEFAULTS, warmupMin: 30 }, ring, fv, tickOf: () => 0.01, nowMs: now, snapAtMs: now, tapeCurve: null };
  const q = Q2.buildQuote(row, 'FRONT_PERP', env);
  assert.ok(Math.abs(q.feePerFillUsd - 0.10) < 1e-12);             // (0.03+0.02) x 2 legs
  const rt = Q2.buildQuote(row, 'FRONT_PERP', { ...env, params: { ...env.params, feeBasis: 'roundtrip' } });
  assert.ok(Math.abs(rt.feePerFillUsd - 0.20) < 1e-12);            // open + close
  assert.strictEqual(q.contracts, 2);                               // $2000 / ($100 x 10.11) -> 2 contracts
  assert.strictEqual(q.bid.levels[0].hedgeShort, true);             // perp bid touch is 1 contract < clip of 2
  assert.strictEqual(q.ask.levels[0].hedgeShort, false);            // perp ask touch is 50
  console.log('ok - fees $0.10 per hedged fill ($0.20 round trip), short hedge touch flagged, fair value respects pairs');
})().catch(e => { console.error('FAIL', e); process.exit(1); });

// --- month roll: Oct (front) expires, Nov becomes front, Dec is listed as back ---
(async () => {
  const Q3 = require('../../analysis/cde_quotes'), F4 = require('../../analysis/cde_fills');
  const DAY = 86400000, now = Date.now(), ring = F4.createRing();
  for (let i = 90; i >= 0; i--) { const t = now - i * 60_000; ring.add('PERP', t, 100.00, 100.02); ring.add('NOV', t, 100.50, 100.54); ring.add('OCT', t, 100.05, 100.09); ring.add('DEC', t, 101.00, 101.04); }
  const fv = Q3.createFairValue({ halfLifeMin: 60 });
  const before = { root: 'TST', perp: { productId: 'PERP', contractSize: 100 }, dated: { productId: 'OCT', Tms: 0.5 * DAY, contractSize: 100 }, back: { productId: 'NOV', Tms: 31 * DAY, contractSize: 100 } };
  for (let i = 90; i >= 0; i--) Q3.updateFairValues(fv, [before], ring, now - i * 60_000, now, ['FRONT_PERP', 'BACK_PERP']);
  const after = { root: 'TST', perp: before.perp, dated: { productId: 'NOV', Tms: 31 * DAY, contractSize: 100 }, back: { productId: 'DEC', Tms: 59 * DAY, contractSize: 100 } };
  const env = { params: { ...Q3.DEFAULTS, warmupMin: 30 }, ring, fv, tickOf: () => 0.01, nowMs: now, snapAtMs: now, tapeCurve: null };
  const novFront = Q3.buildQuote(after, 'FRONT_PERP', env);
  assert.ok(novFront.warm && !novFront.error, 'Nov keeps its fair-value history when it becomes the front month: ' + novFront.error);
  const decBack = Q3.buildQuote(after, 'BACK_PERP', env);
  assert.ok(/warming/.test(decBack.error || ''), 'Dec starts fresh');
  const octToday = Q3.buildQuote(before, 'FRONT_PERP', env);
  assert.ok(/under 1 day/.test(octToday.error), 'contract expiring today is not quoted: ' + octToday.error);
  // curve picks fills by contract
  let clock = Date.now();
  const tape = F4.createTape({ fetchJSON: async () => null, getScope: () => [], tickOf: () => 0.01, sleep: async () => {}, now: () => clock });
  await tape.sweep();
  const f = tape.allFills(); const mk = (pid, pair) => ({ root: 'TST', pid, pair, side: 'BUY', dist: 0, size: 1, tMs: clock + 1000 });
  f.push(mk('NOV', 'BACK_PERP'), mk('NOV', 'BACK_PERP'), mk('OCT', 'FRONT_PERP'), mk('DEC', 'BACK_PERP'));
  clock += 60_000 * 10;
  const c = tape.curve('TST', 'FRONT_PERP', 'BUY', { dMin: 0, dMax: 1, pid: 'NOV' });
  assert.strictEqual(c.total, 2);                                   // only Nov's own fills, whichever label they carried
  console.log('ok - month roll: Nov keeps history as front, Dec starts fresh, expiring contract not quoted, curve follows the contract');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
