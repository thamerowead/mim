// Vercel Serverless Function — INCREMENTAL (chunked) REFRESH job
// Saddle River Roofing — Sales Dashboards (free-tier safe architecture)
//
// WHY THIS DESIGN:
// ProLine caps each page at 100 projects and responds in ~4-8s per page.
// The client has ~402 projects = 5 pages = ~20-40s to collect everything.
// Vercel's FREE tier hard-limits every function to 10 seconds (maxDuration in
// vercel.json is IGNORED on the free plan). So a single function CANNOT collect
// all 402 projects in one invocation — it gets killed mid-run, never reaches
// the Blob write, and the cache stays empty. That was the real root cause of
// the timeout, behind the earlier 401/500 errors.
//
// FIX: collect ONE page per invocation (~4-8s, safely under 10s). Persist a tiny
// progress record (cursor) in Blob. An external cron (cron-job.org) calls this
// every minute; within ~5 minutes all 402 are gathered and published as a single
// projects-cache.json that the dashboards read instantly via proline.js.
//
// Two blobs are used:
//   refresh-state.json   -> { page, accumulated:[...], total, building:true }  (work-in-progress)
//   projects-cache.json  -> { updated_at, total, count, projects:[...] }        (the finished, published cache)
//
// Auth: CRON_SECRET, accepted via ?key=... (URL param) OR Authorization: Bearer
// header. URL param is used because cron-job.org's header UI was unreliable.

const { put, list } = require('@vercel/blob');

const PROLINE_URL = 'https://api.proline.app/v1/list/projects';
const CACHE_KEY = 'projects-cache.json';
const STATE_KEY = 'refresh-state.json';
const PAGE_LIMIT = 100;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// Fetch a JSON blob by pathname. Returns parsed object or null if missing.
async function readBlob(pathname, token){
  try {
    const { blobs } = await list({ prefix: pathname, token, limit: 1 });
    const hit = blobs.find(b => b.pathname === pathname) || blobs[0];
    if (!hit) return null;
    // Cache-bust so we always read the latest write, never a stale CDN copy.
    const r = await fetch(hit.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// Fetch a single page of projects from ProLine, with retry on 429 / transient errors.
async function fetchPage(page, PARTNER_KEY, COMPANY_KEY){
  const body = JSON.stringify({ page, limit: PAGE_LIMIT });
  for (let attempt = 0; attempt < 4; attempt++){
    try {
      const r = await fetch(PROLINE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Partner-Key': PARTNER_KEY,
          'X-Company-Key': COMPANY_KEY
        },
        body
      });
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) { await sleep(800); continue; }
      const data = await r.json();
      const results = Array.isArray(data) ? data
        : (data.results || data.data || data.projects || []);
      const total = (data && typeof data.total === 'number') ? data.total : null;
      return { ok: true, results, total };
    } catch (e) {
      await sleep(800);
    }
  }
  return { ok: false };
}

module.exports = async (req, res) => {
  // ---- Auth ----
  const secret = process.env.CRON_SECRET;
  const provided = (req.query && req.query.key)
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;
  const BLOB_TOKEN  = process.env.BLOB_READ_WRITE_TOKEN;

  if (!PARTNER_KEY || !COMPANY_KEY) { res.status(500).json({ error: 'Missing ProLine keys' }); return; }
  if (!BLOB_TOKEN) { res.status(500).json({ error: 'Missing BLOB_READ_WRITE_TOKEN' }); return; }

  // Manual full reset: /api/refresh?key=...&reset=1 wipes progress and starts page 1.
  const forceReset = req.query && (req.query.reset === '1' || req.query.reset === 'true');

  // ---- Load work-in-progress state ----
  let state = forceReset ? null : await readBlob(STATE_KEY, BLOB_TOKEN);
  if (!state || !Array.isArray(state.accumulated) || typeof state.page !== 'number') {
    state = { page: 1, accumulated: [], total: null, building: true };
  }

  // ---- Collect exactly ONE page this invocation (stays well under 10s) ----
  const out = await fetchPage(state.page, PARTNER_KEY, COMPANY_KEY);
  if (!out.ok) {
    // Transient ProLine failure — keep state, let the next cron tick retry this page.
    res.status(200).json({ ok: false, retry: true, page: state.page, collected: state.accumulated.length });
    return;
  }

  const got = out.results || [];
  state.accumulated = state.accumulated.concat(got);
  if (out.total !== null) state.total = out.total;

  // Decide whether this was the last page.
  const reachedTotal = (state.total !== null && state.accumulated.length >= state.total);
  const shortPage    = (got.length < PAGE_LIMIT); // a page below the cap means no more rows
  const done = reachedTotal || shortPage || got.length === 0;

  try {
    if (done) {
      // ---- Publish the finished cache, then reset state for the next cycle ----
      const payload = JSON.stringify({
        updated_at: new Date().toISOString(),
        total: state.total,
        count: state.accumulated.length,
        projects: state.accumulated
      });
      await put(CACHE_KEY, payload, {
        access: 'public',
        contentType: 'application/json',
        allowOverwrite: true,
        cacheControlMaxAge: 0,
        token: BLOB_TOKEN
      });

      // Reset progress so the next tick starts a fresh cycle from page 1.
      const fresh = JSON.stringify({ page: 1, accumulated: [], total: null, building: false });
      await put(STATE_KEY, fresh, {
        access: 'public',
        contentType: 'application/json',
        allowOverwrite: true,
        cacheControlMaxAge: 0,
        token: BLOB_TOKEN
      });

      res.status(200).json({ ok: true, done: true, stored: state.accumulated.length, total: state.total });
    } else {
      // ---- Save progress and advance to the next page for the next tick ----
      state.page = state.page + 1;
      state.building = true;
      await put(STATE_KEY, JSON.stringify(state), {
        access: 'public',
        contentType: 'application/json',
        allowOverwrite: true,
        cacheControlMaxAge: 0,
        token: BLOB_TOKEN
      });
      res.status(200).json({ ok: true, done: false, page: state.page - 1, collected: state.accumulated.length, total: state.total });
    }
  } catch (e) {
    res.status(500).json({ error: 'Blob write failed: ' + String(e) });
  }
};
