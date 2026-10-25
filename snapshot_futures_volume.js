// snapshot_futures_volume.js
//
// One-shot pull of front/back-month DATED futures volume (24h, USD) for
// every CDE crypto token, printed as a clean table. Perps are excluded on
// purpose (funding_interval present = perp, skipped entirely).
//
// This exists because Claude's own web-fetch tool has a hard response-size
// cap that truncated this same public endpoint partway through the product
// list, every time, regardless of the requested limit. Running it here
// instead has no such limit — it's the identical endpoint the main monitor
// already polls every 30s, just queried once and printed.
//
// Usage:
//   node snapshot_futures_volume.js
//
// Optional: --json to print raw JSON instead of a table (for piping/saving).

const URL = 'https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE';

function fmtDollar(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

async function main() {
  const asJson = process.argv.includes('--json');

  console.log(`[snapshot] fetching ${URL}`);
  const res = await fetch(URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const products = data.products || [];
  console.log(`[snapshot] got ${products.length} total products (dated + perp, crypto + non-crypto)`);

  // Group DATED (non-perp) crypto futures by contract_root_unit, sorted by
  // time_to_expiry_ms ascending so [0]=front, [1]=back — identical logic to
  // the main monitor's buildSnapshot().
  const byRoot = {};
  for (const p of products) {
    const d = p.future_product_details || {};
    if (d.funding_interval) continue;               // perp — skip, not wanted
    if (d.non_crypto) continue;                      // gold/oil/silver/etc — skip
    const root = d.contract_root_unit;
    if (!root || root.startsWith('CDE')) continue;   // synthetic indices — skip
    const Tms = parseFloat(d.time_to_expiry_ms);
    if (!Tms || Tms <= 0) continue;                  // stale/expired — skip (same guard as main monitor)
    const vol = parseFloat(p.approximate_quote_24h_volume);
    (byRoot[root] = byRoot[root] || []).push({
      productId: p.product_id,
      expiry: d.contract_expiry,
      Tms,
      vol: isNaN(vol) ? null : vol,
    });
  }
  for (const root of Object.keys(byRoot)) {
    byRoot[root].sort((a, b) => a.Tms - b.Tms);
  }

  const roots = Object.keys(byRoot).sort();
  const rows = roots.map(root => {
    const [front, back] = byRoot[root];
    return {
      root,
      frontId: front ? front.productId : null,
      frontExpiry: front ? front.expiry : null,
      frontVol: front ? front.vol : null,
      backId: back ? back.productId : null,
      backExpiry: back ? back.expiry : null,
      backVol: back ? back.vol : null,
    };
  });

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`\nGenerated ${new Date().toISOString()} — ${roots.length} tokens with at least one dated future\n`);
  console.log('Token'.padEnd(6), 'Front Expiry'.padEnd(14), 'Front Volume'.padEnd(14), 'Back Expiry'.padEnd(14), 'Back Volume');
  console.log('-'.repeat(70));
  for (const r of rows) {
    const fExp = r.frontExpiry ? r.frontExpiry.slice(0, 10) : '—';
    const bExp = r.backExpiry ? r.backExpiry.slice(0, 10) : '—';
    console.log(
      r.root.padEnd(6),
      fExp.padEnd(14),
      fmtDollar(r.frontVol).padEnd(14),
      bExp.padEnd(14),
      fmtDollar(r.backVol)
    );
  }
}

main().catch(e => {
  console.error('[snapshot] failed:', e.message);
  process.exit(1);
});
