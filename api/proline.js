// Vercel Serverless Proxy — READS FROM CACHE
// Saddle River Roofing — Sales Dashboards
//
// The hourly/minutely background job (api/refresh.js) collects all ProLine
// projects into projects-cache.json. This proxy simply reads that finished
// cache and returns the projects array instantly — no ProLine round-trip on
// page load, so it never hits the function time limit.
//
// Dashboards send an empty body {} and filter by date client-side, so this
// always returns the FULL cached set.

const { list } = require('@vercel/blob');

const CACHE_KEY = 'projects-cache.json';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  if (!BLOB_TOKEN) { res.status(500).json({ error: 'Missing BLOB_READ_WRITE_TOKEN' }); return; }

  try {
    const { blobs } = await list({ prefix: CACHE_KEY, token: BLOB_TOKEN, limit: 1 });
    const hit = blobs.find(b => b.pathname === CACHE_KEY) || blobs[0];
    if (!hit) {
      // Cache not built yet — return empty array so dashboards render cleanly.
      res.status(200).json([]);
      return;
    }

    const r = await fetch(hit.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) { res.status(200).json([]); return; }
    const data = await r.json();
    const projects = (data && Array.isArray(data.projects)) ? data.projects : [];

    // Surface freshness so dashboards can show an "as of" timestamp if desired.
    if (data && data.updated_at) res.setHeader('x-cache-updated', data.updated_at);
    res.setHeader('x-cache-count', String(projects.length));

    res.status(200).json(projects);
  } catch (e) {
    res.status(500).json({ error: 'Cache read failed: ' + String(e) });
  }
};
