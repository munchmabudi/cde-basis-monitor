// capture_cde_settlements.js
//
// Pulls Coinbase's public "Historical Data" page content (Contentful-backed,
// no API key needed — confirmed via browser DevTools: no access_token in the
// URL, Access-Control-Allow-Origin: *, Cache-Control: public) and archives
// the settlement rows into a local growing JSON file.
//
// This exists because the live page appears to only show a rolling few days
// of history (not a queryable date-range API) — running this daily (e.g. via
// Windows Task Scheduler, same pattern as your other monitors) builds up a
// real historical archive over time instead of relying on whatever's visible
// on any single day.
//
// Usage:
//   node capture_cde_settlements.js
//
// Output: appends new (date, symbol) rows to data/cde_settlements.jsonl
// (one JSON object per line, easy to append to safely and to load into any
// analysis tool later). Never overwrites; duplicate (date+symbol) rows are
// skipped so re-running this multiple times a day is harmless.

const fs = require('fs');
const path = require('path');

const URL = 'https://contentful.coinbase.com/spaces/k3n74unfin40/environments/master/entries?content_type=page&include=6&locale=en&fields.slug=%2Fderivatives%2Fhistorical-data';
const OUT_PATH = path.join(__dirname, 'data', 'cde_settlements.jsonl');

// The exact response shape wasn't fully confirmed (only seen via partial
// screenshots of Chrome DevTools), so this walks the WHOLE parsed JSON
// looking for the distinctive { headers: [...], data: [...] } shape rather
// than hardcoding a specific nested path through Contentful's "items" /
// "includes" link-resolution structure. Robust to Contentful restructuring
// how the entry gets linked/included, as long as the actual data object's
// own shape (headers+data siblings) stays the same.
function findHistoricalData(node, seen = new Set()) {
  if (node == null || typeof node !== 'object') return null;
  if (seen.has(node)) return null; // guard against circular refs
  seen.add(node);

  if (Array.isArray(node.headers) && Array.isArray(node.data) && node.data.length &&
      typeof node.data[0] === 'object' && 'symbol' in node.data[0]) {
    return node.data;
  }
  for (const key of Object.keys(node)) {
    const found = findHistoricalData(node[key], seen);
    if (found) return found;
  }
  return null;
}

function loadExistingKeys(outPath) {
  const keys = new Set();
  if (!fs.existsSync(outPath)) return keys;
  const lines = fs.readFileSync(outPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      keys.add(row.date + '|' + row.symbol);
    } catch { /* skip corrupt line */ }
  }
  return keys;
}

async function main() {
  console.log(`[cde-settlements] fetching ${URL}`);
  const res = await fetch(URL, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    console.error(`[cde-settlements] HTTP ${res.status} — this endpoint may now require auth, or the URL/shape changed. Aborting without writing anything.`);
    process.exit(1);
  }
  const json = await res.json();

  const rows = findHistoricalData(json);
  if (!rows) {
    console.error('[cde-settlements] Could not find a { headers, data } block anywhere in the response.');
    console.error('The page structure may have changed. Dumping top-level keys for debugging:');
    console.error(Object.keys(json));
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const existing = loadExistingKeys(OUT_PATH);
  let added = 0, skipped = 0;
  const lines = [];
  for (const row of rows) {
    const key = row.date + '|' + row.symbol;
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    lines.push(JSON.stringify({ capturedAt: new Date().toISOString(), ...row }));
    added++;
  }
  if (lines.length) fs.appendFileSync(OUT_PATH, lines.join('\n') + '\n');

  console.log(`[cde-settlements] fetched ${rows.length} rows from the page, added ${added} new, skipped ${skipped} already-archived`);
  console.log(`[cde-settlements] archive: ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('[cde-settlements] failed:', e.message);
    process.exit(1);
  });
} else {
  module.exports = { findHistoricalData, loadExistingKeys, URL, OUT_PATH };
}
