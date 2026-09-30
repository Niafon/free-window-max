import { readFileSync } from 'node:fs';
import YAML from 'yaml';
const spec = YAML.parse(readFileSync('DATA-API.yaml', 'utf8'), { merge: true });
const base = process.env.CHECK_BASE_URL || spec.localBaseUrl;
const values = { TEST_DATE: new Date(Date.now() + 27 * 3600000).toISOString().slice(0, 10) };
const cookies = {};
const pathValue = (object, path) => path.split('.').reduce((a, k) => a?.[k], object);
function resolve(value) {
  if (typeof value === 'string') return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => { const v = pathValue(values, key); if (v === undefined) throw new Error(`Missing template variable: ${key}`); return String(v); });
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  return value;
}
for (const raw of spec.checks) {
  const step = resolve({ ...spec.defaults, ...raw });
  let relative = step.path;
  for (const [k, v] of Object.entries(step.pathParameters)) relative = relative.replace(`{${k}}`, encodeURIComponent(v));
  const url = new URL(relative, base);
  for (const [k, v] of Object.entries(step.query)) url.searchParams.set(k, String(v));
  const headers = { ...step.headers };
  if (cookies[step.role]) headers.Cookie = cookies[step.role];
  // Fastify rejects an empty JSON body with Content-Type on POST. Omit the header when no body exists.
  if (step.body === null) delete headers['Content-Type'];
  const response = await fetch(url, { method: step.method, headers, body: step.body === null ? undefined : JSON.stringify(step.body), signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!step.expected.status.includes(response.status)) throw new Error(`${step.id}: expected ${step.expected.status}, got ${response.status}`);
  if (!response.headers.get('content-type')?.includes(step.expected.contentType)) throw new Error(`${step.id}: unexpected Content-Type`);
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${step.id}: expected JSON object`);
  for (const field of step.expected.required) if (pathValue(body, field) === undefined) throw new Error(`${step.id}: missing ${field}`);
  const cookie = response.headers.get('set-cookie'); if (cookie) cookies[step.role] = cookie.split(';')[0];
  values[step.id] = body;
  console.log(`PASS ${step.id} (${response.status})`);
}
console.log(`${spec.checks.length} API checks passed. No external route requests.`);
