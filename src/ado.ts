import type { Env, Workspace } from './types';
import { HttpError } from './db';

export const SEVERITIES = ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'];
export const MAX_REPRO_LENGTH = 32000;
export const ADMIN_REQUIRED = '[ADMIN REQUIRED:';
export const REQUIRED_REPRO_HEADINGS = ['Steps to Reproduce', 'Expected Result', 'Actual Result'];
export const REPRO_HEADINGS = [...REQUIRED_REPRO_HEADINGS, 'Step ID', 'Scenario', 'Role', 'Campaign', 'Environment', 'Build', 'Release', 'Portal reference', 'Admin run view'];
const ORG_RE = /^https:\/\/dev\.azure\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_.]{0,79}$/;

// The PAT only ever leaves this Worker toward dev.azure.com. Admin-editable settings are validated against that rule.
export function validateAdoSettings(w: Partial<Workspace>) {
 const e = (m: string) => { throw new HttpError(400, m); };
 if (w.ado_org_url !== undefined && w.ado_org_url !== '' && !ORG_RE.test(w.ado_org_url)) e('ADO organization URL must look like https://dev.azure.com/<organization>');
 if (w.ado_project !== undefined && !/^[^\\/:*?"<>|#;]{0,64}$/.test(w.ado_project)) e('ADO project name contains unsupported characters');
 if (w.ado_area_path !== undefined && !/^[^<>"|?*#;]{0,200}$/.test(w.ado_area_path)) e('ADO area path contains unsupported characters');
 if (w.ado_work_item_type !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(w.ado_work_item_type)) e('Work item type contains unsupported characters');
 for (const k of ['ado_repro_field', 'ado_severity_field', 'ado_priority_field'] as const) if (w[k] !== undefined && w[k] !== '' && !FIELD_RE.test(w[k]!)) e(`${k} must be an ADO reference name such as Microsoft.VSTS.TCM.ReproSteps`);
 if (w.ado_tags !== undefined && !/^[A-Za-z0-9 _.-]+(;\s*[A-Za-z0-9 _.-]+){0,9}$|^$/.test(w.ado_tags)) e('Tags must be up to 10 plain names separated by semicolons');
}
export function adoConfig(ws: Workspace) {
 if (!ORG_RE.test(ws.ado_org_url) || !ws.ado_project) throw new HttpError(503, 'ADO is not configured. An administrator must set the organization and project.');
 return ws;
}
export const adoProjectUrl = (ws: Workspace) => `${ws.ado_org_url}/${encodeURIComponent(ws.ado_project)}`;
export const adoWorkItemUrl = (ws: Workspace, id: number) => ORG_RE.test(ws.ado_org_url) && ws.ado_project ? `${adoProjectUrl(ws)}/_workitems/edit/${id}` : null;

export function validateRepro(repro: string) {
 if (repro.length > MAX_REPRO_LENGTH) throw new HttpError(400, `Reproduction exceeds ${MAX_REPRO_LENGTH.toLocaleString('en-US')} characters; narrow the steps before creating a bug`);
 if (repro.includes(ADMIN_REQUIRED)) throw new HttpError(400, 'Replace all ADMIN REQUIRED prompts with the observed reproduction details before creating a bug');
 const lines = repro.replace(/\r\n?/g, '\n').split('\n');
 const sections = lines.flatMap((line, index) => REPRO_HEADINGS.includes(line.trim().replace(/:$/, '')) && line.trim().endsWith(':') ? [{ heading: line.trim().slice(0, -1), index }] : []);
 for (let i = 0; i < REQUIRED_REPRO_HEADINGS.length; i++) {
  const heading = REQUIRED_REPRO_HEADINGS[i];
  if (sections[i]?.heading !== heading || sections.filter(s => s.heading === heading).length !== 1) throw new HttpError(400, 'Reproduction must include Steps to Reproduce:, Expected Result: and Actual Result: once, in that order');
  if (!lines.slice(sections[i].index + 1, sections[i + 1]?.index).join('\n').trim()) throw new HttpError(400, `${heading} must not be blank`);
 }
}
export async function correlationTag(kind: string, id: string) {
 const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}:${id}`));
 return `UAT-${kind}-${Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function reproHtml(repro: string, runUrl: string) {
 return repro.replace(/\r\n?/g, '\n').split('\n').map(line => {
  if (REPRO_HEADINGS.some(h => line.trim() === h + ':')) return `<strong>${escapeHtml(line.trim())}</strong>`;
  if (line === runUrl) return `<a href="${escapeHtml(runUrl)}">${escapeHtml(runUrl)}</a>`;
  return escapeHtml(line);
 }).join('<br>');
}
function redact(message: string, pat: string) {
 for (const secret of [pat, btoa(`:${pat}`), encodeURIComponent(pat)]) if (secret) message = message.split(secret).join('[credential redacted]');
 return message.slice(0, 1000);
}
async function call(env: Env, url: string, init: { method?: string; data?: unknown; contentType?: string }, fetcher: typeof fetch, allow404 = false): Promise<{ status: number; body: Record<string, unknown> }> {
 if (!env.ADO_PAT) throw new HttpError(503, 'ADO credential is not provisioned on the server');
 if (!ORG_RE.test(url.split('/').slice(0, 4).join('/'))) throw new HttpError(500, 'Refusing to send credentials to a non-ADO host');
 let response: Response;
 try {
  response = await fetcher(url, { method: init.method ?? 'GET', headers: { Authorization: `Basic ${btoa(`:${env.ADO_PAT}`)}`, Accept: 'application/json', ...(init.contentType ? { 'Content-Type': init.contentType } : {}) }, body: init.data === undefined ? undefined : JSON.stringify(init.data), redirect: 'manual', signal: AbortSignal.timeout(10000) });
 } catch { throw new HttpError(502, 'ADO request failed — no response; retry to recover by correlation tag'); }
 let parsed: Record<string, unknown> = {};
 try {
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.length > 256 * 1024) throw new Error();
  const v: unknown = JSON.parse(new TextDecoder().decode(buf));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
  parsed = v as Record<string, unknown>;
 } catch { if (!(allow404 && response.status === 404)) throw new HttpError(502, `ADO returned an invalid response (HTTP ${response.status})`); }
 if (!response.ok && !(allow404 && response.status === 404)) {
  const message = typeof parsed.message === 'string' ? redact(parsed.message, env.ADO_PAT) : 'Request rejected';
  throw new HttpError(502, `ADO request failed (HTTP ${response.status}): ${message}`);
 }
 return { status: response.status, body: parsed };
}
export async function verifyAdo(env: Env, ws: Workspace, adoId: unknown, fetcher: typeof fetch = fetch): Promise<number> {
 if (typeof adoId !== 'number' || !Number.isSafeInteger(adoId) || adoId <= 0) throw new HttpError(400, 'ADO ID must be a positive integer');
 adoConfig(ws);
 const r = await call(env, `${adoProjectUrl(ws)}/_apis/wit/workitems/${adoId}?api-version=7.1`, {}, fetcher, true);
 if (r.status === 404) throw new HttpError(400, 'ADO item not found');
 const fields = r.body.fields as Record<string, unknown> | undefined;
 if (r.body.id !== adoId || fields?.['System.TeamProject'] !== ws.ado_project) throw new HttpError(400, 'ADO item belongs to another project');
 return adoId;
}
function patchFor(ws: Workspace, f: { title: string; repro: string; severity: string; priority: number; tag: string }, runUrl: string) {
 const fields: Record<string, unknown> = {
  'System.Title': f.title, [ws.ado_repro_field || 'Microsoft.VSTS.TCM.ReproSteps']: reproHtml(f.repro, runUrl),
  'System.Tags': [...ws.ado_tags.split(';').map(t => t.trim()).filter(Boolean), f.tag].join('; ')
 };
 if (ws.ado_area_path) fields['System.AreaPath'] = ws.ado_area_path;
 if (ws.ado_severity_field) fields[ws.ado_severity_field] = f.severity;
 if (ws.ado_priority_field) fields[ws.ado_priority_field] = f.priority;
 return Object.entries(fields).map(([k, value]) => ({ op: 'add', path: '/fields/' + k, value }));
}
export async function findOrCreateWorkItem(env: Env, ws: Workspace, tag: string, f: { title: string; repro: string; severity: string; priority: number }, runUrl: string, fetcher: typeof fetch) {
 adoConfig(ws);
 const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS '${tag.replace(/'/g, "''")}'`;
 const found = (await call(env, `${adoProjectUrl(ws)}/_apis/wit/wiql?api-version=7.1`, { method: 'POST', data: { query }, contentType: 'application/json' }, fetcher)).body;
 if (!Array.isArray(found.workItems)) throw new HttpError(502, 'ADO returned invalid WIQL results');
 const ids = found.workItems.map((i: unknown) => i && typeof i === 'object' && 'id' in i ? i.id : undefined);
 if (ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) throw new HttpError(502, 'ADO returned invalid work item IDs');
 if (ids.length > 1) throw new HttpError(502, 'ADO returned multiple matching correlation tags — contact the project administrator');
 if (ids.length === 1) return { adoId: ids[0] as number, recovered: true };
 const created = (await call(env, `${adoProjectUrl(ws)}/_apis/wit/workitems/$${encodeURIComponent(ws.ado_work_item_type)}?api-version=7.1`, { method: 'POST', data: patchFor(ws, { ...f, tag }, runUrl), contentType: 'application/json-patch+json' }, fetcher)).body;
 if (typeof created.id !== 'number' || !Number.isSafeInteger(created.id) || created.id <= 0) throw new HttpError(502, 'ADO returned an invalid created work item ID; retry to recover by correlation tag');
 return { adoId: created.id, recovered: false };
}
// Admin "Test connection": validateOnly never saves a work item.
export async function testAdo(env: Env, ws: Workspace, fetcher: typeof fetch = fetch) {
 adoConfig(ws);
 await call(env, `${adoProjectUrl(ws)}/_apis/wit/workitemtypes/${encodeURIComponent(ws.ado_work_item_type)}?api-version=7.1`, {}, fetcher);
 await call(env, `${adoProjectUrl(ws)}/_apis/wit/workitems/$${encodeURIComponent(ws.ado_work_item_type)}?validateOnly=true&api-version=7.1`, { method: 'POST', data: patchFor(ws, { title: 'Connection test', repro: 'Steps to Reproduce:\nx', severity: '3 - Medium', priority: 2, tag: 'UAT-connection-test' }, ''), contentType: 'application/json-patch+json' }, fetcher);
 return { ok: true };
}
