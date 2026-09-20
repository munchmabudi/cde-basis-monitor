// debug_books.js — verify order book sort order for all assets and venues
// Bids should be DESCENDING (highest first)
// Asks should be ASCENDING (lowest first)
require('dotenv').config();

const kalshiV   = require('./venues/kalshi_asset');
const hlV       = require('./venues/hl_asset');
const config    = require('./config');

async function checkBook(label, snap) {
  if (!snap || snap.error) { console.log(`  ${label}: ERROR - ${snap?.error}`); return; }

  const prec = snap.markPrice > 100 ? 2 : snap.markPrice > 1 ? 4 : 6;
  const mid  = (snap.bestBid + snap.bestAsk) / 2;
  console.log(`  ${label}: mark=$${snap.markPrice.toFixed(prec)}  bid=$${snap.bestBid.toFixed(prec)}  ask=$${snap.bestAsk.toFixed(prec)}`);

  // Check bids descending
  const bids = snap.bids.slice(0, 5);
  const bidsOk = bids.every((l,i) => i===0 || l.price <= bids[i-1].price);
  console.log(`    Bids (top 5, should be descending): ${bidsOk?'✅':'❌ WRONG ORDER'}`);
  bids.forEach((l,i) => console.log(`      [${i}] $${l.price.toFixed(prec)} qty=${l.qty.toFixed(4)}`));

  // Check asks ascending
  const asks = snap.asks.slice(0, 5);
  const asksOk = asks.every((l,i) => i===0 || l.price >= asks[i-1].price);
  console.log(`    Asks (top 5, should be ascending): ${asksOk?'✅':'❌ WRONG ORDER'}`);
  asks.forEach((l,i) => console.log(`      [${i}] $${l.price.toFixed(prec)} qty=${l.qty.toFixed(4)}`));

  // Check best bid/ask match top of book
  const bidMatch = Math.abs(snap.bestBid - bids[0]?.price) < 0.01;
  const askMatch = Math.abs(snap.bestAsk - asks[0]?.price) < 0.01;
  if (!bidMatch) console.log(`    ⚠️  bestBid $${snap.bestBid.toFixed(prec)} doesn't match top bid $${bids[0]?.price.toFixed(prec)}`);
  if (!askMatch) console.log(`    ⚠️  bestAsk $${snap.bestAsk.toFixed(prec)} doesn't match top ask $${asks[0]?.price.toFixed(prec)}`);

  console.log('');
}

async function run() {
  console.log(`Book verification — ${new Date().toISOString()}\n`);

  for (const [assetKey, asset] of Object.entries(config.assets)) {
    console.log(`═══ ${assetKey} ═══`);
    const [kalshi, hl] = await Promise.all([
      kalshiV.getSnapshot(asset).catch(e => ({ error: e.message })),
      hlV.getSnapshot(asset).catch(e => ({ error: e.message })),
    ]);
    await checkBook('Kalshi', kalshi);
    await checkBook('Hyperliquid', hl);
  }

  console.log('Done.');
}

run().catch(console.error);
