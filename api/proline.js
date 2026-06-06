export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PARTNER_KEY = process.env.PARTNER_KEY;
  const COMPANY_KEY = process.env.COMPANY_KEY;

  if (!PARTNER_KEY || !COMPANY_KEY) {
    return res.status(500).json({ error: 'Missing API keys in environment variables' });
  }

  const { endpoint, body } = req.body || {};

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  try {
    const upstream = await fetch(`https://api.proline.app${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PARTNER_KEY': PARTNER_KEY,
        'COMPANY_KEY': COMPANY_KEY,
      },
      body: JSON.stringify(body || {}),
    });

    const data = await upstream.json();

    // Attach diagnostics as headers (visible in DevTools, not in response body)
    const projects = Array.isArray(data) ? data : (data?.projects || data?.data || []);
    res.setHeader('x-proline-status', upstream.status);
    res.setHeader('x-proline-count', projects.length);
    res.setHeader('x-proline-sent', JSON.stringify(body || {}));
    if (!Array.isArray(data)) {
      res.setHeader('x-proline-note', 'response-not-array: ' + Object.keys(data).join(','));
    }

    // Return the array directly so dashboards work without modification
    return res.status(200).json(projects);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
