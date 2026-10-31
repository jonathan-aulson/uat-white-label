import { env } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import type { Content } from '../src/types';
import { MAX_REPRO_LENGTH, reproHtml, validateRepro } from '../src/ado';
import { addMember, ADMIN, fetcher, invite, newCampaign, ok, request, setupApp, startRun } from './helpers';

const tester = 'repro-context@example.com';
const withPat = { ADO_PAT: 'repro-test-secret' };
const content: Content = {
 schema: 1, title: 'Reproduction context',
 roles: [{ key: 'tester', label: 'Tester' }, { key: 'other', label: 'Other' }],
 fixtures: [{ key: 'data', label: 'Data', scope: 'tester', fields: [
  { key: 'name', label: 'Name', rule: { type: 'literal', value: 'Frozen Falcon' } }
 ], captures: [{ key: 'id', label: 'Record ID' }] }],
 scenarios: [
  { id: 'A', title: 'Preparation', before: 'Sign in as {{data.name}}.', steps: [
   { id: 'A-1', text: 'Create {{data.name}}.', expect: 'Created.', roles: ['tester'] },
   { id: 'A-X', text: 'Other-role private operation.', expect: 'Done.', roles: ['other'] },
   { id: 'A-2', text: 'Open record {{data.id}}.', expect: 'Record displayed.', roles: ['tester'] }
  ] },
  { id: 'B', title: 'Submit', before: 'Keep the record open.', steps: [
   { id: 'B-1', text: 'Submit {{data.name}}.', expect: 'Submission accepted.', roles: ['tester'] },
   { id: 'B-2', text: 'Later step must not appear.', expect: 'Finished.', roles: ['tester'] }
  ] }
 ]
};
interface Preview { title: string; repro: string; severity: string; priority: number; configured: boolean }
let run: string, campaign: string, release: string;
const feedback = crypto.randomUUID();
const path = (runId: string, step = 'B-1') => `/api/admin/findings/result/${encodeURIComponent(`${runId}~${step}`)}`;
const preview = (runId: string, step = 'B-1') => ok<Preview>(request(`${path(runId, step)}/ado-preview`, 'GET', undefined, ADMIN, withPat));
async function publish(c: Content) {
 const r = await ok<{ id: string }>(request('/api/admin/releases', 'POST', { label: c.title, content: c }), 201);
 await ok(request(`/api/admin/releases/${r.id}/publish`, 'POST', {}));
 return r.id;
}
beforeAll(async () => {
 await setupApp(); await ok(request('/api/me'));
 await addMember(tester);
 await ok(request('/api/admin/settings', 'PUT', { ado_org_url: 'https://dev.azure.com/acme', ado_project: 'Test' }));
 release = await publish(content);
 campaign = await newCampaign(release, 'Repro tests');
 await invite(campaign, [{ email: tester, roles: ['tester'] }]);
 run = await startRun(campaign, tester, 'tester');
 await ok(request(`/api/runs/${run}`, 'GET', undefined, tester));
 await ok(request(`/api/runs/${run}/results/A-1`, 'PUT', { status: 'pass', note: 'Unrelated private note must not export', rev: 0 }, tester));
 await ok(request(`/api/runs/${run}/results/B-1`, 'PUT', { status: 'issue', note: 'Synthetic submission error <script>alert(1)</script>', rev: 0 }, tester));
 await ok(request(`/api/runs/${run}/feedback`, 'POST', { id: feedback, text: 'Synthetic general feedback' }, tester));
});

it('includes every preceding role-specific step across scenarios, not later or other-role steps', async () => {
 const p = await preview(run);
 expect(p.configured).toBe(true);
 expect(p.repro.indexOf('[A / A-1]')).toBeLessThan(p.repro.indexOf('[A / A-2]'));
 expect(p.repro.indexOf('[A / A-2]')).toBeLessThan(p.repro.indexOf('[B / B-1]'));
 expect(p.repro).toContain('Scenario prerequisites: Sign in as Frozen Falcon.');
 expect(p.repro).toContain('Recorded status: Passed');
 expect(p.repro).toContain('Recorded status: Not recorded');
 expect(p.repro).toContain('not a chronological execution log');
 expect(p.repro).toContain('[data.id not available]');
 expect(p.repro).not.toContain('Other-role private operation');
 expect(p.repro).not.toContain('Later step must not appear');
 expect(p.repro).not.toContain('Unrelated private note');
 expect(p.repro).toContain('Expected Result:\nSubmission accepted.');
 expect(p.repro).toContain('Actual Result:\nSynthetic submission error');
 expect(reproHtml(p.repro, '')).not.toContain('<script>');
});

it('uses the pinned release and does not create missing fixture snapshots', async () => {
 const newer = structuredClone(content); newer.scenarios[0].steps[0].text = 'Changed campaign content.';
 const newerId = await publish(newer);
 await ok(request(`/api/admin/campaigns/${campaign}`, 'PUT', { release_id: newerId }));
 expect((await preview(run)).repro).toContain('Create Frozen Falcon.');
 const fresh = await startRun(campaign, tester, 'tester', true);
 await ok(request(`/api/runs/${fresh}/results/B-1`, 'PUT', { status: 'issue', note: 'Uninitialised data', rev: 0 }, tester));
 // Reset/start itself may create snapshots; explicitly remove only this test run's fixture generation.
 const row = await env.DB.prepare('SELECT fixture_generation FROM runs WHERE id=?').bind(fresh).first<{ fixture_generation: number }>();
 await env.DB.prepare('DELETE FROM fixture_snapshots WHERE campaign_id=? AND generation=? AND scope_key=?').bind(campaign, row!.fixture_generation, tester).run();
 const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM fixture_snapshots WHERE campaign_id=?').bind(campaign).first<{ n: number }>();
 const p = await preview(fresh);
 const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM fixture_snapshots WHERE campaign_id=?').bind(campaign).first<{ n: number }>();
 expect(after?.n).toBe(before?.n);
 expect(p.repro).toContain('[data.name not available]');
});

it('requires admin completion for general feedback rather than inventing expected behavior', async () => {
 const base = `/api/admin/findings/feedback/${feedback}`;
 const p = await ok<Preview>(request(`${base}/ado-preview`, 'GET', undefined, ADMIN, withPat));
 expect(p.repro).toContain('context only, not a proven causal sequence');
 expect(p.repro).toContain('[A / A-1]');
 expect(p.repro).not.toContain('[A / A-2]');
 expect(p.repro).toContain('Expected Result:\n[ADMIN REQUIRED:');
 fetcher.mockReset();
 const response = await request(`${base}/create-ado`, 'POST', { ...p, confirmNoPhi: true }, ADMIN, withPat);
 expect(response.status).toBe(400);
 expect(fetcher).not.toHaveBeenCalled();
});

it('requires missing actual results to be supplied and blocks redacted previews', async () => {
 const fresh = await startRun(campaign, tester, 'tester', true);
 await ok(request(`/api/runs/${fresh}/results/A-1`, 'PUT', { status: 'pass', note: '', rev: 0 }, tester));
 expect((await preview(fresh, 'A-1')).repro).toContain('Actual Result:\n[ADMIN REQUIRED:');
 await ok(request(`${path(fresh, 'A-1')}/redact`, 'POST', {}));
 expect((await request(`${path(fresh, 'A-1')}/ado-preview`)).status).toBe(409);
});

it('rejects oversized full scripts explicitly rather than truncating', async () => {
 const huge: Content = { schema: 1, title: 'Large script', roles: [{ key: 'tester', label: 'Tester' }], scenarios: [
  { id: 'L', title: 'Large', steps: Array.from({ length: 40 }, (_, i) => ({ id: `L-${i}`, text: 'Long synthetic instruction. '.repeat(40), expect: 'Done.', roles: ['tester'] })) }
 ] };
 const rel = await publish(huge), c = await newCampaign(rel, 'Large');
 await invite(c, [{ email: tester, roles: ['tester'] }]);
 const r = await startRun(c, tester, 'tester');
 await ok(request(`/api/runs/${r}/results/L-39`, 'PUT', { status: 'issue', note: 'Long script failure', rev: 0 }, tester));
 const response = await request(`${path(r, 'L-39')}/ado-preview`);
 expect(response.status).toBe(400);
 expect((await response.json() as { error: string }).error).toContain('no steps have been truncated');
 expect(() => validateRepro('x'.repeat(MAX_REPRO_LENGTH + 1))).toThrow('exceeds');
});
