// venues/coinbase_asset.js — generic Coinbase Advanced Trade fetcher

const config = require('../config');
const BASE = config.endpoints.coinbase.base;

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Coinbase ${res.status} (${path})`);
  return res.json();
}

async function getSnapshot(asset) {
  const productId = asset.coinbaseProductId;
  if (!productId) throw new Error(`No Coinbase productId for ${asset.kalshiTicker}`);

  const [product, book] = await Promise.all([
    fetchJson(`/api/v3/brokerage/market/products/${productId}`),
    fetchJson(`/api/v3/brokerage/market/product_book?product_id=${productId}&limit=20`),
  ]);

  const markPrice  = parseFloat(product.price ?? product.mark_price ?? 0);
  const fundingRate = parseFloat(
    product.future_product_details?.perpetual_details?.funding_rate ?? 0
  );

  const lo = markPrice * 0.95, hi = markPrice * 1.05;

  const bids = (book.pricebook?.bids ?? [])
    .map(l => ({ price: parseFloat(l.price), qty: parseFloat(l.size) }))
    .filter(l => l.price >= lo)
    .sort((a, b) => b.price - a.price);

  const asks = (book.pricebook?.asks ?? [])
    .map(l => ({ price: parseFloat(l.price), qty: parseFloat(l.size) }))
    .filter(l => l.price <= hi)
    .sort((a, b) => a.price - b.price);

  return {
    venue: 'coinbase',
    asset: productId,
    markPrice,
    bestBid: bids[0]?.price ?? 0,
    bestAsk: asks[0]?.price ?? 0,
    fundingRate,
    fundingIntervalHours: 1,
    nextFundingTime: null,
    bids,
    asks,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
