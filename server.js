// ═══════════════════════════════════════════════════════════════════
// FINOBASH MARKET DATA PROXY SERVER v2
// Node.js + Express — Railway deployment
// All Yahoo Finance data routed through here — no browser CORS issues
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const https   = require('https');
const app     = express();
const PORT    = process.env.PORT || 8080;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'public, max-age=60');
  next();
});

// ── Generic HTTPS fetch ──
function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(9000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Yahoo Finance fetch (server-side — no CORS) ──
async function yahooFetch(symbol) {
  try {
    const enc = encodeURIComponent(symbol);
    // Try v8 chart first
    const { status, body } = await fetchUrl(
      `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=2d&includePrePost=false`,
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    );
    if (status !== 200) throw new Error('HTTP ' + status);
    const d = JSON.parse(body);
    const m = d?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) throw new Error('No price');
    const chg = m.regularMarketChangePercent ??
      ((m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose * 100);
    return { price: m.regularMarketPrice, chg };
  } catch(e) {
    // Fallback: try v7 quote endpoint
    try {
      const enc = encodeURIComponent(symbol);
      const { body } = await fetchUrl(
        `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${enc}&fields=regularMarketPrice,regularMarketChangePercent`,
        { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      );
      const d = JSON.parse(body);
      const q = d?.quoteResponse?.result?.[0];
      if (!q?.regularMarketPrice) return null;
      return { price: q.regularMarketPrice, chg: q.regularMarketChangePercent ?? 0 };
    } catch { return null; }
  }
}

// ── Yahoo multi-symbol batch (v7 quote — one request for many) ──
async function yahooMulti(symbols) {
  try {
    const joined = symbols.map(s => encodeURIComponent(s)).join(',');
    const { body } = await fetchUrl(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${joined}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketPreviousClose`,
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    );
    const d = JSON.parse(body);
    const results = d?.quoteResponse?.result || [];
    const map = {};
    for (const q of results) {
      if (q.symbol && q.regularMarketPrice) {
        map[q.symbol] = { price: q.regularMarketPrice, chg: q.regularMarketChangePercent ?? 0 };
      }
    }
    return map;
  } catch(e) {
    return {};
  }
}

// ── NSE cookie cache ──
let nseSession = { cookie: '', expiry: 0 };
async function getNseCookie() {
  if (Date.now() < nseSession.expiry) return nseSession.cookie;
  try {
    await new Promise((resolve, reject) => {
      const req = https.get('https://www.nseindia.com/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      }, (res) => {
        nseSession.cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
        nseSession.expiry = Date.now() + 5 * 60 * 1000;
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.setTimeout(6000, () => { req.destroy(); reject(); });
    });
  } catch(e) {}
  return nseSession.cookie;
}

const nseHeaders = async () => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
  'Cookie': await getNseCookie(),
});

// ═══════════════════════════════════════════
// ROUTE: /api/nse/indices
// ═══════════════════════════════════════════
app.get('/api/nse/indices', async (req, res) => {
  try {
    const { body } = await fetchUrl('https://www.nseindia.com/api/allIndices', await nseHeaders());
    const data = JSON.parse(body);
    const indices = (data.data || []).map(idx => ({
      name: idx.index,
      last: idx.last,
      chg:  idx.variation,
      pchg: idx.percentChange,
      prev: idx.previousClose,
    }));
    res.json({ source: 'NSE India', time: new Date().toISOString(), data: indices });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
// ROUTE: /api/nse/gainers-losers
// ═══════════════════════════════════════════
app.get('/api/nse/gainers-losers', async (req, res) => {
  try {
    const { body } = await fetchUrl(
      'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050',
      await nseHeaders()
    );
    const data = JSON.parse(body);
    const stocks = (data.data || [])
      .filter(s => s.symbol !== 'NIFTY 50')
      .map(s => ({
        symbol: s.symbol,
        ltp:    s.lastPrice,
        chg:    s.change,
        pchg:   s.pChange,
      }));
    const gainers = stocks.filter(s => s.pchg > 0).sort((a,b) => b.pchg - a.pchg);
    const losers  = stocks.filter(s => s.pchg < 0).sort((a,b) => a.pchg - b.pchg);
    res.json({
      source: 'NSE India',
      time: new Date().toISOString(),
      gCount: gainers.length,
      lCount: losers.length,
      gainers,
      losers,
    });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════
// ROUTE: /api/yahoo/batch?syms=^GSPC,GC=F,...
// Multi-symbol batch — one call for many symbols
// ═══════════════════════════════════════════
app.get('/api/yahoo/batch', async (req, res) => {
  const symsParam = req.query.syms || '';
  const symbols = symsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'No symbols provided' });

  // Try multi first, fall back to individual parallel fetches
  let map = await yahooMulti(symbols);

  // Any symbols that came back empty — fetch individually
  const missing = symbols.filter(s => !map[s]);
  if (missing.length > 0) {
    const individual = await Promise.allSettled(missing.map(s => yahooFetch(s).then(d => ({ s, d }))));
    for (const r of individual) {
      if (r.status === 'fulfilled' && r.value.d) {
        map[r.value.s] = r.value.d;
      }
    }
  }

  // Return array in same order as requested
  const result = symbols.map(s => map[s] || null);
  res.json({
    source: 'Yahoo Finance',
    time: new Date().toISOString(),
    symbols,
    data: result,
  });
});

// ═══════════════════════════════════════════
// ROUTE: /api/yahoo/:symbol  (single)
// ═══════════════════════════════════════════
app.get('/api/yahoo/:symbol', async (req, res) => {
  const result = await yahooFetch(req.params.symbol);
  if (!result) return res.status(404).json({ error: 'No data' });
  res.json({ symbol: req.params.symbol, ...result, source: 'Yahoo Finance', time: new Date().toISOString() });
});

app.get('/', (req, res) => res.json({
  service: 'FinoBash Market Data Proxy v2',
  endpoints: {
    nse_indices:   'GET /api/nse/indices',
    nse_nifty50:   'GET /api/nse/gainers-losers',
    yahoo_batch:   'GET /api/yahoo/batch?syms=^GSPC,GC=F,USDINR=X',
    yahoo_single:  'GET /api/yahoo/:symbol',
  }
}));

app.listen(PORT, () => console.log(`FinoBash server v2 running on port ${PORT}`));
