import type { Env, Identity, Workspace } from './types';
import { all, audit, record, body, first, HttpError, json, limitedBytes, now, sha256Hex, statement, text, uuid } from './db';
import { getWorkspace, putSettings, validateLinks, DEFAULTS } from './settings';
import { testAdo, validateAdoSettings } from './ado';
import { checkBranding, HEX_RE, sanitizeImage, ImageError, IMAGE_LIMITS } from './branding';
import { validTimeZone } from './fixtures';
import { PDF_LIMITS, PdfError, safeFilename, validateUploadedPdf } from './pdf';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEXT_SETTINGS: Record<string, number> = { project_name: 80, support_text: 600, privacy_notice: 1200, ado_org_url: 120, ado_project: 64, ado_area_path: 200, ado_work_item_type: 40, ado_repro_field: 80, ado_tags: 200, ado_severity_field: 80, ado_priority_field: 80 };

async function activeAdmins(env: Env) { return (await first<{ n: number }>(env, "SELECT COUNT(*) AS n FROM members WHERE role='admin' AND active=1"))!.n; }

async function members(req: Request, env: Env, user: Identity, path: string): Promise<Response | undefined> {
 if (path === '/members' && req.method === 'GET') return json(await all(env, 'SELECT email,role,display_name,instance,active,added_by,added_at FROM members ORDER BY instance'));
 if (path === '/members' && req.method === 'POST') {
  const b = await body(req);
  const email = text(b.email, 200, true).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address');
  const role = b.role === 'admin' ? 'admin' : 'tester';
  const display = b.display_name === undefined ? '' : text(b.display_name, 80);
  await statement(env, `INSERT INTO members(email,role,display_name,instance,active,added_by,added_at) VALUES(?,?,?,(SELECT COALESCE(MAX(instance),0)+1 FROM members),1,?,?)
   ON CONFLICT(email) DO UPDATE SET role=excluded.role, display_name=CASE WHEN excluded.display_name='' THEN members.display_name ELSE excluded.display_name END, active=1`, email, role, display, user.email, now()).run();
  await record(env, user, 'member-upsert', email, role);
  return json(await first(env, 'SELECT email,role,display_name,instance,active FROM members WHERE email=?', email), 201);
 }
 const m = path.match(/^\/members\/([^/]+)$/);
 if (m && req.method === 'PATCH') {
  const email = decodeURIComponent(m[1]).toLowerCase(); const b = await body(req);
  const cur = await first<{ role: string; active: number }>(env, 'SELECT role,active FROM members WHERE email=?', email);
  if (!cur) throw new HttpError(404, 'Member not found');
  const role = b.role === undefined ? cur.role : (b.role === 'admin' ? 'admin' : 'tester');
  const active = b.active === undefined ? cur.active : (b.active ? 1 : 0);
  if (cur.role === 'admin' && cur.active && (role !== 'admin' || !active) && await activeAdmins(env) <= 1) throw new HttpError(409, 'At least one active administrator is required');
  const display = b.display_name === undefined ? null : text(b.display_name, 80);
  await statement(env, 'UPDATE members SET role=?,active=?,display_name=COALESCE(?,display_name) WHERE email=?', role, active, display, email).run();
  await record(env, user, 'member-update', email, `${role}/${active ? 'active' : 'inactive'}`);
  return json({ ok: true });
 }
}

async function settings(req: Request, env: Env, user: Identity, path: string, fetcher: typeof fetch): Promise<Response | undefined> {
 if (path === '/settings' && req.method === 'GET') {
  const w = await getWorkspace(env);
  return json({ settings: w, ado_pat_configured: !!env.ADO_PAT, documents_enabled: !!env.DOCS, deployment_id: env.DEPLOYMENT_ID, bootstrap_admins: (env.BOOTSTRAP_ADMINS ?? '').split(',').map(s => s.trim()).filter(Boolean) });
 }
 if (path === '/settings' && req.method === 'PUT') {
  const b = await body(req, 32768); const patch: Partial<Workspace> = {};
  for (const [k, max] of Object.entries(TEXT_SETTINGS)) if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = text(b[k], max).trim();
  if (b.project_name !== undefined && !patch.project_name) throw new HttpError(400, 'Product name is required');
  if (b.namespace !== undefined) { const n = text(b.namespace, 20, true).trim(); if (!/^[A-Za-z0-9 ]{1,20}$/.test(n)) throw new HttpError(400, 'Name prefix may contain only letters, digits and spaces'); patch.namespace = n; }
  if (b.timezone !== undefined) { const tz = text(b.timezone, 60, true); if (!validTimeZone(tz)) throw new HttpError(400, 'Unknown time zone'); patch.timezone = tz; }
  if (b.links !== undefined) patch.links = validateLinks(b.links);
  validateAdoSettings(patch);
  await putSettings(env, patch);
  await record(env, user, 'settings-update', 'settings', Object.keys(patch).join(','));
  return json({ ok: true });
 }
 if (path === '/settings/ado-test' && req.method === 'POST') {
  if (!env.ADO_PAT) throw new HttpError(503, 'ADO_PAT secret is not set on this deployment');
  return json(await testAdo(env, await getWorkspace(env), fetcher));
 }
}

const snapshot = (w: Workspace) => JSON.stringify({ primary: w.primary, accent: w.accent, background: w.background, font: w.font });
async function saveBranding(env: Env, user: Identity, patch: Partial<Workspace>) {
 const w = await getWorkspace(env);
 await putSettings(env, { ...patch, branding_revision: w.branding_revision + 1 });
 await statement(env, 'INSERT INTO branding_revisions(ts,actor_sub,snapshot) VALUES(?,?,?)', now(), user.sub, JSON.stringify({ ...JSON.parse(snapshot({ ...w, ...patch })), logo: !!(await first(env, "SELECT 1 AS x FROM assets WHERE kind='logo'")), favicon: !!(await first(env, "SELECT 1 AS x FROM assets WHERE kind='favicon'")) })).run();
}
async function branding(req: Request, env: Env, user: Identity, path: string): Promise<Response | undefined> {
 if (path === '/branding' && req.method === 'GET') {
  const w = await getWorkspace(env);
  return json({ primary: w.primary, accent: w.accent, background: w.background, font: w.font, revision: w.branding_revision, check: checkBranding(w), defaults: { primary: DEFAULTS.primary, accent: DEFAULTS.accent, background: DEFAULTS.background },
   assets: await all(env, 'SELECT kind,mime,width,height,sha256,updated_at FROM assets'), revisions: await all(env, 'SELECT id,ts,actor_sub,snapshot FROM branding_revisions ORDER BY id DESC LIMIT 20') });
 }
 if (path === '/branding/check' && req.method === 'POST') {
  const b = await body(req); return json(checkBranding({ primary: String(b.primary), accent: String(b.accent), background: String(b.background) }));
 }
 if (path === '/branding' && req.method === 'PUT') {
  const b = await body(req);
  for (const k of ['primary', 'accent', 'background']) if (typeof b[k] !== 'string' || !HEX_RE.test(b[k] as string)) throw new HttpError(400, `${k} must be a #rrggbb colour`);
  if (!['system', 'roboto', 'roboto-baskerville'].includes(String(b.font))) throw new HttpError(400, 'Unknown font choice');
  const check = checkBranding({ primary: b.primary as string, accent: b.accent as string, background: b.background as string });
  if (!check.ok) return json({ error: 'These colours do not meet the accessibility contrast minimums', check }, 400);
  await saveBranding(env, user, { primary: (b.primary as string).toLowerCase(), accent: (b.accent as string).toLowerCase(), background: (b.background as string).toLowerCase(), font: b.font as Workspace['font'] });
  await record(env, user, 'branding-update', 'branding');
  return json({ ok: true, check });
 }
 const a = path.match(/^\/branding\/(logo|favicon)$/);
 if (a && req.method === 'PUT') {
  const bytes = await limitedBytes(req, IMAGE_LIMITS.bytes + 1024);
  let img; try { img = sanitizeImage(bytes); } catch (e) { if (e instanceof ImageError) throw new HttpError(400, e.message); throw e; }
  if (a[1] === 'favicon' && img.width !== img.height) throw new HttpError(400, 'The favicon must be square. Export a square image (for example 256×256) and upload it here.');
  await statement(env, 'INSERT INTO assets(kind,mime,bytes,sha256,width,height,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET mime=excluded.mime,bytes=excluded.bytes,sha256=excluded.sha256,width=excluded.width,height=excluded.height,updated_at=excluded.updated_at',
   a[1], img.mime, img.bytes.slice().buffer as ArrayBuffer, await sha256Hex(img.bytes), img.width, img.height, now()).run();
  await saveBranding(env, user, {}); await record(env, user, 'asset-upload', a[1], `${img.width}x${img.height}`);
  return json({ ok: true, width: img.width, height: img.height });
 }
 if (a && req.method === 'DELETE') {
  await statement(env, 'DELETE FROM assets WHERE kind=?', a[1]).run(); await saveBranding(env, user, {}); await record(env, user, 'asset-delete', a[1]);
  return json({ ok: true });
 }
}

async function documents(req: Request, env: Env, user: Identity, path: string): Promise<Response | undefined> {
 if (path === '/documents' && req.method === 'GET') return json({ enabled: !!env.DOCS, limits: PDF_LIMITS, documents: await all(env, 'SELECT id,title,filename,size,sha256,audience,values_note,status,created_by,created_at,revoked_at FROM documents ORDER BY created_at DESC') });
 if (path === '/documents' && req.method === 'POST') {
  if (!env.DOCS) throw new HttpError(503, 'Document storage (R2) is not enabled on this deployment');
  const q = new URL(req.url).searchParams;
  if (q.get('attested') !== '1') throw new HttpError(400, 'You must attest that this document contains only synthetic or generic data');
  const title = text(q.get('title') ?? '', 120, true).trim();
  const audience = (q.get('audience') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const bytes = await limitedBytes(req, PDF_LIMITS.bytes);
  let info; try { info = validateUploadedPdf(bytes); } catch (e) { if (e instanceof PdfError) throw new HttpError(400, e.message); throw e; }
  const id = uuid(), r2Key = `documents/${id}.pdf`, sha = await sha256Hex(bytes);
  await env.DOCS.put(r2Key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  await statement(env, 'INSERT INTO documents(id,title,filename,size,sha256,r2_key,audience,values_note,attested,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)',
   id, title, safeFilename(q.get('filename') ?? `${title}.pdf`), bytes.length, sha, r2Key, JSON.stringify(audience), 'generic', user.email, now()).run();
  await record(env, user, 'document-upload', id, `${sha} pages=${info.pages}`);
  return json({ id, sha256: sha, pages: info.pages }, 201);
 }
 const m = path.match(/^\/documents\/([^/]+)\/(revoke|download)$/);
 if (m) {
  const doc = await first<{ id: string; filename: string; r2_key: string }>(env, 'SELECT id,filename,r2_key FROM documents WHERE id=?', m[1]);
  if (!doc) throw new HttpError(404, 'Document not found');
  if (m[2] === 'revoke' && req.method === 'POST') {
   await statement(env, "UPDATE documents SET status='revoked',revoked_at=? WHERE id=?", now(), doc.id).run(); await record(env, user, 'document-revoke', doc.id);
   return json({ ok: true });
  }
  if (m[2] === 'download' && req.method === 'GET') {
   const obj = await env.DOCS?.get(doc.r2_key); if (!obj) throw new HttpError(404, 'File missing');
   return new Response(obj.body, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${doc.filename.replace(/"/g, '')}"` } });
  }
 }
}

export async function adminConfigApi(req: Request, env: Env, user: Identity, path: string, fetcher: typeof fetch) {
 return await members(req, env, user, path) ?? await settings(req, env, user, path, fetcher) ?? await branding(req, env, user, path) ?? await documents(req, env, user, path);
}
