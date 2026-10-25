const m = require(require('path').join(__dirname, '..', '..', 'analysis', 'cde_basis_positions.js'));
const fs = require('fs'), os = require('os'), path = require('path');
let fails = 0; const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const close = (a, b, t = 1e-6) => a != null && Math.abs(a - b) < t;
const DAY = 86400000;

const octRow = (over = {}) => ({
  root: 'AVAX', flags: [],
  perp: { productId: 'AVP', fundAPY: -14.02 },
  dated: { productId: 'AVF-OCT', basisAPY: 6.60, Tms: 10 * DAY, expiry: '2026-10-30T16:00:00Z' },
  back: { productId: 'AVK-NOV', basisAPY: 7.5, Tms: 40 * DAY, expiry: '2026-11-27T16:00:00Z' },
  ...over,
});
const rows = [octRow(), { root: 'ZEC', flags: [], perp: { productId: 'ZP', fundAPY: 5 }, dated: null, back: null }];
const mk = (instrument, side, extra = {}) => m.buildPosition({ root: 'AVAX', instrument, side, ...extra }, rows).position;
const ev = (pos, rs = rows, now) => m.evaluatePosition(pos, rs, now);

// ---- sign rule: receive when short & positive, or long & negative
ok('Perp LONG, funding -14.02 -> yourApy +14.02 (long & negative = receive)', close(ev(mk('PERP', 'LONG')).yourApy, 14.02));
ok('Perp SHORT, funding -14.02 -> yourApy -14.02 (you pay)', close(ev(mk('PERP', 'SHORT')).yourApy, -14.02));
ok('Front outright SHORT, basis +6.60 -> +6.60', close(ev(mk('FRONT', 'SHORT')).yourApy, 6.60));
ok('Front outright LONG, basis +6.60 -> -6.60', close(ev(mk('FRONT', 'LONG')).yourApy, -6.60));
ok('Back outright uses back basis 7.5', close(ev(mk('BACK', 'SHORT')).marketApy, 7.5));
// ---- spreads = APY(A) - APY(B), same as the other tabs
const fp = ev(mk('FRONT_PERP', 'SHORT'));
ok('1-Perp market APY = 6.60 - (-14.02) = 20.62', close(fp.marketApy, 20.62), String(fp.marketApy));
ok('SHORT 1-Perp spread (short front/long perp), rich -> +20.62', close(fp.yourApy, 20.62));
ok('LONG 1-Perp spread -> -20.62', close(ev(mk('FRONT_PERP', 'LONG')).yourApy, -20.62));
ok('2-Perp market APY = 7.5 + 14.02 = 21.52', close(ev(mk('BACK_PERP', 'SHORT')).marketApy, 21.52));
ok('1-2 market APY = 6.60 - 7.5 = -0.90', close(ev(mk('FRONT_BACK', 'LONG')).marketApy, -0.90));
ok('LONG 1-2 spread (negative) -> +0.90 (receive)', close(ev(mk('FRONT_BACK', 'LONG')).yourApy, 0.90));
ok('matches Overview math: Front-Perp market APY equals row basis - funding', close(fp.marketApy, 6.60 - (-14.02)));
// ---- $ carry
const big = ev(mk('FRONT_PERP', 'SHORT', { notional: '250k' }));
ok('est $/yr = 250,000 x 20.62% = 51,550', close(big.estUsdYr, 51550, 0.01), String(big.estUsdYr));
ok('no notional -> est $/yr null', ev(mk('FRONT_PERP', 'SHORT')).estUsdYr === null);

// ---- parseNotional / validation
ok('parseNotional forms', m.parseNotional('250k') === 250000 && m.parseNotional('$1,500,000') === 1.5e6 && m.parseNotional('1.5m') === 1.5e6 && m.parseNotional('') === null && Number.isNaN(m.parseNotional('abc')) && Number.isNaN(m.parseNotional('-5')));
ok('zero notional rejected', !!m.buildPosition({ root: 'AVAX', instrument: 'PERP', side: 'LONG', notional: '0' }, rows).error);
ok('junk notional rejected', !!m.buildPosition({ root: 'AVAX', instrument: 'PERP', side: 'LONG', notional: 'lots' }, rows).error);
ok('bad side rejected', !!m.buildPosition({ root: 'AVAX', instrument: 'PERP', side: 'FLAT' }, rows).error);
ok('unknown token rejected', !!m.buildPosition({ root: 'NOPE', instrument: 'PERP', side: 'LONG' }, rows).error);
ok('unknown instrument rejected', !!m.buildPosition({ root: 'AVAX', instrument: 'XYZ', side: 'LONG' }, rows).error);
ok('instrument the token lacks rejected (ZEC has no front)', /doesn't currently have/.test(m.buildPosition({ root: 'ZEC', instrument: 'FRONT_PERP', side: 'LONG' }, rows).error));
ok('note trimmed to 120 chars', mk('PERP', 'LONG', { note: 'x'.repeat(500) }).note.length === 120);
const p1 = mk('FRONT_PERP', 'SHORT');
ok('position pinned to concrete contracts + readable label', p1.aId === 'AVF-OCT' && p1.bId === 'AVP' && p1.label === 'AVAX 30OCT26 − PERP' && p1.kind === 'SPREAD', JSON.stringify([p1.aId, p1.bId, p1.label]));
const edited = m.buildPosition({ side: 'LONG', notional: '1m', note: 'edited', root: 'IGNORED', instrument: 'PERP' }, rows, p1).position;
ok('edit changes side/notional/note only; contracts + token unchanged', edited.side === 'LONG' && edited.notionalUsd === 1e6 && edited.aId === 'AVF-OCT' && edited.root === 'AVAX' && edited.id === p1.id);
ok('availableInstruments: AVAX has all 6', m.availableInstruments(rows[0]).length === 6, m.availableInstruments(rows[0]).map(o => o.key).join(','));
ok('availableInstruments: perp-only token has just PERP', m.availableInstruments(rows[1]).map(o => o.key).join() === 'PERP');
ok('instrument label readable', m.availableInstruments(rows[0]).find(o => o.key === 'FRONT_PERP').name === 'AVAX 30OCT26 − PERP  (1–Perp spread)', m.availableInstruments(rows[0]).find(o => o.key === 'FRONT_PERP').name);

// ---- EXPIRY / ROLL: positions follow the CONTRACT, not the "front/back" label
const novPos = mk('BACK_PERP', 'SHORT');   // entered while Nov was the BACK
const octPos = mk('FRONT_PERP', 'SHORT');  // entered while Oct was the FRONT
const afterExpiry = [{
  root: 'AVAX', flags: [],
  perp: { productId: 'AVP', fundAPY: -14.02 },
  dated: { productId: 'AVK-NOV', basisAPY: 7.4, Tms: 27 * DAY, expiry: '2026-11-27T16:00:00Z' },   // Nov is now FRONT
  back: { productId: 'AVD-DEC', basisAPY: 8.0, Tms: 57 * DAY, expiry: '2026-12-25T16:00:00Z' },    // Dec is the new BACK
}];
const after = Date.parse('2026-10-31T00:00:00Z');
const novAfter = ev(novPos, afterExpiry, after);
ok('Nov position keeps tracking Nov after Oct expires', novAfter.status === 'OK' && close(novAfter.marketApy, 7.4 + 14.02), JSON.stringify([novAfter.status, novAfter.marketApy]));
ok('...and is now described as the 1-Perp spread', novAfter.nowAs === '1–Perp spread', novAfter.nowAs);
ok('...with its original label unchanged', novAfter.label === 'AVAX 27NOV26 − PERP', novAfter.label);
const octAfter = ev(octPos, afterExpiry, after);
ok('Oct position reports EXPIRED instead of silently switching to Nov', octAfter.status === 'EXPIRED' && octAfter.yourApy === null, octAfter.status);
const ghost = { ...novPos, aId: 'NOT-A-REAL-ID', aExpiry: '2027-03-26T16:00:00Z' };
ok('future contract no longer front/back -> NOT_TRACKED (not "expired")', ev(ghost, afterExpiry, after).status === 'NOT_TRACKED');
ok('token vanished from feed -> NO_DATA', ev(novPos, [], after).status === 'NO_DATA');
ok('missing funding -> NO_DATA, not a crash', ev(mk('FRONT_PERP', 'LONG'), [octRow({ perp: { productId: 'AVP', fundAPY: null } })]).status === 'NO_DATA');

// ---- unreliable flag is leg-specific
ok('front leg <24h to expiry -> unreliable', ev(mk('FRONT_PERP', 'SHORT'), [octRow({ dated: { productId: 'AVF-OCT', basisAPY: 6.6, Tms: 3 * 3600000, expiry: '2026-10-30T16:00:00Z' } })]).unreliable === true);
ok('SUSPECT flag -> unreliable', ev(mk('PERP', 'LONG'), [octRow({ flags: ['SUSPECT'] })]).unreliable === true);
ok('front EXPIRING does NOT taint a back-vs-perp position', ev(mk('BACK_PERP', 'SHORT'), [octRow({ flags: ['EXPIRING'] })]).unreliable === false);
ok('stale perp taints a perp position', ev(mk('PERP', 'LONG'), [octRow({ flags: ['STALE_PERP'] })]).unreliable === true);
ok('stale perp does NOT taint a front outright', ev(mk('FRONT', 'LONG'), [octRow({ flags: ['STALE_PERP'] })]).unreliable === false);

// ---- ranking + summary
const e1 = ev(mk('FRONT_PERP', 'SHORT', { notional: '250k' }));                 // +20.62
const e2 = ev(mk('FRONT', 'LONG', { notional: '100k' }));                        // -6.60
const e3 = ev(mk('PERP', 'LONG'));                                               // +14.02
const e4 = ev(mk('PERP', 'SHORT'), [octRow({ flags: ['SUSPECT'] })]);            // unreliable (would be -14.02)
const e5 = ev(octPos, afterExpiry, after);                                       // expired
const ranked = m.rankEvaluated([e2, e4, e1, e5, e3]);
ok('ranked best-first, unreliable/expired sink', ranked.map(e => e.yourApy === null ? 'x' : e.yourApy.toFixed(2)).join() === '20.62,14.02,-6.60,-14.02,x', ranked.map(e => e.yourApy === null ? 'x' : e.yourApy.toFixed(2)).join());
const s = m.summarize([e1, e2, e3, e4, e5]);
ok('weighted avg = (250k*20.62 + 100k*-6.60)/350k = 12.8429', close(s.weightedYourApy, (250000 * 20.62 - 100000 * 6.60) / 350000, 1e-6), String(s.weightedYourApy));
ok('total est $/yr = 51,550 - 6,600 = 44,950', close(s.totalEstUsdYr, 44950, 0.01), String(s.totalEstUsdYr));
ok('counts: 5 positions, 3 scored, 2 unscored, 2 weighted', s.count === 5 && s.scored === 3 && s.unscored === 2 && s.weightedCount === 2, JSON.stringify(s));
ok('empty list summary safe', m.summarize([]).weightedYourApy === null);

// ---- persistence
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-')), file = path.join(dir, 'data', 'my.json');
ok('missing file -> []', m.loadMyPositions(file).length === 0);
m.saveMyPositions(file, [p1, octPos]);
const back = m.loadMyPositions(file);
ok('save/load roundtrip', back.length === 2 && back[0].id === p1.id && back[0].aId === 'AVF-OCT');
ok('atomic write leaves no .tmp file', !fs.existsSync(file + '.tmp'));
fs.writeFileSync(file, '{ this is not json');
ok('corrupt file -> [] without throwing', m.loadMyPositions(file).length === 0);
ok('corrupt file was set aside (not left to be overwritten)', !fs.existsSync(file) && fs.readdirSync(path.dirname(file)).some(f => f.startsWith('my.json.unreadable-')) && fs.readFileSync(path.join(path.dirname(file), fs.readdirSync(path.dirname(file)).find(f => f.startsWith('my.json.unreadable-'))), 'utf8') === '{ this is not json');
fs.writeFileSync(file, JSON.stringify({ positions: 'nope' }));
ok('wrong shape -> []', m.loadMyPositions(file).length === 0);
ok('esc neutralizes markup', m.esc('<img src=x onerror=alert(1)>"\'&') === '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS'); process.exit(fails ? 1 : 0);
