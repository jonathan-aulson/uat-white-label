import type { JWTVerifyGetKey } from 'jose';
import type { Env } from './types';
import { authenticate, checkDeployment, rateLimit } from './auth';
import { testerApi } from './api-tester';
import { adminConfigApi } from './admin-config';
import { adminContentApi } from './admin-content';
import { adminFindingsApi } from './admin-findings';
import { all, first, HttpError, json, limitedBytes } from './db';
import { getWorkspace } from './settings';
import { themeCss } from './branding';
import { isOpen, openIdentity, selectionApi } from './open-access';

export const securityHeaders = {
 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"
};
const ADMIN_UPLOAD = /^\/api\/admin\/(documents|branding\/(logo|favicon))$/;
const ADMIN_BIG_JSON = /^\/api\/admin\/(releases(\/[^/]+)?|findings\/(result|feedback)\/[^/]+\/create-ado)$/;

// Theme and brand assets are public to anyone who passes Access, including people who are not yet invited.
async function brandResponse(req: Request, env: Env, path: string): Promise<Response | undefined> {
 const sec = { 'X-Content-Type-Options': 'nosniff' };
 if (path === '/theme.css') {
  const ws = await getWorkspace(env); const css = themeCss(ws, ws.branding_revision);
  return new Response(css, { headers: { ...sec, 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache', ETag: `"b${ws.branding_revision}"` } });
 }
 const kind = path === '/brand/logo' ? 'logo' : (path === '/brand/favicon' || path === '/favicon.ico') ? 'favicon' : null;
 if (!kind) return;
 const a = await first<{ mime: string; bytes: ArrayBuffer; sha256: string }>(env, 'SELECT mime,bytes,sha256 FROM assets WHERE kind=?', kind);
 if (!a) {
  if (kind === 'logo') return new Response(null, { status: 404, headers: sec });
  return env.ASSETS.fetch(new Request(new URL('/default-favicon.svg', req.url)));
 }
 if (req.headers.get('If-None-Match') === `"${a.sha256}"`) return new Response(null, { status: 304, headers: { ...sec, ETag: `"${a.sha256}"` } });
 return new Response(a.bytes, { headers: { ...sec, 'Content-Type': a.mime, 'Cache-Control': 'no-cache', ETag: `"${a.sha256}"` } });
}

// Dependency injection is code-only: no request or deployed env variable can supply verification keys.
export function createHandler(dependencies: { jwks?: JWTVerifyGetKey; fetcher?: typeof fetch } = {}) {
 return { async fetch(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/api/')) {
   if (['/theme.css', '/brand/logo', '/brand/favicon', '/favicon.ico'].includes(path)) {
    try { await checkDeployment(env); return (await brandResponse(req, env, path))!; } catch { return new Response('Unavailable', { status: 503 }); }
   }
   return env.ASSETS.fetch(req);
  }
  let response: Response;
  try {
   await checkDeployment(env);
   if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.headers.get('Origin');
    if ((isOpen(env) || origin) && origin !== new URL(req.url).origin) throw new HttpError(403, 'Same-origin writes are required');
   }
   if (path === '/api/participants' || (isOpen(env) && path === '/api/participant')) {
    if (!['GET', 'HEAD'].includes(req.method)) {
     rateLimit('open:selection');
     req = new Request(req, { body: await limitedBytes(req, 1024) });
    }
    response = (await selectionApi(req, env, path)) ?? json({ error: 'Not found' }, 404);
   } else {
    const user = isOpen(env) ? await openIdentity(req, env) : await authenticate(req, env, dependencies.jwks);
    if (!['GET', 'HEAD'].includes(req.method)) {
     rateLimit(user.sub);
     const max = !user.isAdmin ? 16384 : ADMIN_UPLOAD.test(path) ? 2.1 * 1024 * 1024 : ADMIN_BIG_JSON.test(path) ? 512 * 1024 : 65536;
     req = new Request(req, { body: await limitedBytes(req, max) });
    }
    if (path.startsWith('/api/admin/')) {
     if (!user.isAdmin) throw new HttpError(403, 'Administrator access required');
     const sub = path.slice('/api/admin'.length); const fetcher = dependencies.fetcher ?? fetch;
     response = (await adminConfigApi(req, env, user, sub, fetcher)) || (await adminContentApi(req, env, user, sub)) || (await adminFindingsApi(req, env, user, sub, fetcher)) || json({ error: 'Not found' }, 404);
    } else response = (await testerApi(req, env, user, path)) || json({ error: 'Not found' }, 404);
   }
  } catch (e) {
   if (e instanceof HttpError) response = json({ error: e.message, ...e.extra }, e.status);
   else {
    // Never log submitted text, JWTs or credentials.
    console.error(JSON.stringify({ event: 'api_unavailable', path, error: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }));
    response = json({ error: 'Service unavailable — your changes are not saved. Retry shortly.' }, 503);
   }
  }
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(securityHeaders)) if (!headers.has(k) || k !== 'Cache-Control') headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
 } };
}
export default createHandler();
void all;
