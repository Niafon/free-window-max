import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const secrets = env.split(/\r?\n/).filter(l => /^(BOT_TOKEN|YANDEX_MAPS_KEY|MAX_WEBHOOK_SECRET|POSTGRES_PASSWORD)=/.test(l)).map(l => l.slice(l.indexOf('=') + 1).trim()).filter(v => v.length >= 16);
const failures = [];
for (const file of files) {
  if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')) failures.push(file);
  const body = readFileSync(file); if (secrets.some(s => body.includes(Buffer.from(s)))) failures.push(file);
}
if (failures.length) { console.error('Secret scan failed in files: ' + [...new Set(failures)].join(', ')); process.exit(1); }
console.log(`Secret scan passed: ${files.length} tracked files; no local secret values found.`);
