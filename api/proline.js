// Vercel Serverless Proxy for ProLine Partner API
// Fetches ALL projects by following `total`, with patient 429 retry.
// Browser makes ONE request and receives the complete array.

const PROLINE_URL = 'https://api.proline.app/v1/list/projects';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Fetch one page. On 429, wait and retry (patient). Returns parsed page.
async function fetchPage(body, headers, attempt) {
  attempt = attempt || 0;
  const res = await fetch(PROLINE_URL, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  });

  if (res.status === 429) {
    if (attempt >= 3) {
      return { http: 429, results: [], total: null, raw: '429-giveup' };
    }
    await sleep(800 + 500 * attempt); // 0.8s, 1.3s, 1.8s = 3.9s max per page
    return fetchPage(body, headers, attempt + 1);
  }

  let raw = '';
  let json = {};
  try { raw = await res.text(); json = JSON.parse(raw); } catch (e) { json = {}; }

  let results = [];
  if (Array.isArray(json)) results = json;
  else if (json && Array.isArray(json.results)) results = json.results;
  else if (json && Array.isArray(json.data)) results = json.data;

  const total = (json && typeof json.total === 'number') ? json.total : null;
  return { http: res.status, results: results, total: total, raw: raw };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;
  if (!PARTNER_KEY || !COMPANY_KEY) { res.status(500).json({ error: 'Missing API credentials in environment' }); return; }

  let inBody = {};
  try { inBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (e) { inBody = {}; }

  const headers = {
    'Content-Type': 'application/json',
    'PARTNER_KEY': PARTNER_KEY,
    'COMPANY_KEY': COMPANY_KEY
  };

  const LIMIT = 100;
  let page = 1;
  let all = [];
  let total = null;
  let lastHttp = 200;
  let lastRaw = '';
  let rateLimited = false;
  const HARD_PAGE_CAP = 30; // 3000 projects safety cap
  const START = Date.now();
  const TIME_BUDGET = 8000; // stop before Vercel's 10s limit; return what we have

  while (page <= HARD_PAGE_CAP) {
    if (Date.now() - START > TIME_BUDGET) break;
    const body = { page: page, limit: LIMIT };
    if (inBody.created_after) body.created_after = inBody.created_after;
    if (inBody.created_before) body.created_before = inBody.created_before;

    const r = await fetchPage(body, headers, 0);
    lastHttp = r.http;
    if (r.raw) lastRaw = r.raw;

    if (r.http === 429) { rateLimited = true; break; } // gave up after retries

    if (r.total !== null) total = r.total;

    if (r.results.length === 0) break; // no more data
    all = all.concat(r.results);

    // Stop when we've collected everything ProLine says exists.
    if (total !== null && all.length >= total) break;

    // If ProLine returned fewer than we asked AND we have no total to chase, stop.
    if (total === null && r.results.length < LIMIT) break;

    page = page + 1;
    await sleep(500); // pause between pages
  }

  res.setHeader('x-proline-http', String(lastHttp));
  res.setHeader('x-proline-count', String(all.length));
  res.setHeader('x-proline-total', String(total));
  res.setHeader('x-proline-pages', String(page));
  res.setHeader('x-proline-ratelimited', String(rateLimited));
  res.setHeader('x-proline-raw', String(lastRaw).slice(0, 200));

  res.status(200).json(all);
};
