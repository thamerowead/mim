// Vercel Serverless Function — REFRESH job
// Saddle River Roofing — Sales Dashboards (free-tier caching architecture)
//
// Collects ALL projects from ProLine (paging through the 100-per-page cap) and
// stores them as a single JSON blob. This is called by an EXTERNAL cron service
// (cron-job.org) hourly, so it is NOT bound to a user request's 10s limit —
// but we still cap it sensibly. maxDuration is raised via vercel.json.
//
// Protected by CRON_SECRET so only the scheduler can trigger a refresh.

const { put } = require('@vercel/blob');

const PROLINE_URL = 'https://api.proline.app/v1/list/projects';
const BLOB_KEY = 'projects-cache.json';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

module.exports = async (req, res) => {
  // Auth: only the cron scheduler (with the secret) may run this.
  const auth = req.headers['authorization'] || '';
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== ('Bearer ' + secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;
  const BLOB_TOKEN  = process.env.BLOB_READ_WRITE_TOKEN;
  if (!PARTNER_KEY || !COMPANY_KEY) { res.status(500).json({ error: 'Missing ProLine keys' }); return; }
  if (!BLOB_TOKEN) { res.status(500).json({ error: 'Missing BLOB_READ_WRITE_TOKEN' }); return; }

  const headers = {
    'Content-Type': 'application/json',
    'PARTNER_KEY': PARTNER_KEY,
    'COMPANY_KEY': COMPANY_KEY
  };

  // Pull EVERYTHING (no date filter) so the cache holds the full history.
  // Dashboards filter by date client-side from the cached set.
  const limit = 100;
  const deadline = Date.now() + 55000; // generous; external cron is not user-bound
  let all = [];
  let page = 1;
  let total = null;

  async function fetchPage(p){
    const payload = { page: p, limit: limit };
    let attempt = 0;
    while (attempt < 4) {
      attempt++;
      try {
        const r = await fetch(PROLINE_URL, { method:'POST', headers, body: JSON.stringify(payload) });
        if (r.status === 429) {
          if (attempt < 4 && Date.now() < deadline) { await sleep(1000 + attempt*700); continue; }
          return { ok:false, rate:true };
        }
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch(e){ data = null; }
        if (!data) return { ok:false };
        const results = Array.isArray(data) ? data : (data.results || data.data || data.projects || []);
        if (data && typeof data.total === 'number') total = data.total;
        return { ok:true, results };
      } catch(e){
        if (attempt < 4 && Date.now() < deadline) { await sleep(800); continue; }
        return { ok:false, err:String(e) };
      }
    }
    return { ok:false };
  }

  while (Date.now() < deadline && page <= 100) {
    const out = await fetchPage(page);
    if (!out.ok) break;
    const got = out.results || [];
    all = all.concat(got);
    if (got.length === 0) break;
    if (total !== null && all.length >= total) break;
    if (total === null && got.length < limit) break;
    page++;
    await sleep(150);
  }

  // Store the full set + a timestamp so the dashboard can show "as of" freshness.
  const payload = JSON.stringify({
    updated_at: new Date().toISOString(),
    total: total,
    count: all.length,
    projects: all
  });

  try {
    const blob = await put(BLOB_KEY, payload, {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
      cacheControlMaxAge: 0,
      token: BLOB_TOKEN
    });
    res.status(200).json({ ok:true, stored: all.length, total: total, url: blob.url });
  } catch(e) {
    res.status(500).json({ error: 'Blob write failed: ' + String(e) });
  }
};
