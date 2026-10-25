const path = require('path').join(__dirname, '..', '..', 'analysis', 'cde_basis_bidask.js');
const m = require(path);
let fails = 0;
function ok(name, cond, extra) { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); }
const close = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;

// ---- parseBook
const good = m.parseBook({ pricebook: { bids: [{ price: '99', size: '5' }, { price: '99.5', size: '7' }], asks: [{ price: '101', size: '3' }, { price: '100.5', size: '9' }], time: 'T' } });
ok('parseBook picks best bid/ask regardless of order', good.bid === 99.5 && good.ask === 100.5 && good.bidSize === 7 && good.askSize === 9 && close(good.mid, 100));
ok('parseBook empty side -> error', !!m.parseBook({ pricebook: { bids: [], asks: [{ price: '1', size: '1' }] } }).error);
ok('parseBook crossed -> error', m.parseBook({ pricebook: { bids: [{ price: '102', size: '1' }], asks: [{ price: '101', size: '1' }] } }).error === 'crossed book');
ok('parseBook garbage -> error', !!m.parseBook({}).error && !!m.parseBook(null).error);
ok('parseBook locked (bid==ask) allowed', !m.parseBook({ pricebook: { bids: [{ price: '100', size: '1' }], asks: [{ price: '100', size: '1' }] } }).error);

// ---- computePair, hand-computed
// A=FRONT 100.0/100.2, B=PERP 99.0/99.1, 30d horizon, ref = B mid 99.05
const A = { bid: 100.0, ask: 100.2, mid: 100.1, bidSize: 10, askSize: 20, contractSize: 0.01 };
const B = { bid: 99.0, ask: 99.1, mid: 99.05, bidSize: 30, askSize: 40, contractSize: 1 };
const H = 30 * 86400000;
const c = m.computePair(A, B, 99.05, H);
const ann = 365 / 30 * 100;
ok('shortA edge', close(c.shortAEdge, (100.0 - 99.1) / 99.05 * ann), c.shortAEdge.toFixed(4) + ' (expect 11.0551)');
ok('longA edge', close(c.longAEdge, (99.0 - 100.2) / 99.05 * ann), c.longAEdge.toFixed(4) + ' (expect -14.7400)');
ok('mid edge', close(c.midShortA, 1.05 / 99.05 * ann), c.midShortA.toFixed(4) + ' (expect 12.8975)');
ok('crossCost', close(c.crossCost, 0.15 / 99.05 * ann), c.crossCost.toFixed(4) + ' (expect 1.8425)');
ok('mid - cost = executable', close(c.bestMidEdge - c.crossCost, c.bestExecEdge));
ok('best direction is SHORT_A', c.best === 'SHORT_A');
// touch for Short A/Long B: A bid side 10*0.01*100=10 ; B ask side 40*1*99.1=3964 -> min 10
ok('touch notional = min of crossed legs', close(c.touchUsd, 10), String(c.touchUsd));
ok('not unreliable at 30d', c.unreliable === false);

// opposite direction: flip so Long A is better. A cheap vs B
const A2 = { bid: 97.0, ask: 97.2, mid: 97.1, bidSize: 10, askSize: 20, contractSize: 1 };
const c2 = m.computePair(A2, B, 99.05, H);
ok('flipped market picks LONG_A', c2.best === 'LONG_A');
ok('LONG_A edge = (B.bid - A.ask)/ref', close(c2.longAEdge, (99.0 - 97.2) / 99.05 * ann));
ok('LONG_A bestMidEdge sign flipped', close(c2.bestMidEdge, -(97.1 - 99.05) / 99.05 * ann));
ok('LONG_A mid - cost = exec', close(c2.bestMidEdge - c2.crossCost, c2.bestExecEdge));
// touch for Long A/Short B: A ask 20*1*97.2 ; B bid 30*1*99 = 2970 -> min = 1944
ok('LONG_A touch uses ask of A, bid of B', close(c2.touchUsd, 1944), String(c2.touchUsd));

// guards
ok('horizon < 24h flagged unreliable', m.computePair(A, B, 99.05, 3 * 3600000).unreliable === true);
ok('null on zero horizon', m.computePair(A, B, 99.05, 0) === null);
ok('null on missing leg', m.computePair(null, B, 99.05, H) === null);
ok('touch null when contractSize unknown', m.computePair({ ...A, contractSize: null }, B, 99.05, H).touchUsd === null);

// ---- buildBidAskRows
const day = 86400000;
const snapRow = {
  root: 'BTC', flags: [],
  perp: { productId: 'P', contractSize: 1, fundAPY: 10 },
  dated: { productId: 'F', contractSize: 1, Tms: 30 * day },
  back: { productId: 'K', contractSize: 1, Tms: 60 * day },
};
const mkBook = (bid, ask) => ({ bid, ask, mid: (bid + ask) / 2, bidSize: 100, askSize: 100, time: new Date().toISOString() });
const books = new Map([['P', mkBook(99.9, 100.1)], ['F', mkBook(100.9, 101.1)], ['K', mkBook(102.4, 102.6)]]);
const res = m.buildBidAskRows([snapRow], books);
ok('3 pair rows for a full token', res.rows.length === 3, res.rows.map(r => r.pair).join(','));
const fp = res.rows.find(r => r.pair === 'FRONT_PERP');
// F mid 101, P mid 100: short F/long P : (100.9-100.1)/100 * (365/30*100)
ok('FRONT_PERP exec edge', close(fp.bestExecEdge, 0.8 / 100 * 365 / 30 * 100), fp.bestExecEdge.toFixed(3));
ok('FRONT_PERP direction', fp.direction === 'Short FRONT / Long PERP');
ok('long perp PAYS funding (fundAPY=+10 -> -10)', close(fp.fundingEffect, -10));
ok('net = exec + funding effect', close(fp.netOfFunding, fp.bestExecEdge - 10));
const fb = res.rows.find(r => r.pair === 'FRONT_BACK');
// B(back) mid 102.5, A(front) mid 101; horizon = 30d; ref = front mid. Long front/short back: (K.bid - F.ask)/F.mid = (102.4-101.1)/101
ok('FRONT_BACK uses back-front horizon (30d)', close(fb.horizonDays, 30));
ok('FRONT_BACK direction long front / short back', fb.direction === 'Long FRONT / Short BACK');
ok('FRONT_BACK exec edge', close(fb.bestExecEdge, (102.4 - 101.1) / 101 * 365 / 30 * 100), fb.bestExecEdge.toFixed(3));
ok('FRONT_BACK has no funding', fb.fundingEffect === null);
const bp = res.rows.find(r => r.pair === 'BACK_PERP');
ok('BACK_PERP horizon = back Tms (60d)', close(bp.horizonDays, 60));
// short-perp direction => receives funding
const snapRow2 = { ...snapRow, perp: { ...snapRow.perp, fundAPY: 10 } };
const books2 = new Map([['P', mkBook(103.9, 104.1)], ['F', mkBook(100.9, 101.1)], ['K', mkBook(102.4, 102.6)]]);
const fp2 = m.buildBidAskRows([snapRow2], books2).rows.find(r => r.pair === 'FRONT_PERP');
ok('Long FRONT / Short PERP when perp rich', fp2.direction === 'Long FRONT / Short PERP');
ok('short perp RECEIVES funding (+10)', close(fp2.fundingEffect, 10));

// missing / failed books
const books3 = new Map([['P', { error: 'HTTP 429' }], ['F', mkBook(100.9, 101.1)], ['K', mkBook(102.4, 102.6)]]);
const r3 = m.buildBidAskRows([snapRow], books3);
ok('failed perp book -> perp pairs are error rows with reason', r3.rows.filter(r => r.error).length === 2 && r3.rows.find(r => r.pair === 'FRONT_PERP').error === 'HTTP 429');
ok('front/back pair still computed', !r3.rows.find(r => r.pair === 'FRONT_BACK').error);
ok('stats count failed legs', r3.stats.legsFailed === 1 && r3.stats.legsOk === 2);
// perp-only token: no pairs; hidden token skipped
ok('perp-only token yields no rows', m.buildBidAskRows([{ root: 'ZEC', perp: { productId: 'Z', contractSize: 1, fundAPY: 5 }, dated: null, back: null }], new Map()).rows.length === 0);
ok('hidden token skipped', m.buildBidAskRows([snapRow], books, { BTC: true }).rows.length === 0);
ok('productIdsNeeded', JSON.stringify(m.productIdsNeeded([snapRow, { root: 'ZEC', perp: { productId: 'Z' }, dated: null, back: null }])) === JSON.stringify(['P', 'F', 'K']));

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
