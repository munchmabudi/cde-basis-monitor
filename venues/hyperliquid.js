// venues/hyperliquid.js
// Public, no-auth POST /info endpoint.

const config = require('../config');

async function postInfo(body) {
  const { base } = config.endpoints.hyperliquid;
  const res = await fetch(`${base}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Returns the same normalized shape as binance.js / kalshi.js.
 *
 * Hyperliquid funding is hourly (not 8h like Binance/Kalshi), so
 * fundingIntervalHours is 1 here. The comparison layer normalizes
 * everything to an annualized rate before comparing across venues.
 */
async function getSnapshot() {
  const { coin } = config.endpoints.hyperliquid;

  const [metaAndCtxs, l2Book] = await Promise.all([
    postInfo({ type: 'metaAndAssetCtxs' }),
    postInfo({ type: 'l2Book', coin }),
  ]);

  const [meta, assetCtxs] = metaAndCtxs;
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx === -1) throw new Error(`Hyperliquid: coin ${coin} not found in universe`);
  const ctx = assetCtxs[idx];

  // l2Book levels: [bidsArray, asksArray], each level {px, sz, n}
  const [bidLevels, askLevels] = l2Book.levels;
  const bestBid = parseFloat(bidLevels[0].px);
  const bestAsk = parseFloat(askLevels[0].px);

  return {
    venue: 'hyperliquid',
    markPrice: parseFloat(ctx.markPx),
    bestBid,
    bestAsk,
    fundingRate: parseFloat(ctx.funding), // per-hour rate as decimal
    fundingIntervalHours: 1,
    nextFundingTime: null, // HL settles on the hour, every hour - no explicit field needed
    bids: bidLevels.map((l) => ({ price: parseFloat(l.px), qty: parseFloat(l.sz) })),
    asks: askLevels.map((l) => ({ price: parseFloat(l.px), qty: parseFloat(l.sz) })),
    openInterest: parseFloat(ctx.openInterest),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
