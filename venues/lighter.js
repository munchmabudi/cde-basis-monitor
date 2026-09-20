// venues/lighter.js
// Lighter DEX (Robinhood Chain / Arbitrum L2)
// Docs: https://apidocs.lighter.xyz
// Base: https://mainnet.zklighter.elliot.ai
//
// Confirmed endpoints from live API 2026-07-12:
//   GET /api/v1/orderBookDetails?market_id=X  → mark_price, index_price, fees
//   GET /api/v1/orderBookOrders?market_id=X&limit=20 → bids/asks
//   GET /api/v1/orderBooks?filter=perp → market list with market_ids
//
// Confirmed market_ids: BTC=1, ETH=0, SOL=2, DOGE=3, XRP=7, LINK=8,
//                       SUI=16, HYPE=24, LTC=35, BCH=58
//
// Fees: 0% maker, 0% taker (confirmed from orderBookDetails response)
// Funding: 1h interval, clamped ±5% small / ±400% big per docs

const BASE = 'https://mainnet.zklighter.elliot.ai';

// Hardcoded market_ids from live API — avoids an extra network call per poll
const MARKET_IDS = {
  BTC: 1, ETH: 0, SOL: 2, DOGE: 3, XRP: 7, LINK: 8,
  SUI: 16, HYPE: 24, LTC: 35, BCH: 58,
};

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Lighter ${res.status} (${path}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function getSnapshot(asset) {
  const coin = asset.hlCoin ?? asset.kalshiTicker.replace('KX','').replace('PERP','');

  const marketId = MARKET_IDS[coin];
  if (marketId === undefined) throw new Error(`Lighter: no market_id for ${coin}`);

  const [details, orders] = await Promise.all([
    fetchJson(`/api/v1/orderBookDetails?market_id=${marketId}`),
    fetchJson(`/api/v1/orderBookOrders?market_id=${marketId}&limit=20`),
  ]);

  const det = details.order_book_details?.[0];
  if (!det) throw new Error(`Lighter: no details for market_id ${marketId}`);

  const markPrice = parseFloat(det.mark_price ?? 0);

  // bids: descending by price (best=highest first) ✅ confirmed from API
  // asks: ascending by price (best=lowest first) ✅ confirmed from API
  // qty field: remaining_base_amount
  const bids = (orders.bids ?? [])
    .map(o => ({ price: parseFloat(o.price), qty: parseFloat(o.remaining_base_amount) }))
    .filter(l => l.price > 0 && l.qty > 0);

  const asks = (orders.asks ?? [])
    .map(o => ({ price: parseFloat(o.price), qty: parseFloat(o.remaining_base_amount) }))
    .filter(l => l.price > 0 && l.qty > 0);

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;

  // Funding rate: base_interest_rate is the per-period anchor.
  // Lighter uses a 1h funding interval; the actual current funding rate
  // isn't returned in the REST snapshot (it's settled on-chain each hour).
  // Use base_interest_rate as a proxy — typically 0.01% per hour = ~87.6%/yr.
  // This is less accurate than HL's live rate but sufficient for comparison.
  const fundingRate = parseFloat(det.base_interest_rate ?? '0.0001') / 100;

  return {
    venue: 'lighter',
    asset: coin,
    markPrice,
    bestBid,
    bestAsk,
    fundingRate,
    fundingIntervalHours: 1,
    nextFundingTime: null,
    bids,
    asks,
    takerFee: parseFloat(det.taker_fee ?? '0'),
    makerFee: parseFloat(det.maker_fee ?? '0'),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getSnapshot };
