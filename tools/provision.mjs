#!/usr/bin/env node
// Generates a per-client wrangler config and prints the (manual) deployment runbook. Executes nothing.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const a = Object.fromEntries(process.argv.slice(2).map(x => x.replace(/^--/, '').split('=')));
const need = ['slug', 'admins', 'team-domain'];
if (need.some(k => !a[k]) || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(a.slug)) {
  console.error('Usage: npm run provision -- --slug=acme --admins=a@x.com,b@x.com --team-domain=https://acme.cloudflareaccess.com [--aud=<access-aud>] [--domains=x.com]');
  process.exit(1);
}
const out = `wrangler.${a.slug}.jsonc`;
if (existsSync(out)) { console.error(`${out} exists; refusing to overwrite.`); process.exit(1); }
const cfg = {
  name: `uat-${a.slug}`, main: 'src/index.ts', compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
  workers_dev: false, preview_urls: false, observability: { enabled: true },
  assets: { directory: './public', binding: 'ASSETS', run_worker_first: ['/api/*', '/theme.css', '/brand/*', '/favicon.ico'] },
  d1_databases: [{ binding: 'DB', database_name: `uat-${a.slug}`, database_id: 'FILL_AFTER_d1_create', migrations_dir: 'migrations' }],
  r2_buckets: [{ binding: 'DOCS', bucket_name: `uat-${a.slug}-docs` }],
  vars: { DEPLOYMENT_ID: randomUUID(), ACCESS_TEAM_DOMAIN: a['team-domain'], ACCESS_AUD: a.aud || 'FILL_AFTER_ACCESS_APP', BOOTSTRAP_ADMINS: a.admins, ALLOWED_DOMAINS: a.domains || '' }
};
writeFileSync(out, '// Generated. DEPLOYMENT_ID binds this Worker to its own D1 database; never copy it between clients.\n' + JSON.stringify(cfg, null, 2) + '\n');
console.log(`Wrote ${out}. Per-client runbook (run manually, one client at a time):
 1. npx wrangler d1 create uat-${a.slug}              -> put database_id into ${out}
 2. npx wrangler r2 bucket create uat-${a.slug}-docs   (optional; needed only for PDF documents)
 3. npx wrangler d1 migrations apply uat-${a.slug} --remote --config ${out}
 4. npx wrangler deploy --config ${out}
 5. Create a Cloudflare Access application for the Worker URL (policy: invited emails), copy its AUD into ${out}, redeploy.
 6. (optional) npx wrangler secret put ADO_PAT --config ${out}
 7. Sign in as a bootstrap admin, then configure branding, settings, content and roster in /admin.
The Worker refuses requests (503) until DEPLOYMENT_ID matches its database, so a mis-bound database cannot leak across clients.`);
