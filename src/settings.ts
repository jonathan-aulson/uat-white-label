import type { Env, Workspace } from './types';
import { all, HttpError, now, statement } from './db';

export const DEFAULTS: Workspace = {
 project_name: 'UAT Workspace', support_text: '', privacy_notice: 'Use synthetic test data only. Do not enter real personal or confidential information.',
 namespace: 'UAT', links: [], primary: '#1f4e79', accent: '#b45309', background: '#f5f7fa', font: 'system', branding_revision: 0,
 ado_org_url: '', ado_project: '', ado_area_path: '', ado_work_item_type: 'Bug', ado_repro_field: 'Microsoft.VSTS.TCM.ReproSteps', ado_tags: 'UAT',
 ado_severity_field: 'Microsoft.VSTS.Common.Severity', ado_priority_field: 'Microsoft.VSTS.Common.Priority', timezone: 'UTC'
};
export async function getWorkspace(env: Env): Promise<Workspace> {
 const rows = await all<{ key: string; value: string }>(env, 'SELECT key,value FROM settings');
 const w: Record<string, unknown> = { ...DEFAULTS };
 for (const r of rows) { try { w[r.key] = JSON.parse(r.value); } catch { /* ignore corrupt row; default applies */ } }
 return w as unknown as Workspace;
}
export async function putSettings(env: Env, values: Partial<Workspace>) {
 const ts = now();
 await env.DB.batch(Object.entries(values).map(([k, v]) =>
  statement(env, 'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', k, JSON.stringify(v), ts)));
}
export const publicWorkspace = (w: Workspace) => ({
 project_name: w.project_name, support_text: w.support_text, privacy_notice: w.privacy_notice, links: w.links,
 branding_revision: w.branding_revision, namespace: w.namespace
});
export function validateLinks(v: unknown): { label: string; url: string }[] {
 if (!Array.isArray(v) || v.length > 10) throw new HttpError(400, 'links must be a list of at most 10');
 return v.map(l => {
  if (!l || typeof l.label !== 'string' || !l.label.trim() || l.label.length > 60 || typeof l.url !== 'string') throw new HttpError(400, 'Each link needs a label (max 60) and a url');
  let u: URL; try { u = new URL(l.url); } catch { throw new HttpError(400, `Invalid URL: ${l.url.slice(0, 80)}`); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Links must use https://');
  return { label: l.label.trim(), url: u.toString() };
 });
}
