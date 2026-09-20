// venues/kraken_asset.js — generic Kraken Futures fetcher

const config = require('../config');
const BASE = config.endpoints.kraken.base;

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Kraken ${res.status} (${path})`);
  return res.json();
}

async function getSnapshot(asset) {
  const ticker = asset.krakenTicker;
  if (!ticker) throw new Error(`No Kraken ticker for ${asset.kalshiTicker}`);

  const [tickers, book, history] = await Promise.all([
    fetchJson('/tickers'),
    fetchJson(`/orderbook?symbol=${ticker}`),
    fetchJson(`/historicalfundingrates?symbol=${ticker}`).catch(() => ({ rates: [] })),
  ]);

  const t = (tickers.tickers ?? []).find(x => x.symbol?.toUpperCase() === ticker.toUpperCase());
  if (!t) throw new Error(`Kraken: ${ticker} not found`);

  const markPrice = parseFloat(t.markPrice ?? t.last);
  const lo = markPrice * 0.95, hi = markPrice * 1.05;

  const bids = (book.orderBook?.bids ?? [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(l => l.price >= lo)
    .sort((a, b) => b.price - a.price);

  const asks = (book.orderBook?.asks ?? [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(l => l.price <= hi)
    .sort((a, b) => a.price - b.price);

  const rates = history.rates ?? [];
  const latestRate = rates[rates.length - 1];
  const fundingRate = latestRate ? parseFloat(latestRate.relativeFundingRate) : 0;

  return {
    venue: 'kraken',
    asset: ticker,
    markPrice,
    bestBid: parseFloat(t.bid ?? bids[0]?.price),
    bestAsk: parseFloat(t.ask ?? asks[0]?.price),
    fundingRate,
    fundingIntervalHours: 4,
    nextFundingTime: null,
    bids,
    asks,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
