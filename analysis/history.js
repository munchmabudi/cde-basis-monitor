// analysis/history.js — multi-asset version
// Writes one JSON file per asset: data/chart_history_BTC.json etc.

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const MAX_HOURS  = 24 * 7; // keep 7 days
const MAX_POINTS = MAX_HOURS * 60;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFile(assetKey) {
  return path.join(DATA_DIR, `chart_history_${assetKey}.json`);
}

function load(assetKey) {
  try {
    const f = dataFile(assetKey);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch(e) { console.warn(`[history] Load error (${assetKey}):`, e.message); }
  return [];
}

function mid(snap) {
  if (!snap || snap.error) return null;
  const m = (snap.bestBid + snap.bestAsk) / 2;
  return isNaN(m) ? null : m;
}

function annualize(snap) {
  if (!snap || snap.error || snap.fundingRate == null) return null;
  const v = snap.fundingRate * (8760 / snap.fundingIntervalHours) * 100;
  return isNaN(v) ? null : parseFloat(v.toFixed(6));
}

/**
 * Record one poll cycle for one asset.
 * snaps: { kalshi, hyperliquid, kraken, coinbase, okx }
 * assetKey: 'BTC' | 'ETH' | 'SOL' | 'HYPE'
 */
function record(assetKey, snaps) {
  const history    = load(assetKey);
  const kalshiMid  = mid(snaps.kalshi);

  const spread = s => {
    const m = mid(s);
    return (kalshiMid != null && m != null) ? parseFloat((m - kalshiMid).toFixed(4)) : null;
  };

  const point = {
    ts:              new Date().toISOString(),
    kalshiMid,
    hlMid:           mid(snaps.hyperliquid),
    krakenMid:       mid(snaps.kraken),
    coinbaseMid:     mid(snaps.coinbase),
    okxMid:          mid(snaps.okx),
    lighterMid:      mid(snaps.lighter),
    hlSpread:        spread(snaps.hyperliquid),
    krakenSpread:    spread(snaps.kraken),
    coinbaseSpread:  spread(snaps.coinbase),
    okxSpread:       spread(snaps.okx),
    lighterSpread:   spread(snaps.lighter),
    kalshiFunding:   annualize(snaps.kalshi),
    hlFunding:       annualize(snaps.hyperliquid),
    krakenFunding:   annualize(snaps.kraken),
    coinbaseFunding: annualize(snaps.coinbase),
    okxFunding:      annualize(snaps.okx),
    lighterFunding:  annualize(snaps.lighter),
  };

  history.push(point);
  const cutoff = Date.now() - MAX_HOURS * 3600 * 1000;
  const final  = history
    .filter(p => new Date(p.ts).getTime() >= cutoff)
    .slice(-MAX_POINTS);

  try { fs.writeFileSync(dataFile(assetKey), JSON.stringify(final, null, 0)); }
  catch(e) { console.error(`[history] Write error (${assetKey}):`, e.message); }

  return point;
}

module.exports = { record, dataFile };
