// diagnose.js
// Run this FIRST, before monitor.js, to verify that live API responses
// match the field names assumed in venues/kalshi.js. Prints raw JSON
// from all three venues to stdout so you can inspect and fix any
// field-name mismatches before relying on the monitor.
//
// Usage:
//   node diagnose.js
//
// You do NOT need Kalshi API keys - market data is public.

require('dotenv').config();
const config = require('./config');

async function fetchRaw(label, url, opts = {}) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`FETCHING: ${label}`);
  console.log(`  ${opts.method ?? 'GET'} ${url}`);
  if (opts.body) console.log(`  body: ${opts.body}`);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...opts.headers },
      body: opts.body,
    });
    const text = await res.text();
    console.log(`  status: ${res.status}`);
    try {
      const json = JSON.parse(text);
      console.log('  response:', JSON.stringify(json, null, 2).slice(0, 3000));
    } catch {
      console.log('  response (raw):', text.slice(0, 1000));
    }
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
  }
}

async function run() {
  console.log('BTC PERP ARB - VENUE DIAGNOSTICS');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Notional for fill estimation: $${config.notionalUsd.toLocaleString()}`);

  // ── BINANCE ──────────────────────────────────────────────────────
  const { base: bnBase, symbol } = config.endpoints.binance;
  await fetchRaw('Binance premiumIndex', `${bnBase}/fapi/v1/premiumIndex?symbol=${symbol}`);
  await fetchRaw('Binance bookTicker',   `${bnBase}/fapi/v1/ticker/bookTicker?symbol=${symbol}`);
  await fetchRaw('Binance depth (10)',   `${bnBase}/fapi/v1/depth?symbol=${symbol}&limit=10`);

  // ── HYPERLIQUID ───────────────────────────────────────────────────
  const hlBase = config.endpoints.hyperliquid.base;
  const hlCoin  = config.endpoints.hyperliquid.coin;
  await fetchRaw(
    'Hyperliquid metaAndAssetCtxs',
    `${hlBase}/info`,
    { method: 'POST', body: JSON.stringify({ type: 'metaAndAssetCtxs' }) }
  );
  await fetchRaw(
    `Hyperliquid l2Book (${hlCoin})`,
    `${hlBase}/info`,
    { method: 'POST', body: JSON.stringify({ type: 'l2Book', coin: hlCoin }) }
  );

  // ── KALSHI ────────────────────────────────────────────────────────
  // This is the part most likely to need fixes. Run this script, look at
  // what comes back, then update venues/kalshi.js parseSnapshot() to match.
  const { base: kBase, ticker } = config.endpoints.kalshi;

  // 1. List all margin markets - this will confirm the exact ticker string
  //    and what fields are on a market object.
  await fetchRaw('Kalshi margin markets (list)',  `${kBase}/margin/markets`);

  // 2. Specific market by ticker (assumed path - may be /margin/markets?ticker=X
  //    or /margin/markets/KXBTCPERP depending on API design).
  await fetchRaw(`Kalshi market: ${ticker}`,      `${kBase}/margin/markets/${ticker}`);

  // 3. Funding endpoint candidates - try both common conventions.
  await fetchRaw(`Kalshi funding (path A)`,       `${kBase}/margin/markets/${ticker}/funding`);
  await fetchRaw(`Kalshi funding (path B)`,       `${kBase}/margin/funding?ticker=${ticker}`);

  // 4. Order book.
  await fetchRaw(`Kalshi orderbook`,              `${kBase}/margin/markets/${ticker}/orderbook`);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('DIAGNOSTICS COMPLETE');
  console.log('');
  console.log('Next steps:');
  console.log('1. Find the correct ticker string in the Kalshi markets list above');
  console.log('   and update config.endpoints.kalshi.ticker if needed.');
  console.log('2. Find the mark price, bid, ask field names on the market object');
  console.log('   and update the parseSnapshot() function in venues/kalshi.js.');
  console.log('3. Find the funding rate field name and update parseSnapshot() accordingly.');
  console.log('4. Once all three venues show valid JSON with recognizable fields,');
  console.log('   run: node monitor.js');
}

run().catch((e) => {
  console.error('Fatal error in diagnostics:', e);
  process.exit(1);
});
