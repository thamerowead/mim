// Vercel Serverless Function — proxies requests to the ProLine Partner API.
// This runs server-side, so it bypasses browser CORS entirely.
// Keys are read from Vercel Environment Variables (never exposed to the browser).

export default async function handler(req, res) {
  // Allow the dashboards (same deployment) to call this endpoint.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;
  if (!PARTNER_KEY || !COMPANY_KEY) {
    res.status(500).json({ error: 'Missing PARTNER_KEY or COMPANY_KEY env vars' });
    return;
  }

  // The dashboard tells us which endpoint to hit (e.g. "/v1/list/projects").
  const { endpoint, body } = req.body || {};
  if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('/v1/')) {
    res.status(400).json({ error: 'Invalid endpoint' });
    return;
  }

  try {
    const upstream = await fetch('https://api.proline.app' + endpoint, {
      method: 'POST',
      headers: {
        'PARTNER_KEY': PARTNER_KEY,
        'COMPANY_KEY': COMPANY_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed', detail: String(err) });
  }
}
