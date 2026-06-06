// Vercel Serverless Function — ProLine Partner API proxy
// Diagnostic version: sends request WITHOUT date filters first to confirm data exists

const PROLINE_BASE = 'https://api.proline.app';

async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, options);
    if (r.status === 429) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      continue;
    }
    return r;
  }
  throw new Error('Max retries reached (429)');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers',
    'x-proline-status, x-proline-count, x-proline-note, x-proline-raw');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;

  if (!PARTNER_KEY || !COMPANY_KEY) {
    res.setHeader('x-proline-note', 'missing-env-keys');
    return res.status(500).json({ error: 'Missing API keys' });
  }

  const { endpoint, body } = req.body || {};
  if (!endpoint || !endpoint.startsWith('/v1/')) {
    return res.status(400).json({ error: 'Invalid endpoint' });
  }

  try {
    // First: try WITHOUT date filters to see if any data exists at all
    const noFilterBody = { limit: 5 };
    
    const r = await fetchWithRetry(PROLINE_BASE + endpoint, {
      method: 'POST',
      headers: {
        'PARTNER_KEY': PARTNER_KEY,
        'COMPANY_KEY': COMPANY_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(noFilterBody),
    });

    const text = await r.text();
    res.setHeader('x-proline-status', String(r.status));

    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }

    // Detect array — ProLine may return array directly or nested
    let arr = [];
    if (Array.isArray(payload)) {
      arr = payload;
    } else if (payload && Array.isArray(payload.data)) {
      arr = payload.data;
    } else if (payload && Array.isArray(payload.projects)) {
      arr = payload.projects;
    } else if (payload && Array.isArray(payload.results)) {
      arr = payload.results;
    }

    res.setHeader('x-proline-count', String(arr.length));
    
    // Log first project's keys so we can see actual field names
    if (arr.length > 0) {
      res.setHeader('x-proline-note', 'ok');
      res.setHeader('x-proline-fields', Object.keys(arr[0]).join(',').slice(0, 500));
    } else {
      // Return raw response (first 500 chars) so we can see what ProLine actually sent
      res.setHeader('x-proline-note', 'empty-see-raw');
      res.setHeader('x-proline-raw', text.slice(0, 500));
    }

    // Now fetch with the actual requested body for dashboard use
    const r2 = await fetchWithRetry(PROLINE_BASE + endpoint, {
      method: 'POST',
      headers: {
        'PARTNER_KEY': PARTNER_KEY,
        'COMPANY_KEY': COMPANY_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });

    const text2 = await r2.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(r2.status).send(text2);

  } catch (err) {
    res.setHeader('x-proline-note', 'proxy-error');
    return res.status(502).json({ error: err.message });
  }
}
