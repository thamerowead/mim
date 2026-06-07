// Vercel Serverless Proxy — READ FROM CACHE
// Saddle River Roofing — Sales Dashboards
//
// ProLine's API is slow and caps pages at 100, so collecting all ~402 projects
// live exceeds the hosting time limit. Instead, an hourly background job
// (api/refresh.js, triggered by an external cron) collects everything into a
// Blob (projects-cache.json). This proxy simply reads that cached JSON and
// returns the projects array instantly — no ProLine round-trip on page load.
//
// Dashboards filter by date client-side, so this returns the FULL cached set.

const { list } = require('@vercel/blob');

const BLOB_KEY = 'projects-cache.json';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  if (!BLOB_TOKEN) { res.status(500).json({ error: 'Missing BLOB_READ_WRITE_TOKEN' }); return; }

  try {
    // Find the cache blob's current URL (the URL can change between writes).
    const { blobs } = await list({ prefix: BLOB_KEY, token: BLOB_TOKEN });
    if (!blobs || blobs.length === 0) {
      res.setHeader('x-cache-note', 'no cache yet — run /api/refresh first');
      res.status(200).json([]);
      return;
    }
    // Pick the most recent matching blob.
    const blob = blobs.sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];

    const r = await fetch(blob.url, { cache: 'no-store' });
    if (!r.ok) { res.status(200).json([]); return; }
    const data = await r.json();

    const projects = (data && Array.isArray(data.projects)) ? data.projects : [];
    res.setHeader('x-cache-count', String(projects.length));
    if (data && data.updated_at) res.setHeader('x-cache-updated', data.updated_at);
    if (data && typeof data.total === 'number') res.setHeader('x-cache-total', String(data.total));

    // Return a PLAIN ARRAY — dashboards expect this exact shape.
    res.status(200).json(projects);
  } catch (e) {
    res.setHeader('x-cache-note', 'read error: ' + String(e));
    res.status(200).json([]);
  }
};
