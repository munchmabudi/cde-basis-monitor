// venues/okx_asset.js — generic OKX fetcher

const config = require('../config');
const BASE = config.endpoints.okx.base;

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OKX ${res.status} (${path})`);
  return res.json();
}

async function getSnapshot(asset) {
  const instId = asset.okxInstId;
  if (!instId) throw new Error(`No OKX instId for ${asset.kalshiTicker}`);

  const [ticker, funding, book] = await Promise.all([
    fetchJson(`/api/v5/market/ticker?instId=${instId}`),
    fetchJson(`/api/v5/public/funding-rate?instId=${instId}`),
    fetchJson(`/api/v5/market/books?instId=${instId}&sz=20`),
  ]);

  const t = ticker.data?.[0];
  if (!t) throw new Error(`OKX: no data for ${instId}`);
  const f = funding.data?.[0];
  const bookData = book.data?.[0];

  const bids = (bookData?.bids ?? [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(l => l.price > 0);
  const asks = (bookData?.asks ?? [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(l => l.price > 0);

  return {
    venue: 'okx',
    asset: instId,
    markPrice: parseFloat(t.markPx ?? t.last ?? 0),
    bestBid:   parseFloat(t.bidPx ?? 0),
    bestAsk:   parseFloat(t.askPx ?? 0),
    fundingRate: parseFloat(f?.fundingRate ?? 0),
    fundingIntervalHours: 8,
    nextFundingTime: f?.nextFundingTime ? new Date(parseInt(f.nextFundingTime)).toISOString() : null,
    bids,
    asks,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
