// Vercel Serverless Proxy for ProLine Partner API
// Saddle River Roofing — Sales Dashboards
// Bypasses browser CORS. Keeps API keys server-side (Vercel Env Vars).
//
// Confirmed from real ProLine data:
//  - Only working endpoint: POST /v1/list/projects at api.proline.app
//  - Auth: dual headers PARTNER_KEY + COMPANY_KEY (NOT Bearer)
//  - Dates MUST be full ISO 8601 with timezone (2026-01-01T00:00:00.000Z)
//  - Response is wrapped: { page, limit, total, results: [...] }
//  - Do NOT send `endpoint` in the body to ProLine (the path is in the URL)
//  - 429 (rate limit) is common — retry with backoff, never give up early
//  - Vercel free tier hard-limits at 10s — we cap our own work at ~8s

const PROLINE_URL = 'https://api.proline.app/v1/list/projects';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

module.exports = async (req, res) => {
  // CORS for the dashboards (same origin in prod, but safe to allow)
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

  // Read body (Vercel may pass it parsed or raw)
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e){ body = {}; } }
  if (!body) body = {};

  const created_after  = body.created_after  || null;
  const created_before = body.created_before || null;
  // Request a large page so we collect everything in as few slow round-trips as
  // possible. If ProLine caps the page lower (e.g. 100), the paging loop below
  // still collects the rest — it adapts to whatever page size ProLine returns.
  const limit = 500;

  const headers = {
    'Content-Type': 'application/json',
    'PARTNER_KEY': PARTNER_KEY,
    'COMPANY_KEY': COMPANY_KEY
  };

  const deadline = Date.now() + 9000; // stay under Vercel's 10s hard limit
  let all = [];
  let page = 1;
  let total = null;
  let lastStatus = 0;
  let note = '';

  async function fetchPage(p){
    // ProLine wants the filters in the body, WITHOUT an `endpoint` field.
    const payload = { page: p, limit: limit };
    if (created_after)  payload.created_after  = created_after;
    if (created_before) payload.created_before = created_before;

    let attempt = 0;
    while (attempt < 3) {
      attempt++;
      try {
        const r = await fetch(PROLINE_URL, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        });
        lastStatus = r.status;
        if (r.status === 429) {
          // rate limited — back off and retry
          if (attempt < 3 && Date.now() < deadline) {
            await sleep(800 + attempt * 500); // 0.8s, 1.8s
            continue;
          }
          return { ok:false, rate:true };
        }
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch(e){ data = null; }
        if (!data) { return { ok:false, parse:true }; }
        // ProLine wraps results: { page, limit, total, results: [...] }
        const results = Array.isArray(data) ? data
                       : (data.results || data.data || data.projects || []);
        if (data && typeof data.total === 'number') total = data.total;
        return { ok:true, results: results };
      } catch (e) {
        if (attempt < 3 && Date.now() < deadline) { await sleep(600); continue; }
        return { ok:false, err: String(e) };
      }
    }
    return { ok:false };
  }

  // Page through until: collected `total`, an empty page, out of time, or a cap.
  // Stop logic relies on the reported `total`, NOT on the requested page size —
  // this works whether ProLine honors limit=500 or silently caps the page at 100.
  while (Date.now() < deadline && page <= 50) { // 50-page hard cap
    const out = await fetchPage(page);
    if (!out.ok) {
      if (out.rate) note = 'partial: hit rate limit (429)';
      else if (out.parse) note = 'partial: unparseable response';
      else note = 'partial: fetch error';
      break;
    }
    const got = out.results || [];
    all = all.concat(got);

    if (got.length === 0) break;                       // empty page = done
    if (total !== null && all.length >= total) break;  // collected everything ProLine reports
    if (total === null && got.length < limit) break;   // no total + short page = last page
    page++;
    await sleep(100); // gentle pacing to avoid 429
  }

  res.setHeader('x-proline-status', String(lastStatus));
  res.setHeader('x-proline-count', String(all.length));
  if (total !== null) res.setHeader('x-proline-total', String(total));
  if (note) res.setHeader('x-proline-note', note);

  // Return a PLAIN ARRAY — the dashboards expect this exact shape.
  res.status(200).json(all);
};
