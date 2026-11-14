// Minimal receiver for the "webhook" alert channel that checks the X-Signature-256 header.
//   ALERT_WEBHOOK_SECRET=change-me node examples/webhook-receiver.mjs
// then set "url": "http://localhost:8787/" and the same secret in your config.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const secret = process.env.ALERT_WEBHOOK_SECRET;
if (!secret) {
  console.error('set ALERT_WEBHOOK_SECRET');
  process.exit(1);
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
    const given = Buffer.from(String(req.headers['x-signature-256'] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.writeHead(401).end('bad signature');
      return;
    }
    const alert = JSON.parse(body.toString('utf8'));
    console.log(`${alert.title}: ${alert.reasons.join('; ')}`);
    for (const url of alert.added) console.log(`  + ${url}`);
    res.writeHead(204).end();
  });
}).listen(8787, () => console.log('listening on http://localhost:8787/'));
