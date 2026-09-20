// venues/okx.js
// OKX public market data — no auth needed.
// BTC perpetual: BTC-USDT-SWAP (linear, USDT-margined)
// Funding: every 8 hours.
// Fees: 0.02% maker, 0.05% taker (standard tier)
// Docs: https://www.okx.com/docs-v5/en/

const BASE   = 'https://www.okx.com';
const INSTID = 'BTC-USDT-SWAP';

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OKX ${res.status} (${path}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getSnapshot() {
  const [ticker, funding, book] = await Promise.all([
    fetchJson(`/api/v5/market/ticker?instId=${INSTID}`),
    fetchJson(`/api/v5/public/funding-rate?instId=${INSTID}`),
    fetchJson(`/api/v5/market/books?instId=${INSTID}&sz=20`),
  ]);

  const t = ticker.data?.[0];
  if (!t) throw new Error('OKX: no ticker data');

  const f = funding.data?.[0];
  // fundingRate field is the current rate as a decimal (per 8h period)
  const fundingRate = parseFloat(f?.fundingRate ?? 0);

  const markPrice = parseFloat(t.markPx ?? t.last ?? 0);
  const bestBid   = parseFloat(t.bidPx ?? 0);
  const bestAsk   = parseFloat(t.askPx ?? 0);

  const bookData = book.data?.[0];
  // OKX book format: [[price, qty, liquidated_orders, orders], ...]
  const bids = (bookData?.bids ?? [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(l => l.price > 0);
  const asks = (bookData?.asks ?? [])
    .map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }))
    .filter(l => l.price > 0);

  // OKX returns bids descending, asks ascending — correct already
  return {
    venue: 'okx',
    markPrice,
    bestBid,
    bestAsk,
    fundingRate,
    fundingIntervalHours: 8,
    nextFundingTime: f?.nextFundingTime ? new Date(parseInt(f.nextFundingTime)).toISOString() : null,
    bids,
    asks,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
