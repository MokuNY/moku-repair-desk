// With no REPAIR_DESK_TOKEN the repair-label route does not exist, so the
// production server is unchanged until the secret is set (approval point A4).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '38912';
process.env.SHOPIFY_API_KEY = 'k';
process.env.SHOPIFY_API_SECRET = 's';
process.env.PRINTERS = 'Front counter=testtoken_ABCDEFGHIJKLMNOP';
delete process.env.REPAIR_DESK_TOKEN;

const { server } = await import('../src/index.js');
after(() => {
  server.close();
  setTimeout(() => process.exit(0), 100).unref();
});

test('repair-label route is off without REPAIR_DESK_TOKEN', async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch('http://127.0.0.1:38912/api/repair-label', {
    method: 'POST',
    headers: { Authorization: 'Bearer anything', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 404);
});
