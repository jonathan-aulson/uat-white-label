import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, addMember, invite, newCampaign, ok, publishExample, rawApp, request, setupApp, startRun } from './helpers';

const origin = 'http://localhost';
const TESTER = 'open-tester@example.com';
const other = 'open-other@example.com';
const openEnv = () => ({ ...env, OPEN_ACCESS: '1' });
function call(path: string, method = 'GET', data?: unknown, cookie?: string, participant?: string, requestOrigin: string | null = origin) {
 const headers = new Headers();
 if (requestOrigin !== null) headers.set('Origin', requestOrigin);
 if (cookie) headers.set('Cookie', cookie);
 if (participant) headers.set('X-UAT-Participant', participant);
 if (data !== undefined) headers.set('Content-Type', 'application/json');
 return rawApp().fetch(new Request(origin + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }), openEnv());
}
async function choose(id: string) {
 const response = await call('/api/participant', 'POST', { id });
 expect(response.status).toBe(200);
 const cookie = response.headers.get('Set-Cookie')!;
 expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax');
 return cookie.split(';')[0];
}
let id: string, otherId: string, run: string, campaign: string;
beforeAll(async () => {
 await setupApp(); await request('/api/me');
 await addMember(TESTER, 'tester', 'Open Tester'); await addMember(other, 'tester', 'Other Tester');
 const members = await ok<{ email: string; instance: number }[]>(request('/api/admin/members'));
 id = String(members.find(m => m.email === TESTER)!.instance);
 otherId = String(members.find(m => m.email === other)!.instance);
 const release = await publishExample('acme-claims');
 campaign = await newCampaign(release, 'Open access history');
 await invite(campaign, [{ email: TESTER, roles: ['claimant'] }, { email: other, roles: ['claimant'] }]);
 run = await startRun(campaign, TESTER, 'claimant');
 await ok(request(`/api/runs/${run}/results/C1-1`, 'PUT', { status: 'pass', note: '', rev: 0 }, TESTER));
});

describe('open access', () => {
 it('opens admin without a participant while tester APIs require a choice', async () => {
  expect((await call('/api/admin/documents')).status).toBe(200);
  expect(await (await call('/api/me')).json()).toMatchObject({ openAccess: true, canAdmin: true, selected: false, isAdmin: false });
  const missing = await call('/api/campaigns');
  expect(missing.status).toBe(409); expect(await missing.json()).toMatchObject({ code: 'selection_required' });
 });
 it('publishes only picker fields and the public workspace, not roster emails or configuration', async () => {
  const response = await call('/api/participants');
  expect(response.status).toBe(200);
  const data = await response.json() as { participants: { id: string; label: string }[]; workspace: object; openAccess: boolean };
  expect(data.openAccess).toBe(true);
  expect(data.participants.find(p => p.id === id)).toEqual({ id, label: 'Open Tester' });
  for (const p of data.participants) expect(Object.keys(p).sort()).toEqual(['id', 'label']);
  const body = JSON.stringify(data);
  expect(body).not.toContain(TESTER); expect(body).not.toContain('ado_org_url'); expect(body).not.toContain('ADO_PAT');
 });
 it('resumes historical subject and progress instead of creating a new tester', async () => {
  const cookie = await choose(id);
  const me = await ok<{ sub: string }>(call('/api/me', 'GET', undefined, cookie));
  expect(me).toMatchObject({ sub: `sub:${TESTER}`, participantId: id, isAdmin: false, canAdmin: true, selected: true });
  const campaigns = await ok<{ id: string; runs: { id: string }[] }[]>(call('/api/campaigns', 'GET', undefined, cookie));
  expect(campaigns.find(c => c.id === campaign)!.runs[0].id).toBe(run);
  const payload = await ok<{ results: { step_id: string; status: string }[] }>(call(`/api/runs/${run}`, 'GET', undefined, cookie));
  expect(payload.results).toContainEqual(expect.objectContaining({ step_id: 'C1-1', status: 'pass' }));
  expect((await call('/api/me', 'PUT', { displayName: 'Renamed' }, cookie, id)).status).toBe(400);
 });
 it('keeps tester writes scoped, rejects stale-tab contexts, and labels admin changes honestly', async () => {
  const cookie = await choose(otherId);
  const stale = await call(`/api/runs/${run}/results/C1-1`, 'PUT', { status: 'pass', note: '', rev: 1 }, cookie, id);
  expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'participant_changed' });
  expect((await call(`/api/runs/${run}`, 'GET', undefined, cookie)).status).toBe(404);
  expect((await call(`/api/runs/${run}/results/C1-1`, 'PUT', { status: 'pass', note: '', rev: 1 }, cookie, otherId)).status).toBe(404);
  await ok(call('/api/admin/members', 'POST', { email: 'open-added@example.com', display_name: 'Added openly' }), 201);
  const audit = await ok<{ action: string; target: string; actor_sub: string }[]>(call('/api/admin/audit'));
  expect(audit.find(a => a.target === 'open-added@example.com')).toMatchObject({ actor_sub: 'open:admin' });
 });
 it('validates choices, forgets them, and requires same-origin writes', async () => {
  for (const value of ['999999', 'bad', '', null]) expect((await call('/api/participant', 'POST', { id: value })).status).toBe(400);
  for (const from of [null, 'https://other.example']) expect((await call('/api/participant', 'POST', { id }, undefined, undefined, from)).status).toBe(403);
  const selected = await choose(id);
  const forgotten = await call('/api/participant', 'DELETE', undefined, selected);
  expect(forgotten.status).toBe(200); expect(forgotten.headers.get('Set-Cookie')).toContain('Max-Age=0');
  expect((await call('/api/campaigns', 'GET', undefined, 'uat-participant=bad')).status).toBe(409);
  await ok(request(`/api/admin/members/${other}`, 'PATCH', { active: false }));
  expect((await call('/api/participant', 'POST', { id: otherId })).status).toBe(400);
 });
 it('sets host-only secure cookies in HTTPS and does not give roster admins tester admin privileges', async () => {
  const members = await ok<{ email: string; instance: number }[]>(request('/api/admin/members'));
  const adminId = String(members.find(m => m.email === ADMIN)!.instance);
  const response = await rawApp().fetch(new Request('https://uat.example/api/participant', {
   method: 'POST', headers: { Origin: 'https://uat.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: adminId })
  }), openEnv());
  expect(response.status).toBe(200);
  expect(response.headers.get('Set-Cookie')).toContain('__Host-uat-participant=');
  expect(response.headers.get('Set-Cookie')).toContain('; Secure');
  const cookie = await choose(adminId);
  expect(await (await call('/api/me', 'GET', undefined, cookie)).json()).toMatchObject({ isAdmin: false, canAdmin: true });
 });
 it('fails closed outside the exact open-mode setting', async () => {
  for (const value of [undefined, '0', 'true', 'TRUE', 'false']) {
   const response = await rawApp().fetch(new Request('https://uat.example/api/admin/documents'), { ...env, OPEN_ACCESS: value });
   expect(response.status).toBe(401);
  }
 });
 it('creates stable identities for new testers and explicitly rejects ambiguous histories', async () => {
  const email = 'open-fresh@example.com';
  await addMember(email, 'tester', 'Fresh tester');
  const members = await ok<{ email: string; instance: number }[]>(request('/api/admin/members'));
  const freshId = String(members.find(m => m.email === email)!.instance);
  const cookie = await choose(freshId);
  const first = await ok<{ sub: string }>(call('/api/me', 'GET', undefined, cookie));
  expect(first.sub).toBe(`open:tester:${freshId}`);
  expect(await ok(call('/api/me', 'GET', undefined, cookie))).toMatchObject({ sub: first.sub });
  const ts = new Date().toISOString();
  await env.DB.prepare('INSERT INTO users(sub,email,first_seen,last_seen) VALUES(?,?,?,?)').bind('ambiguous-extra-sub', email, ts, ts).run();
  const ambiguous = await call('/api/participant', 'POST', { id: freshId });
  expect(ambiguous.status).toBe(409); expect(await ambiguous.json()).toMatchObject({ code: 'identity_ambiguous' });
 });
 it('offers an explicit empty roster instead of inventing or auto-selecting a tester', async () => {
  const active = await env.DB.prepare('SELECT email FROM members WHERE active=1').all<{ email: string }>();
  try {
   await env.DB.prepare('UPDATE members SET active=0 WHERE active=1').run();
   const data = await ok(call('/api/participants'));
   expect(data).toMatchObject({ openAccess: true, participants: [], selectedId: null });
  } finally {
   await env.DB.batch(active.results.map(m => env.DB.prepare('UPDATE members SET active=1 WHERE email=?').bind(m.email)));
  }
 });
});
