// Vercel Serverless — BACKGROUND REFRESH JOB
// Saddle River Roofing — Sales Dashboards
//
// Collects ALL projects from ProLine (paginated, 100/page) and stores the
// full set in Vercel Blob as projects-cache.json. The dashboards then read
// that cached JSON instantly via api/proline.js.
//
// Triggered hourly by an external cron (cron-job.org). Protected by a secret
// that may be supplied EITHER as ?key=... in the URL OR as an
// Authorization: Bearer <secret> header. Either one works.

const { put } = require('@vercel/blob');

const PROLINE_URL = 'https://api.proline.app/v1/list/projects';
const BLOB_KEY = 'projects-cache.json';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = async (req, res) => {
  // ---- Auth: accept secret from URL (?key=) OR Authorization header ----
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  const urlKey = (req.query && req.query.key) || '';
  const headerOk = secret && auth === ('Bearer ' + secret);
  const urlOk = secret && urlKey === secret;
  if (!secret || (!headerOk && !urlOk)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;
  const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  if (!PARTNER_KEY || !COMPANY_KEY) { res.status(500).json({ error: 'Missing ProLine keys' }); return; }
  if (!BLOB_TOKEN) { res.status(500).json({ error: 'Missing BLOB_READ_WRITE_TOKEN' }); return; }

  const headers = {
    'Content-Type': 'application/json',
    'PARTNER_KEY': PARTNER_KEY,
    'COMPANY_KEY': COMPANY_KEY
  };

  const limit = 100;
  const deadline = Date.now() + 55000;
  let all = [];
  let page = 1;
  let total = null;

  async function fetchPage(p) {
    const payload = { page: p, limit: limit };
    let attempt = 0;
    while (attempt < 4) {
      attempt++;
      try {
        const r = await fetch(PROLINE_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (r.status === 429) {
          if (attempt < 4 && Date.now() < deadline) { await sleep(1000 + attempt * 700); continue; }
          return { ok: false, rate: true };
        }
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!data) return { ok: false };
        const results = Array.isArray(data) ? data : (data.results || data.data || data.projects || []);
        if (data && typeof data.total === 'number') total = data.total;
        return { ok: true, results };
      } catch (e) {
        if (attempt < 4 && Date.now() < deadline) { await sleep(800); continue; }
        return { ok: false, err: String(e) };
      }
    }
    return { ok: false };
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
    res.status(200).json({ ok: true, stored: all.length, total: total, url: blob.url });
  } catch (e) {
    res.status(500).json({ error: 'Blob write failed: ' + String(e) });
  }
};
