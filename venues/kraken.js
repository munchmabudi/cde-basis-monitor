// venues/kraken.js — fixed 2026-06-30
// Debug showed bids returning [$1, $2, $589...] — stale/garbage resting orders
// far off-market that poison the slippage walk. Fix: filter levels to within
// 5% of mark price, which is the only range relevant for realistic fills.

const TICKER = 'PF_XBTUSD';
const BASE   = 'https://futures.kraken.com/derivatives/api/v3';

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kraken ${res.status} (${path}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getSnapshot() {
  const [tickers, book, history] = await Promise.all([
    fetchJson('/tickers'),
    fetchJson(`/orderbook?symbol=${TICKER}`),
    fetchJson(`/historicalfundingrates?symbol=${TICKER}`).catch(() => ({ rates: [] })),
  ]);

  const t = (tickers.tickers ?? []).find((x) => x.symbol?.toUpperCase() === TICKER);
  if (!t) throw new Error(`Kraken: ${TICKER} not found in tickers`);

  const markPrice = parseFloat(t.markPrice ?? t.last);

  // Filter book to within 5% of mark — removes garbage stale orders
  const priceBand = 0.05;
  const lo = markPrice * (1 - priceBand);
  const hi = markPrice * (1 + priceBand);

  const rawBids = (book.orderBook?.bids ?? [])
    .map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) }))
    .filter((l) => l.price >= lo)   // drop bids absurdly below market
    .sort((a, b) => b.price - a.price); // ensure descending (highest bid first)

  const rawAsks = (book.orderBook?.asks ?? [])
    .map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) }))
    .filter((l) => l.price <= hi)   // drop asks absurdly above market
    .sort((a, b) => a.price - b.price); // ensure ascending (lowest ask first)

  // relativeFundingRate from historical = per-4h rate as fraction of mark price
  const rates = history.rates ?? [];
  const latestRate = rates[rates.length - 1];
  const fundingRate = latestRate
    ? parseFloat(latestRate.relativeFundingRate)
    : 0;

  return {
    venue: 'kraken',
    markPrice,
    bestBid: parseFloat(t.bid ?? rawBids[0]?.price),
    bestAsk: parseFloat(t.ask ?? rawAsks[0]?.price),
    fundingRate,
    fundingIntervalHours: 4,
    nextFundingTime: null,
    bids: rawBids,
    asks: rawAsks,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
