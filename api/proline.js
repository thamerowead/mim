// Vercel Serverless Proxy for ProLine Partner API
// Handles pagination + 429 rate-limit retry SERVER-SIDE so the browser
// makes exactly ONE request and receives the complete projects array.

const PROLINE_URL = 'https://api.proline.app/v1/list/projects';

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// Fetch a single page with retry on 429 (exponential backoff).
async function fetchPage(body, headers, attempt) {
  attempt = attempt || 0;
  const res = await fetch(PROLINE_URL, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  });

  if (res.status === 429) {
    if (attempt >= 4) {
      return { status: 429, results: [], total: 0, rateLimited: true };
    }
    // Backoff: 500ms, 900ms, 1300ms, 1700ms (max ~4.4s total, safely under Vercel's 10s limit)
    await sleep(500 + 400 * attempt);
    return fetchPage(body, headers, attempt + 1);
  }

  let json = {};
  try { json = await res.json(); } catch (e) { json = {}; }

  let results = [];
  if (Array.isArray(json)) {
    results = json;
  } else if (json && Array.isArray(json.results)) {
    results = json.results;
  } else if (json && Array.isArray(json.data)) {
    results = json.data;
  }

  const total = (json && typeof json.total === 'number') ? json.total : results.length;
  return { status: res.status, results: results, total: total, rateLimited: false };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;

  if (!PARTNER_KEY || !COMPANY_KEY) {
    res.status(500).json({ error: 'Missing API credentials in environment' });
    return;
  }

  // Read date filters sent by the dashboard.
  let inBody = {};
  try {
    inBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    inBody = {};
  }

  const headers = {
    'Content-Type': 'application/json',
    'PARTNER_KEY': PARTNER_KEY,
    'COMPANY_KEY': COMPANY_KEY
  };

  const LIMIT = 100;
  let page = 1;
  let all = [];
  let lastStatus = 200;
  let rateLimited = false;
  const MAX_PAGES = 50; // safety cap (5000 projects)

  while (page <= MAX_PAGES) {
    // ProLine proxy requires the `endpoint` field in the body.
    const body = {
      endpoint: '/v1/list/projects',
      page: page,
      limit: LIMIT
    };
    if (inBody.created_after) body.created_after = inBody.created_after;
    if (inBody.created_before) body.created_before = inBody.created_before;

    const pageResult = await fetchPage(body, headers, 0);
    lastStatus = pageResult.status;

    if (pageResult.rateLimited) {
      rateLimited = true;
      break;
    }

    if (pageResult.results.length === 0) {
      break; // no more data
    }

    all = all.concat(pageResult.results);

    if (pageResult.results.length < LIMIT) {
      break; // last page
    }

    page = page + 1;
    // Gentle pause between pages to stay under ProLine's rate limit.
    await sleep(250);
  }

  // Diagnostic headers (visible in DevTools, do not affect the body).
  res.setHeader('x-proline-status', String(lastStatus));
  res.setHeader('x-proline-count', String(all.length));
  res.setHeader('x-proline-pages', String(page));
  res.setHeader('x-proline-ratelimited', String(rateLimited));

  // Always return a plain array â the dashboards expect this directly.
  res.status(200).json(all);
};
