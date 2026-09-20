// serve.js
// Tiny local web server so chart.html can read chart_history.json.
// Run: node serve.js
// Then open: http://localhost:3456 in any browser.
// Leave this running alongside monitor.js (open a second Command Prompt window).

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3456;
const ROOT = __dirname; // serves files from the perp-arb folder

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
};

const server = http.createServer((req, res) => {
  // Default to chart.html
  let urlPath = req.url === '/' ? '/chart.html' : req.url;

  // Strip query string (used for cache-busting in the fetch call)
  urlPath = urlPath.split('?')[0];

  const filePath = path.join(ROOT, urlPath);

  // Security: only serve files inside the perp-arb folder
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end(`Not found: ${urlPath}`);
      return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'text/plain';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache',
      // Allow the page to fetch local files
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] Chart server running at http://localhost:${PORT}`);
  console.log(`[serve] Open that URL in any browser to see the charts`);
  console.log(`[serve] Keep this window open alongside monitor.js\n`);
});
