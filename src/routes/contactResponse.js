const express = require('express');
const path = require('node:path');
const service = require('../agent/contactResponseRuntime');
const router = express.Router();
router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'Permissions-Policy': 'geolocation=(self)' });
  next();
});
const assets = path.resolve(__dirname, '../public/contact-response');
router.get('/', (req, res) => res.sendFile(path.join(assets, 'index.html')));
router.get('/app.js', (req, res) => res.sendFile(path.join(assets, 'app.js')));
router.get('/style.css', (req, res) => res.sendFile(path.join(assets, 'style.css')));
// Bounded memory; no tokens or request bodies are retained by the limiter.
const buckets = new Map();
router.use('/api', (req, res, next) => {
  const now = Date.now(), key = req.ip;
  for (const [ip, bucket] of buckets) if (bucket.until <= now) buckets.delete(ip);
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= 10000) return res.status(429).json({ error: 'Please retry shortly.' });
    buckets.set(key, bucket = { count: 0, until: now + 60000 });
  }
  if (++bucket.count > 120) return res.status(429).json({ error: 'Too many requests. Please retry in a minute.' });
  next();
});
const handle = fn => async (req, res) => {
  try {
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get('Authorization') || '')?.[1];
    res.json(await fn(token, req.body));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to update this SOS. Please retry.' });
  }
};
router.post('/api/context', handle(token => service.context(token)));
router.post('/api/respond', handle((token, body) => service.respond(token, body?.status)));
router.post('/api/location', handle((token, body) => service.location(token, body)));
router.post('/api/stop-location', handle(token => service.stopLocation(token)));
module.exports = router;
