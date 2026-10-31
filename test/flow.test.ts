import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, addMember, invite, newCampaign, ok, publishExample, rawApp, request, setupApp, startRun } from './helpers';

const CLAIMANT = 'clara@example.com', ADJUSTER = 'adam@example.com', OUTSIDER = 'nobody@example.com';
let release: string, campaign: string;

beforeAll(async () => {
 await setupApp();
 await request('/api/me'); // bootstrap admin
 await addMember(CLAIMANT, 'tester', 'Clara'); await addMember(ADJUSTER, 'tester', 'Adam');
 release = await publishExample('acme-claims');
 campaign = await newCampaign(release, 'Round 1');
 await invite(campaign, [{ email: CLAIMANT, roles: ['claimant'] }, { email: ADJUSTER, roles: ['adjuster'] }]);
 await ok(request(`/api/admin/campaigns/${campaign}/handoffs`, 'PUT', { bindings: [{ key: 'claim-filed', producer: CLAIMANT, consumers: [ADJUSTER] }] }));
});

describe('access control', () => {
 it('requires a verified Access JWT', async () => {
  expect((await rawApp().fetch(new Request('https://uat.example/api/me'), env)).status).toBe(401);
  expect((await rawApp().fetch(new Request('https://uat.example/api/me', { headers: { 'x-dev-user': ADMIN } }), env)).status).toBe(401);
 });
 it('rejects people who were not invited, and non-admins on admin routes', async () => {
  const r = await request('/api/me', 'GET', undefined, OUTSIDER);
  expect(r.status).toBe(403); expect(await r.json()).toMatchObject({ code: 'not_invited' });
  expect((await request('/api/admin/members', 'GET', undefined, CLAIMANT)).status).toBe(403);
 });
 it('refuses to serve when the database belongs to another deployment', async () => {
  const { _resetDeploymentCache } = await import('../src/auth'); _resetDeploymentCache();
  expect((await request('/api/me', 'GET', undefined, ADMIN, { DEPLOYMENT_ID: 'someone-else' })).status).toBe(503);
  _resetDeploymentCache();
  expect((await request('/api/me')).status).toBe(200);
 });
 it('only lets invited roles start runs, and isolates runs between owners', async () => {
  const bad = await request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'adjuster' }, CLAIMANT);
  expect(bad.status).toBe(403);
  expect((await request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant' }, OUTSIDER)).status).toBe(403);
  const id = await startRun(campaign, CLAIMANT, 'claimant');
  expect((await request(`/api/runs/${id}`, 'GET', undefined, ADJUSTER)).status).toBe(404);
  expect((await request(`/api/runs/${id}/results/C1-1`, 'PUT', { status: 'pass', note: '', rev: 0 }, ADMIN)).status).toBe(404);
  expect((await request(`/api/admin/runs/${id}`)).status).toBe(200);
 });
 it('deactivated members lose access but keep their reserved instance number', async () => {
  await addMember('temp@example.com'); const before = (await ok<any[]>(request('/api/admin/members'))).find(m => m.email === 'temp@example.com');
  await ok(request('/api/admin/members/temp@example.com', 'PATCH', { active: false }));
  expect((await request('/api/me', 'GET', undefined, 'temp@example.com')).status).toBe(403);
  await addMember('later@example.com');
  const all = await ok<any[]>(request('/api/admin/members'));
  expect(all.find(m => m.email === 'later@example.com').instance).toBeGreaterThan(before.instance);
 });
 it('cannot deactivate the last administrator', async () => {
  expect((await request(`/api/admin/members/${ADMIN}`, 'PATCH', { active: false })).status).toBe(409);
 });
});

describe('fixtures, handoffs and phases', () => {
 it('freezes deterministic values per tester and keeps them stable', async () => {
  const id = await startRun(campaign, CLAIMANT, 'claimant', false).catch(async () => (await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant' }, CLAIMANT))).run.id);
  const a = await ok<any>(request(`/api/runs/${id}`, 'GET', undefined, CLAIMANT)); const b = await ok<any>(request(`/api/runs/${id}`, 'GET', undefined, CLAIMANT));
  expect(a.fixtures).toEqual(b.fixtures);
  const holder = a.fixtures.find((f: any) => f.key === 'policyholder');
  expect(holder.fields.find((f: any) => f.key === 'name').value).toMatch(/^UAT \d\d Policyholder$/);
  expect(holder.fields.find((f: any) => f.key === 'followUp').value).toBeNull(); // phase day2 not yet available
  expect(JSON.stringify(a.content.scenarios)).not.toContain('{{policyholder.name}}'.replace('name', 'zzz'));
 });
 it('gates the consumer until the producer confirms and the consumer acknowledges', async () => {
  const adj = (await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'adjuster' }, ADJUSTER), 201)).run.id;
  const waiting = await ok<any>(request(`/api/runs/${adj}`, 'GET', undefined, ADJUSTER));
  expect(waiting.fixtures.find((f: any) => f.key === 'claim').state).toBe('waiting');
  const blocked = await request(`/api/runs/${adj}/results/C2-1`, 'PUT', { status: 'pass', note: '', rev: 0 }, ADJUSTER);
  expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ code: 'handoff_blocked' });
  await ok(request(`/api/runs/${adj}/results/C2-1`, 'PUT', { status: 'blocked', note: 'Waiting for the claim', rev: 0 }, ADJUSTER));
  const [h] = await ok<any[]>(request('/api/handoffs', 'GET', undefined, CLAIMANT));
  expect((await request(`/api/handoffs/${h.id}/acknowledge`, 'POST', {}, ADJUSTER)).status).toBe(409);
  await ok(request(`/api/handoffs/${h.id}/ready`, 'POST', { recordRef: 'CLM-1' }, CLAIMANT));
  await ok(request(`/api/handoffs/${h.id}/acknowledge`, 'POST', {}, ADJUSTER));
  const ready = await ok<any>(request(`/api/runs/${adj}`, 'GET', undefined, ADJUSTER));
  expect(ready.fixtures.find((f: any) => f.key === 'claim').state).toBe('ready');
  const saved = await ok<any>(request(`/api/runs/${adj}/results/C2-1`, 'PUT', { status: 'pass', note: '', rev: 1 }, ADJUSTER));
  expect(saved.rev).toBe(2);
 });
 it('lets an admin override a handoff with an audited reason', async () => {
  await addMember('dana@example.com'); await addMember('eli@example.com');
  const c2 = await newCampaign(release, 'Round 2');
  await invite(c2, [{ email: 'dana@example.com', roles: ['claimant'] }, { email: 'eli@example.com', roles: ['adjuster'] }]);
  await ok(request(`/api/admin/campaigns/${c2}/handoffs`, 'PUT', { bindings: [{ key: 'claim-filed', producer: 'dana@example.com', consumers: ['eli@example.com'] }] }));
  const run = await startRun(c2, 'eli@example.com', 'adjuster');
  const { handoffs } = await ok<any>(request(`/api/runs/${run}`, 'GET', undefined, 'eli@example.com'));
  expect((await request(`/api/runs/${run}/results/C2-2`, 'PUT', { status: 'pass', note: '', rev: 0 }, 'eli@example.com')).status).toBe(409);
  expect((await request(`/api/admin/handoffs/${handoffs[0].id}/override`, 'POST', { reason: '' })).status).toBe(400);
  await ok(request(`/api/admin/handoffs/${handoffs[0].id}/override`, 'POST', { reason: 'Producer on leave' }));
  await ok(request(`/api/runs/${run}/results/C2-2`, 'PUT', { status: 'pass', note: '', rev: 0 }, 'eli@example.com'));
  const audit = await ok<any[]>(request('/api/admin/audit'));
  expect(audit.some(a => a.action === 'handoff-override' && a.detail === 'Producer on leave')).toBe(true);
 });
 it('locks steps in a future phase', async () => {
  const run = (await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant' }, CLAIMANT))).run.id;
  const r = await request(`/api/runs/${run}/results/C3-1`, 'PUT', { status: 'pass', note: '', rev: 0 }, CLAIMANT);
  expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ code: 'phase_locked' });
 });
 it('reset creates a new fixture generation and archives the old run', async () => {
  const before = (await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant' }, CLAIMANT))).run;
  const fresh = await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant', reset: true }, CLAIMANT), 201);
  expect(fresh.run.id).not.toBe(before.id); expect(fresh.run.fixture_generation).toBe(before.fixture_generation + 1);
  expect((await env.DB.prepare('SELECT archived FROM runs WHERE id=?').bind(before.id).first<{ archived: number }>())!.archived).toBe(1);
 });
});

describe('results', () => {
 it('validates statuses, notes and references, and detects conflicts with compare-and-set', async () => {
  const run = (await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant' }, CLAIMANT))).run.id;
  const put = (d: unknown) => request(`/api/runs/${run}/results/C1-1`, 'PUT', d, CLAIMANT);
  expect((await put({ status: 'nope', note: '', rev: 0 })).status).toBe(400);
  expect((await put({ status: 'issue', note: '', rev: 0 })).status).toBe(400);
  expect((await put({ status: 'known', note: 'see ticket', rev: 0 })).status).toBe(400);
  await ok(put({ status: 'known', note: 'see ticket 1234', rev: 0 }));
  expect((await put({ status: 'pass', note: '', rev: 0 })).status).toBe(409);
  await ok(put({ status: 'pass', note: '', rev: 1 }));
  expect((await request(`/api/runs/${run}/results/C2-1`, 'PUT', { status: 'pass', note: '', rev: 0 }, CLAIMANT)).status).toBe(400); // not this role's step
 });
 it('locks a result after triage and does not write run.updated_at on saves', async () => {
  const run = (await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant' }, CLAIMANT))).run.id;
  await ok(request(`/api/runs/${run}/results/C1-2`, 'PUT', { status: 'issue', note: 'Broken submit', rev: 0 }, CLAIMANT));
  await ok(request(`/api/admin/findings/result/${encodeURIComponent(run + '~C1-2')}`, 'PATCH', { triage: 'Accepted', admin_note: 'ok' }));
  const r = await request(`/api/runs/${run}/results/C1-2`, 'PUT', { status: 'pass', note: '', rev: 1 }, CLAIMANT);
  expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ locked: true });
 });
 it('exports recorded and passing separately with CSV formula protection', async () => {
  const run = (await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant' }, CLAIMANT))).run.id;
  await ok(request(`/api/runs/${run}/results/C1-1`, 'PUT', { status: 'question', note: '=HYPERLINK("x")', rev: 2 }, CLAIMANT));
  const csv = await (await request(`/api/admin/export/results.csv?campaign=${campaign}`)).text();
  expect(csv.split('\r\n')[0]).toContain('"recorded","passing"');
  expect(csv).toContain(`"'=HYPERLINK`);
 });
 it('reports invitees who have not started in progress', async () => {
  const p = await ok<any[]>(request(`/api/admin/campaigns/${campaign}/progress`));
  expect(p.length).toBeGreaterThanOrEqual(2); expect(p.every(r => 'recorded' in r && 'passing' in r)).toBe(true);
 });
});

describe('documents', () => {
 it('generates a deterministic synthetic PDF from frozen values', async () => {
  const run = (await ok<any>(request(`/api/campaigns/${campaign}/runs`, 'POST', { role: 'claimant' }, CLAIMANT))).run.id;
  const a = await request(`/api/runs/${run}/documents/claim-summary`, 'GET', undefined, CLAIMANT); const b = await request(`/api/runs/${run}/documents/claim-summary`, 'GET', undefined, CLAIMANT);
  expect(a.status).toBe(200); expect(a.headers.get('content-type')).toBe('application/pdf');
  expect(a.headers.get('x-content-sha256')).toBe(b.headers.get('x-content-sha256'));
  expect(new TextDecoder().decode(await a.arrayBuffer())).toContain('SYNTHETIC TEST DOCUMENT');
 });
});

describe('release lifecycle', () => {
 it('makes published releases immutable, in the API and in the database', async () => {
  expect((await request(`/api/admin/releases/${release}`, 'PUT', { label: 'x' })).status).toBe(409);
  await expect(env.DB.prepare('UPDATE releases SET content=? WHERE id=?').bind('{}', release).run()).rejects.toThrow(/immutable/);
  await expect(env.DB.prepare('DELETE FROM releases WHERE id=?').bind(release).run()).rejects.toThrow(/cannot be deleted/);
 });
 it('blocks publishing a draft with validation errors', async () => {
  const { id } = await ok<any>(request('/api/admin/releases', 'POST', { content: { schema: 1, title: 'x', roles: [], scenarios: [] } }), 201);
  const r = await request(`/api/admin/releases/${id}/publish`, 'POST', {}); expect(r.status).toBe(400);
 });
 it('imports a CSV of steps and publishes it', async () => {
  const csv = 'scenario_id,scenario_title,step_id,instructions,expected,roles\nS1,Login,S1-1,"Sign in, then wait",Home shows,Tester;Reviewer\n';
  const { id, issues } = await ok<any>(request('/api/admin/releases', 'POST', { csv, label: 'csv', title: 'Imported' }), 201);
  expect(issues.filter((i: any) => i.level === 'error')).toEqual([]);
  await ok(request(`/api/admin/releases/${id}/publish`, 'POST', {}));
 });
 it('re-pointing a campaign keeps existing runs on their pinned release', async () => {
  const second = await publishExample('northwind');
  const c = await newCampaign(release, 'Repoint'); await invite(c, [{ email: CLAIMANT, roles: ['claimant'] }]);
  const run = await startRun(c, CLAIMANT, 'claimant');
  await ok(request(`/api/admin/campaigns/${c}`, 'PUT', { release_id: second }));
  expect((await ok<any>(request(`/api/runs/${run}`, 'GET', undefined, CLAIMANT))).release.id).toBe(release);
  await ok(request(`/api/admin/campaigns/${c}`, 'PUT', { starts_on: '2030-01-01' }).then(r => r), 409);
 });
 it('purges a closed campaign only after confirmation', async () => {
  const c = await newCampaign(release, 'Purge me'); await invite(c, [{ email: CLAIMANT, roles: ['claimant'] }]); await startRun(c, CLAIMANT, 'claimant');
  expect((await request(`/api/admin/campaigns/${c}/purge`, 'POST', { confirm: 'Purge me' })).status).toBe(409);
  await ok(request(`/api/admin/campaigns/${c}/close`, 'POST', {}));
  expect((await request(`/api/admin/campaigns/${c}/purge`, 'POST', { confirm: 'wrong' })).status).toBe(400);
  await ok(request(`/api/admin/campaigns/${c}/purge`, 'POST', { confirm: 'Purge me' }));
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE campaign_id=?').bind(c).first<{ n: number }>())!.n).toBe(0);
 });
});
