// venues/coinbase_spot.js — keyless public Coinbase SPOT price, used as a
// reference-mid fallback for CDE underlyings that Hyperliquid doesn't list.
// Public endpoint, no API key: https://api.coinbase.com/v2/prices/{SYM}-USD/spot
// This is a SPOT mid, NOT a CDE book — used only to anchor the CDE quote mid.

const BASE = 'https://api.coinbase.com';

async function getSnapshot(symbol) {
  // symbol e.g. 'BTC', 'kSHIB', 'AVAX'
  const url = `${BASE}/v2/prices/${symbol}-USD/spot`;
  const res = await fetch(url, { headers: { 'User-Agent': 'coinbase_spot' } });
  if (!res.ok) throw new Error(`coinbase_spot ${symbol} HTTP ${res.status}`);
  const j = await res.json();
  const price = parseFloat(j?.data?.amount);
  if (!isFinite(price) || price <= 0) throw new Error(`coinbase_spot ${symbol} bad price`);
  return {
    venue: 'coinbase_spot',
    symbol,
    bestBid: price,
    bestAsk: price,
    bids: [{ price, qty: 1e12 }],
    asks: [{ price, qty: 1e12 }],
  };
}

module.exports = { getSnapshot };
