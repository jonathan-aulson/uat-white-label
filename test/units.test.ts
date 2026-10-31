import { deflateSync } from 'node:zlib';
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkBranding, contrast, sanitizeImage, themeCss } from '../src/branding';
import { validateContent } from '../src/content';
import { generatePdf, validateUploadedPdf } from '../src/pdf';
import { EXAMPLES } from '../src/examples';
import { parseCsv, csvToContent } from '../src/csvimport';
import sampleCsv from '../examples/sample-steps.csv?raw';
import { fetcher, invite, newCampaign, ok, publishExample, request, setupApp, startRun, addMember, ADMIN } from './helpers';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array) {
 const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
 dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8); dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length))); return out;
}
function png(w: number, h: number, extra: Uint8Array[] = []) {
 const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
 const row = new Uint8Array(1 + w * 3); const raw = new Uint8Array(row.length * h); for (let y = 0; y < h; y++) raw.set(row, y * row.length);
 const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array())];
 const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
beforeAll(setupApp);

describe('content validation', () => {
 it('accepts every shipped example and template', () => {
  for (const [key, e] of Object.entries(EXAMPLES)) expect(validateContent(e.content).issues.filter(i => i.level === 'error'), key).toEqual([]);
 });
 it('rejects unknown tokens, role references, cycles and stray braces', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLES['acme-claims'].content));
  bad.scenarios[0].steps[0].text = 'Use {{nope.field}} and {{policyholder.zzz}} and {{ broken';
  bad.scenarios[0].steps[0].roles = ['ghost'];
  bad.fixtures[0].fields[0].rule = { type: 'ref', field: 'policy' }; bad.fixtures[0].fields[1].rule = { type: 'ref', field: 'name' };
  const msgs = validateContent(bad).issues.filter(i => i.level === 'error').map(i => i.message).join('|');
  expect(msgs).toMatch(/nope/); expect(msgs).toMatch(/zzz/); expect(msgs).toMatch(/ghost/i); expect(msgs).toMatch(/circular|cycle/i);
 });
 it('rejects handoff dependency cycles', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLES['acme-claims'].content));
  bad.handoffs = [{ key: 'a', label: 'A', fixture: 'claim', dependsOn: ['b'] }, { key: 'b', label: 'B', fixture: 'claim', dependsOn: ['a'] }];
  expect(validateContent(bad).issues.some(i => i.level === 'error' && /cycle|circular/i.test(i.message))).toBe(true);
 });
 it('parses quoted CSV fields', () => {
  expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
 });
});

describe('branding', () => {
 it('enforces contrast and suggests accessible alternatives', () => {
  const r = checkBranding({ primary: '#f5f5aa', accent: '#b45309', background: '#ffffff' });
  expect(r.ok).toBe(false); expect(r.errors[0].suggestion).toBeTruthy();
  expect(contrast(r.errors[0].suggestion!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  expect(checkBranding({ primary: '#1f4e79', accent: '#b45309', background: '#f5f7fa' }).ok).toBe(true);
 });
 it('derives readable theme tokens and never emits unvalidated values', () => {
  const css = themeCss({ primary: '#1f4e79', accent: '#b45309', background: '#0b1220', font: 'system' }, 3);
  expect(css).toContain('--primary:#1f4e79'); expect(css).toContain('--on-primary:#ffffff'); expect(css).toContain('branding revision 3');
 });
 it('strips PNG metadata chunks losslessly and rejects non-images', () => {
  const text = chunk('tEXt', new TextEncoder().encode('Author\0Jane Doe')), exif = chunk('eXIf', new Uint8Array([1, 2, 3]));
  const original = png(8, 8, [text, exif]); const clean = sanitizeImage(original);
  expect(clean.width).toBe(8); expect(new TextDecoder('latin1').decode(clean.bytes)).not.toContain('Jane Doe');
  expect(clean.bytes.length).toBeLessThan(original.length);
  expect(() => sanitizeImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toThrow(/PNG and JPEG/);
 });
 it('serves branding through the API: rejects bad contrast, accepts logo and square favicon only', async () => {
  const bad = await request('/api/admin/branding', 'PUT', { primary: '#f5f5aa', accent: '#b45309', background: '#ffffff', font: 'system' });
  expect(bad.status).toBe(400);
  await ok(request('/api/admin/branding', 'PUT', { primary: '#7a1f3d', accent: '#8a4b00', background: '#faf7f5', font: 'roboto' }));
  const css = await (await request('/theme.css')).text(); expect(css).toContain('#7a1f3d');
  const logo = png(40, 20);
  expect((await request('/api/admin/branding/logo', 'PUT', undefined, ADMIN, {}, { body: logo, type: 'image/png' })).status).toBe(200);
  expect((await request('/api/admin/branding/favicon', 'PUT', undefined, ADMIN, {}, { body: logo, type: 'image/png' })).status).toBe(400);
  expect((await request('/api/admin/branding/favicon', 'PUT', undefined, ADMIN, {}, { body: png(16, 16), type: 'image/png' })).status).toBe(200);
  const served = await request('/brand/logo'); expect(served.headers.get('content-type')).toBe('image/png');
  expect(((await request('/api/me')).headers.get('content-security-policy'))).toContain("default-src 'self'");
 });
});

describe('PDF gates', () => {
 const valid = () => generatePdf({ title: 'T', rows: [{ label: 'a', value: 'b' }], created: '2026-01-01' });
 it('generates a PDF that passes the structural gate', () => { expect(validateUploadedPdf(valid()).pages).toBe(1); });
 it('rejects active content, compressed object streams, and non-PDFs', () => {
  const dec = (s: string) => new TextEncoder().encode(s);
  const withName = (n: string) => dec(new TextDecoder('latin1').decode(valid()).replace('/Type /Catalog', `/Type /Catalog /${n} 1 0 R`));
  expect(() => validateUploadedPdf(withName('OpenAction'))).toThrow(/OpenAction/);
  expect(() => validateUploadedPdf(withName('J#61vaScript'))).toThrow(/JavaScript/);
  expect(() => validateUploadedPdf(withName('ObjStm'))).toThrow(/compressed/);
  expect(() => validateUploadedPdf(dec('hello'))).toThrow(/not a PDF/);
 });
 it('uploads, audience-limits and revokes a document pinned by hash', async () => {
  const p = (await request('/api/admin/documents?title=Guide&attested=1&audience=tester', 'POST', undefined, ADMIN, {}, { body: valid(), type: 'application/pdf' }));
  expect(p.status).toBe(201); const { id, sha256 } = await p.json() as { id: string; sha256: string };
  expect((await request('/api/admin/documents?title=Guide', 'POST', undefined, ADMIN, {}, { body: valid(), type: 'application/pdf' })).status).toBe(400);
  const content = { schema: 1, title: 'Docs', roles: [{ key: 'tester', label: 'Tester' }, { key: 'other', label: 'Other' }], documents: [{ key: 'guide', title: 'Guide', kind: 'upload', documentId: id, sha256 }],
   scenarios: [{ id: 'S', title: 'S', steps: [{ id: 'S-1', text: 'Read the guide', expect: 'Read', roles: ['tester', 'other'], docs: ['guide'] }] }] };
  const rel = await ok<any>(request('/api/admin/releases', 'POST', { content }), 201); await ok(request(`/api/admin/releases/${rel.id}/publish`, 'POST', {}));
  await addMember('doc@example.com');
  const c = await newCampaign(rel.id, 'Docs'); await invite(c, [{ email: 'doc@example.com', roles: ['tester', 'other'] }]);
  const run = await startRun(c, 'doc@example.com', 'tester');
  expect((await request(`/api/runs/${run}/documents/guide`, 'GET', undefined, 'doc@example.com')).status).toBe(200);
  const other = await startRun(c, 'doc@example.com', 'other');
  expect((await request(`/api/runs/${other}/documents/guide`, 'GET', undefined, 'doc@example.com')).status).toBe(404);
  await ok(request(`/api/admin/documents/${id}/revoke`, 'POST', {}));
  expect((await request(`/api/runs/${run}/documents/guide`, 'GET', undefined, 'doc@example.com')).status).toBe(410);
  const bad = JSON.parse(JSON.stringify(content)); bad.documents[0].sha256 = 'f'.repeat(64);
  const r2 = await ok<any>(request('/api/admin/releases', 'POST', { content: bad }), 201);
  expect((await request(`/api/admin/releases/${r2.id}/publish`, 'POST', {})).status).toBe(400);
 });
});

describe('ADO integration (mocked)', () => {
 let run: string, campaign: string; const TESTER = 'ado-tester@example.com';
 const resp = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
 beforeAll(async () => {
  await addMember(TESTER); const release = await publishExample('northwind');
  campaign = await newCampaign(release, 'ADO'); await invite(campaign, [{ email: TESTER, roles: ['front-desk'] }]);
  run = await startRun(campaign, TESTER, 'front-desk'); await ok(request(`/api/runs/${run}`, 'GET', undefined, TESTER));
  await ok(request(`/api/runs/${run}/results/A-1`, 'PUT', { status: 'defect', note: 'Search finds nothing', rev: 0 }, TESTER));
 });
 beforeEach(() => fetcher.mockReset());
 const id = () => encodeURIComponent(run + '~A-1');
 const withPat = { ADO_PAT: 'x-secret-pat' };
 it('rejects non-Azure DevOps hosts in settings', async () => {
  for (const url of ['https://evil.example.com/org', 'http://dev.azure.com/org', 'https://dev.azure.com.evil.com/org', 'https://dev.azure.com/org/extra'])
   expect((await request('/api/admin/settings', 'PUT', { ado_org_url: url })).status, url).toBe(400);
  await ok(request('/api/admin/settings', 'PUT', { ado_org_url: 'https://dev.azure.com/acme', ado_project: 'UAT Proj', ado_tags: 'UAT; Client' }));
 });
 it('previews the repro steps with the tester\'s real frozen values', async () => {
  const p = await ok<any>(request(`/api/admin/findings/result/${id()}/ado-preview`));
  expect(p.repro).toMatch(/Register patient Test\d\d Patient, born \d{4}-\d\d-\d\d/); expect(p.repro).toMatch(/Steps to Reproduce:/); expect(p.correlationTag).toMatch(/^UAT-/);
 });
 it('creates one work item, and recovers by correlation tag instead of duplicating', async () => {
  const p = await ok<any>(request(`/api/admin/findings/result/${id()}/ado-preview`));
  const payload = { title: p.title, repro: p.repro, severity: '2 - High', priority: 2, confirmNoPhi: true };
  fetcher.mockResolvedValueOnce(resp({ workItems: [] })).mockResolvedValueOnce(resp({ id: 4242 }));
  const first = await ok<any>(request(`/api/admin/findings/result/${id()}/create-ado`, 'POST', payload, ADMIN, withPat));
  expect(first.ado_id).toBe(4242); expect(first.ado_url).toBe('https://dev.azure.com/acme/UAT%20Proj/_workitems/edit/4242');
  const calls = fetcher.mock.calls; expect(calls.every(c => String(c[0]).startsWith('https://dev.azure.com/acme/'))).toBe(true);
  expect(String((calls[0][1] as RequestInit).body)).toContain(p.correlationTag);
  expect((await ok<any>(request(`/api/admin/findings/result/${id()}/create-ado`, 'POST', payload, ADMIN, withPat))).ado_id).toBe(4242);
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('never creates without PHI confirmation or a valid repro, and never echoes the PAT', async () => {
  expect((await request(`/api/admin/findings/result/${id()}/create-ado`, 'POST', { title: 't', repro: 'x', severity: '2 - High', priority: 2 }, ADMIN, withPat)).status).toBe(400);
  const settings = JSON.stringify(await ok(request('/api/admin/settings')));
  expect(settings).not.toContain('x-secret-pat'); expect(JSON.parse(settings).ado_pat_configured).toBe(false);
 });
 it('links an existing work item only after verifying it belongs to the configured project', async () => {
  const run2 = await startRun(campaign, TESTER, 'front-desk', true);
  await ok(request(`/api/runs/${run2}/results/A-1`, 'PUT', { status: 'query', note: 'Why?', rev: 0 }, TESTER));
  const fid = encodeURIComponent(run2 + '~A-1');
  fetcher.mockResolvedValueOnce(resp({ id: 77, fields: { 'System.TeamProject': 'Other' } }));
  expect((await request(`/api/admin/findings/result/${fid}/link-ado`, 'POST', { ado_id: 77 }, ADMIN, withPat)).status).toBe(400);
  fetcher.mockResolvedValueOnce(resp({ id: 77, fields: { 'System.TeamProject': 'UAT Proj' } }));
  await ok(request(`/api/admin/findings/result/${fid}/link-ado`, 'POST', { ado_id: 77 }, ADMIN, withPat));
 });
 it('refuses redirects (never follows them with credentials)', async () => {
  const run3 = await startRun(campaign, TESTER, 'front-desk', true);
  await ok(request(`/api/runs/${run3}/results/A-1`, 'PUT', { status: 'defect', note: 'Again', rev: 0 }, TESTER));
  const fid = encodeURIComponent(run3 + '~A-1'); const p = await ok<any>(request(`/api/admin/findings/result/${fid}/ado-preview`));
  fetcher.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/' } }));
  const r = await request(`/api/admin/findings/result/${fid}/create-ado`, 'POST', { title: p.title, repro: p.repro, severity: '2 - High', priority: 2, confirmNoPhi: true }, ADMIN, withPat);
  expect(r.status).toBeGreaterThanOrEqual(400); expect(fetcher.mock.calls.every(c => (c[1] as RequestInit).redirect === 'manual')).toBe(true);
 });
 it('redaction hides notes everywhere, including history, and blocks export', async () => {
  const run4 = await startRun(campaign, TESTER, 'front-desk', true);
  await ok(request(`/api/runs/${run4}/results/A-1`, 'PUT', { status: 'defect', note: 'Jane Roe 555-1234', rev: 0 }, TESTER));
  const fid = encodeURIComponent(run4 + '~A-1');
  await ok(request(`/api/admin/findings/result/${fid}/redact`, 'POST', {}));
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM result_history WHERE run_id=? AND note LIKE '%Roe%'").bind(run4).first<{ n: number }>())!.n).toBe(0);
  const list = await ok<any[]>(request('/api/admin/findings')); expect(JSON.stringify(list)).not.toContain('Jane Roe');
 });
});

describe('two clients on one build', () => {
 it('keeps content, roles and branding fully data-driven', () => {
  const a = EXAMPLES['acme-claims'].content, n = EXAMPLES.northwind.content;
  expect(JSON.stringify(a)).not.toMatch(/Northwind|Nurse/); expect(JSON.stringify(n)).not.toMatch(/Acme|Claimant|adjuster/i);
 });
});

describe('shipped sample CSV', () => {
 it('imports and validates', () => {
  const c = csvToContent(sampleCsv, 'Sample');
  expect(validateContent(c, new Map()).issues.filter(i => i.level === 'error')).toEqual([]);
 });
});
