// test_alert.js — sends consolidated MM sim table with live prices
require('dotenv').config({ path: 'C:\\Users\\ethan\\OneDrive\\Desktop\\perp-arb\\.env' });

const kalshiV  = require('./venues/kalshi_asset');
const hlV      = require('./venues/hl_asset');
const config   = require('./config');
const { simulate }                   = require('./analysis/mm_sim');
const { buildConsolidatedMMMessage } = require('./alerts/mm_sim_alert');
const { sendMessage }                = require('./alerts/telegram');

async function run() {
  console.log('Fetching live prices for all assets...\n');

  const mmResults = [];
  for (const [assetKey, asset] of Object.entries(config.assets)) {
    try {
      const [kalshi, hl] = await Promise.all([
        kalshiV.getSnapshot(asset),
        hlV.getSnapshot(asset),
      ]);
      const prec   = kalshi.markPrice > 100 ? 0 : 3;
      const kMid   = (kalshi.bestBid + kalshi.bestAsk) / 2;
      const hMid   = (hl.bestBid + hl.bestAsk) / 2;
      const hlSprd = ((hl.bestAsk - hl.bestBid) / hMid * 10000).toFixed(2);
      console.log(`[${assetKey}] Kalshi mid $${kMid.toFixed(prec)}  HL mid $${hMid.toFixed(prec)}  HL spread ${hlSprd}bps`);

      const sim = simulate(kalshi, hl, asset.notionalUsd);
      mmResults.push({ assetKey, sim, hlSnap: hl, kalshiSnap: kalshi });
    } catch(e) {
      console.error(`[${assetKey}] Error: ${e.message}`);
    }
  }

  if (mmResults.length > 0) {
    console.log('\nSending consolidated table...');
    await sendMessage(buildConsolidatedMMMessage(mmResults));
    console.log('Done — check Telegram.');
  }
}

run().catch(console.error);
