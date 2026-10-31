import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env, Identity } from './types';
import { first, HttpError, now, statement } from './db';
const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const list = (s = '') => s.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const verifiedDeployments = new Set<string>();

// Refuse to serve when the bound database belongs to a different deployment (wrong binding / copied config).
export async function checkDeployment(env: Env) {
 const id = env.DEPLOYMENT_ID;
 if (!id || id === 'template') throw new HttpError(503, 'Deployment identity not configured');
 const cacheKey = id;
 if (verifiedDeployments.has(cacheKey)) return;
 await statement(env, "INSERT OR IGNORE INTO meta(key,value) VALUES('deployment_id',?)", id).run();
 const row = await first<{ value: string }>(env, "SELECT value FROM meta WHERE key='deployment_id'");
 if (row?.value !== id) { console.error(JSON.stringify({ event: 'deployment_mismatch' })); throw new HttpError(503, 'Database does not belong to this deployment'); }
 verifiedDeployments.add(cacheKey);
}
export const _resetDeploymentCache = () => verifiedDeployments.clear();

export async function authenticate(request: Request, env: Env, testKey?: JWTVerifyGetKey): Promise<Identity> {
 let sub: string, email: string;
 const hostname = new URL(request.url).hostname;
 if (env.DEV_AUTH_BYPASS === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname) && request.headers.has('x-dev-user')) {
  email = request.headers.get('x-dev-user')!.trim().toLowerCase();
  sub = `dev:${email}`;
 } else {
  try {
   const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
   if (!assertion) throw new Error();
   let keys = testKey;
   if (!keys) {
    if (!keysets.has(env.ACCESS_TEAM_DOMAIN)) keysets.set(env.ACCESS_TEAM_DOMAIN, createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)));
    keys = keysets.get(env.ACCESS_TEAM_DOMAIN)!;
   }
   const { payload } = await jwtVerify(assertion, keys, { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['sub', 'email', 'exp'] });
   if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string') throw new Error();
   sub = payload.sub; email = payload.email.toLowerCase();
  } catch { throw new HttpError(401, 'Session expired — reload to sign in'); }
 }
 if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(403, 'Invalid email');
 const domains = list(env.ALLOWED_DOMAINS);
 if (domains.length && !domains.includes(email.split('@')[1])) throw new HttpError(403, 'Email domain is not allowed');
 let member = await first<{ role: string; instance: number; active: number; display_name: string }>(env, 'SELECT role,instance,active,display_name FROM members WHERE email=?', email);
 if (!member && list(env.BOOTSTRAP_ADMINS).includes(email)) {
  await statement(env, `INSERT OR IGNORE INTO members(email,role,instance,active,added_by,added_at)
   VALUES(?, 'admin', (SELECT COALESCE(MAX(instance),0)+1 FROM members), 1, 'bootstrap', ?)`, email, now()).run();
  member = await first(env, 'SELECT role,instance,active,display_name FROM members WHERE email=?', email);
 }
 // Bootstrap admins are always recoverable: they cannot be locked out by deactivating their own row.
 if (member && !member.active && list(env.BOOTSTRAP_ADMINS).includes(email)) {
  await statement(env, "UPDATE members SET active=1,role='admin' WHERE email=?", email).run(); member.active = 1; member.role = 'admin';
 }
 if (!member || !member.active) throw new HttpError(403, 'You have not been invited to this workspace. Contact the administrator.', { code: 'not_invited' });
 const ts = now();
 await statement(env, `INSERT INTO users(sub,email,first_seen,last_seen) VALUES(?,?,?,?)
  ON CONFLICT(sub) DO UPDATE SET email=excluded.email,last_seen=excluded.last_seen WHERE users.last_seen <= ?`,
  sub, email, ts, ts, new Date(Date.now() - 900000).toISOString()).run();
 const profile = await first<{ display_name: string | null }>(env, 'SELECT display_name FROM users WHERE sub=?', sub);
 return { sub, email, isAdmin: member.role === 'admin', instance: member.instance, displayName: profile?.display_name || member.display_name || '' };
}
const writes = new Map<string, { start: number; count: number }>();
export function rateLimit(sub: string) {
 const time = Date.now();
 for (const [key, val] of writes) if (time - val.start >= 60000) writes.delete(key);
 let entry = writes.get(sub);
 if (!entry) { entry = { start: time, count: 0 }; writes.set(sub, entry); }
 if (++entry.count > 240) throw new HttpError(429, 'Too many writes — retry shortly');
}
