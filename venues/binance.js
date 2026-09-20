// venues/binance.js
// Public, no-auth endpoints. Binance USDM futures (fapi).

const config = require('../config');

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance request failed: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json();
}

/**
 * Returns a normalized snapshot:
 * {
 *   venue: 'binance',
 *   markPrice: number,
 *   bestBid: number,
 *   bestAsk: number,
 *   fundingRate: number,        // as a decimal, e.g. 0.0001 = 0.01%, per funding interval
 *   fundingIntervalHours: 8,
 *   nextFundingTime: ISOString,
 *   bookDepth: [{price, qty}],  // bids and asks for slippage estimation
 *   timestamp: ISOString,
 * }
 */
async function getSnapshot() {
  const { base, symbol } = config.endpoints.binance;

  const [premiumIndex, bookTicker, depth] = await Promise.all([
    fetchJson(`${base}/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchJson(`${base}/fapi/v1/ticker/bookTicker?symbol=${symbol}`),
    fetchJson(`${base}/fapi/v1/depth?symbol=${symbol}&limit=20`),
  ]);

  return {
    venue: 'binance',
    markPrice: parseFloat(premiumIndex.markPrice),
    bestBid: parseFloat(bookTicker.bidPrice),
    bestAsk: parseFloat(bookTicker.askPrice),
    fundingRate: parseFloat(premiumIndex.lastFundingRate),
    fundingIntervalHours: 8,
    nextFundingTime: new Date(premiumIndex.nextFundingTime).toISOString(),
    bids: depth.bids.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
    asks: depth.asks.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
