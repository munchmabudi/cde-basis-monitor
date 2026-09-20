// venues/coinbase.js
// Coinbase Advanced Trade — BTC-PERP-INTX (US accessible)
// Public endpoints, no auth needed for market data.
// Funding: hourly rate as decimal fraction of notional.
// Fees: 0% maker, 0.03% taker (confirmed docs.cdp.coinbase.com 2026)

const BASE       = 'https://api.coinbase.com';
const PRODUCT_ID = 'BTC-PERP-INTX';

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Coinbase ${res.status} (${path}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getSnapshot() {
  const [product, book] = await Promise.all([
    fetchJson(`/api/v3/brokerage/market/products/${PRODUCT_ID}`),
    fetchJson(`/api/v3/brokerage/market/product_book?product_id=${PRODUCT_ID}&limit=20`),
  ]);

  // Mark price: Coinbase uses 'price' field on the product object for perps
  const markPrice = parseFloat(product.price ?? product.mark_price ?? 0);

  // Funding rate: nested under future_product_details.perpetual_details
  // Expressed as hourly decimal (e.g. 0.000025 = 0.0025%/hr)
  const fundingRate = parseFloat(
    product.future_product_details?.perpetual_details?.funding_rate ?? 0
  );

  const bids = (book.pricebook?.bids ?? [])
    .map(l => ({ price: parseFloat(l.price), qty: parseFloat(l.size) }))
    .filter(l => l.price > 0 && l.qty > 0)
    .sort((a, b) => b.price - a.price); // descending

  const asks = (book.pricebook?.asks ?? [])
    .map(l => ({ price: parseFloat(l.price), qty: parseFloat(l.size) }))
    .filter(l => l.price > 0 && l.qty > 0)
    .sort((a, b) => a.price - b.price); // ascending

  // Filter to within 5% of mark to exclude stale off-market levels
  const lo = markPrice * 0.95;
  const hi = markPrice * 1.05;

  return {
    venue: 'coinbase',
    markPrice,
    bestBid: bids[0]?.price ?? parseFloat(book.pricebook?.bids?.[0]?.price ?? 0),
    bestAsk: asks[0]?.price ?? parseFloat(book.pricebook?.asks?.[0]?.price ?? 0),
    fundingRate,
    fundingIntervalHours: 1,
    nextFundingTime: null,
    bids: bids.filter(l => l.price >= lo),
    asks: asks.filter(l => l.price <= hi),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
