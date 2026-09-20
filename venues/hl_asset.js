// venues/hl_asset.js — generic Hyperliquid fetcher for any coin

const config = require('../config');

let _metaCache = null;
let _metaCacheTs = 0;
const META_TTL = 60_000; // refresh universe list every 60s

async function postInfo(body) {
  const res = await fetch(`${config.endpoints.hyperliquid.base}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
  return res.json();
}

async function getSnapshot(asset) {
  const coin = asset.hlCoin;
  if (!coin) throw new Error(`No HL coin configured for ${asset.kalshiTicker}`);

  const [metaAndCtxs, l2Book] = await Promise.all([
    postInfo({ type: 'metaAndAssetCtxs' }),
    postInfo({ type: 'l2Book', coin }),
  ]);

  const [meta, assetCtxs] = metaAndCtxs;
  const idx = meta.universe.findIndex(u => u.name === coin);
  if (idx === -1) throw new Error(`HL: coin ${coin} not found`);
  const ctx = assetCtxs[idx];

  const [bidLevels, askLevels] = l2Book.levels;

  return {
    venue: 'hyperliquid',
    asset: coin,
    markPrice: parseFloat(ctx.markPx),
    bestBid:   parseFloat(bidLevels[0]?.px),
    bestAsk:   parseFloat(askLevels[0]?.px),
    fundingRate: parseFloat(ctx.funding),
    fundingIntervalHours: 1,
    nextFundingTime: null,
    bids: bidLevels.map(l => ({ price: parseFloat(l.px), qty: parseFloat(l.sz) })),
    asks: askLevels.map(l => ({ price: parseFloat(l.px), qty: parseFloat(l.sz) })),
    openInterest: parseFloat(ctx.openInterest),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
