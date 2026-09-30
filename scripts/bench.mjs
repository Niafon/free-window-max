// Latency check for TZ §24 targets. Run against a disposable instance with DEMO_AUTH=true and TRUST_PROXY_HOPS=1:
//   BENCH_URL=http://127.0.0.1:3000 node scripts/bench.mjs
// Each simulated client uses its own X-Forwarded-For, so per-client rate limits behave as in production.
const base = process.env.BENCH_URL ?? 'http://127.0.0.1:3000';
const clients = Number(process.env.BENCH_CLIENTS ?? 10);
const ip = i => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
async function login(i) {
  const r = await fetch(`${base}/api/v1/auth/demo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(i), origin: base }, body: JSON.stringify({ name: `Bench ${i}`, accessKey: process.env.DEMO_ACCESS_KEY }) });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return r.headers.get('set-cookie').split(';')[0];
}
const day = new Date(Date.now() + 27 * 3600000).toISOString().slice(0, 10);
const search = { availableFrom: `${day}T18:30:00+03:00`, availableTo: `${day}T21:30:00+03:00`, budget: 1000, maxTravelMinutes: 30, origin: { lat: 55.6706, lon: 37.4802, preset: 'mirea' }, dataMode: 'demo' };
async function run(name, total, request) {
  const times = []; let next = 0, errors = 0; const started = Date.now();
  await Promise.all(Array.from({ length: clients }, async (_, c) => {
    const cookie = await login(1000 + c * 97 + total);
    while (next < total) {
      const n = next++, t = performance.now();
      const r = await request(cookie, ip(n + 1)); await r.arrayBuffer();
      times.push(performance.now() - t); if (r.status >= 500) errors++; else if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    }
  }));
  times.sort((a, b) => a - b);
  const q = p => times[Math.min(times.length - 1, Math.ceil(p * times.length) - 1)].toFixed(1);
  console.log(JSON.stringify({ name, requests: total, clients, p50: +q(0.5), p95: +q(0.95), p99: +q(0.99), max: +times.at(-1).toFixed(1), rps: +(total / ((Date.now() - started) / 1000)).toFixed(1), errors5xx: errors }));
}
const json = (cookie, xff, method, path, body) => fetch(`${base}${path}`, { method, headers: { cookie, 'x-forwarded-for': xff, origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
await run('GET /api/v1/me', 1000, (c, x) => json(c, x, 'GET', '/api/v1/me'));
await run('GET /health', 1000, (c, x) => json(c, x, 'GET', '/health'));
await run('POST /api/v1/search (demo, без внешних маршрутов)', 300, (c, x) => json(c, x, 'POST', '/api/v1/search', search));
