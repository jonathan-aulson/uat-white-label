import { env } from 'cloudflare:test';
import { expect, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHandler } from '../src/index';
import type { Env } from '../src/types';

export const ADMIN = 'admin@example.com';
export const fetcher = vi.fn<typeof fetch>();
let keys: Awaited<ReturnType<typeof generateKeyPair>>, app: ReturnType<typeof createHandler>;
export async function setupApp() {
 keys = await generateKeyPair('RS256', { extractable: true });
 const publicKey = await exportJWK(keys.publicKey); publicKey.kid = 'test';
 app = createHandler({ jwks: createLocalJWKSet({ keys: [publicKey] }), fetcher });
}
export async function token(email: string) {
 return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('sub:' + email).setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(env.ACCESS_AUD).setExpirationTime('5m').sign(keys.privateKey);
}
export async function request(path: string, method = 'GET', data?: unknown, email = ADMIN, overrides: Partial<Env> = {}, raw?: { body: Uint8Array | string; type: string }) {
 const headers: Record<string, string> = { 'Cf-Access-Jwt-Assertion': await token(email) };
 let body: BodyInit | undefined;
 if (raw) { headers['Content-Type'] = raw.type; body = raw.body as BodyInit; } else if (data !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
 return app.fetch(new Request('https://uat.example' + path, { method, headers, body }), { ...env, ...overrides });
}
export const rawApp = () => app;
export async function ok<T = any>(r: Response | Promise<Response>, status = 200): Promise<T> {
 const res = await r; const body = await res.json().catch(() => ({})) as T;
 expect(res.status, JSON.stringify(body)).toBe(status); return body;
}
export const addMember = (email: string, role = 'tester', display_name = '') => ok(request('/api/admin/members', 'POST', { email, role, display_name }), 201);
export async function publishExample(key: string) {
 const { id } = await ok<{ id: string }>(request('/api/admin/releases', 'POST', { from: key, label: key }), 201);
 await ok(request(`/api/admin/releases/${id}/publish`, 'POST', {}));
 return id;
}
export async function newCampaign(releaseId: string, name: string, extra: Record<string, unknown> = {}) {
 const { id } = await ok<{ id: string }>(request('/api/admin/campaigns', 'POST', { name, release_id: releaseId, environment: 'UAT', build: 'b1', ...extra }), 201);
 return id;
}
export const invite = (cid: string, invites: { email: string; roles: string[] }[]) => ok(request(`/api/admin/campaigns/${cid}/invites`, 'PUT', { invites }));
export async function startRun(cid: string, email: string, role: string, reset = false) {
 return (await ok<{ run: { id: string } }>(request(`/api/campaigns/${cid}/runs`, 'POST', { role, reset }, email), 201)).run.id;
}
