'use strict';
const assert = require('assert');
const { createTrendTracker } = require('../../analysis/cde_funding_trend');
const { buildSnapshot } = require('../../analysis/cde_basis');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

ok('premium trending up over 15-minute windows -> UP', () => {
  const t = createTrendTracker(), t0 = 1_000_000_000_000;
  for (let i = 0; i < 60; i++) t.add('X', t0 + i * 30_000, i < 30 ? 5 : 8);          // 30 min of samples, step up halfway
  assert.strictEqual(t.trend('X', t0 + 60 * 30_000 - 1).dir, 'UP');
});
ok('premium falling -> DOWN, flat -> FLAT, too little history -> no direction', () => {
  const t = createTrendTracker(), t0 = 1_000_000_000_000;
  for (let i = 0; i < 60; i++) t.add('D', t0 + i * 30_000, i < 30 ? 8 : 5);
  for (let i = 0; i < 60; i++) t.add('F', t0 + i * 30_000, 6);
  for (let i = 0; i < 5; i++) t.add('S', t0 + i * 30_000, 6);
  const now = t0 + 60 * 30_000 - 1;
  assert.strictEqual(t.trend('D', now).dir, 'DOWN'); assert.strictEqual(t.trend('F', now).dir, 'FLAT'); assert.strictEqual(t.trend('S', now).dir, null);
});
ok('a predicted-funding field in the feed is picked up and the source recorded', () => {
  const prod = (extra) => ({ product_id: 'T-PERP', mid_market_price: '100', price: '100', future_product_details: { contract_root_unit: 'T', contract_code: 'T', funding_interval: '3600s', funding_rate: '0.00001', index_price: '99.9', contract_size: '1', ...extra } });
  const withPred = buildSnapshot([prod({ next_funding_rate: '0.00003' })], []).rows[0].perp;
  assert.ok(Math.abs(withPred.fundingPred - 0.00003) < 1e-12); assert.strictEqual(withPred.fundingPredSrc, 'details.next_funding_rate');
  assert.ok(withPred.fundPredAPY > withPred.fundAPY);
  const without = buildSnapshot([prod({})], []).rows[0].perp;
  assert.strictEqual(without.fundingPred, null); assert.strictEqual(without.fundPredAPY, null);
});
console.log(`\n${n} checks passed`);
