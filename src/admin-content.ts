import type { CampaignRow, Content, Env, Identity, ReleaseRow } from './types';
import { all, audit, record, body, first, HttpError, json, limitedBytes, now, sha256Hex, statement, text, uuid } from './db';
import { canonicalize, diffContent, statusesOf, validateContent, type DocInfo } from './content';
import { EXAMPLES } from './examples';
import { csvToContent } from './csvimport';
import { addDays, evalFields, formatDate, phaseDatesOf, todayIn, validTimeZone, type EvalCtx } from './fixtures';
import { loadCampaign, loadRelease } from './release';
import { getWorkspace } from './settings';

const MAX_CONTENT = 400_000;
async function docMap(env: Env) {
 return new Map((await all<DocInfo>(env, 'SELECT id,sha256,status FROM documents')).map(d => [d.id, d]));
}
const summary = (r: ReleaseRow) => ({ id: r.id, seq: r.seq, label: r.label, status: r.status, content_sha: r.content_sha, base_release_id: r.base_release_id, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, published_at: r.published_at });

// Sample rendering with instance 1 and "today" as anchor: lets the author see real values before publishing.
export function previewContent(content: Content, role: string, namespace: string, tz: string) {
 const today = todayIn(tz);
 const phaseDates = Object.fromEntries((content.phases ?? []).map(p => [p.key, addDays(today, p.offsetDays)]));
 const values = new Map<string, string>(); const fixtures: { key: string; label: string; scope: string; fields: { label: string; value: string }[] }[] = [];
 for (const fx of content.fixtures ?? []) {
  const ctx: EvalCtx = { instance: 1, namespace, anchorDate: today, campaignStart: today, phaseDates, seed: `preview|${fx.key}` };
  let vals: Record<string, string> = {};
  try { vals = evalFields(fx, ctx, () => true); } catch (e) { vals = { error: (e as Error).message }; }
  for (const [k, v] of Object.entries(vals)) values.set(`${fx.key}.${k}`, v);
  fixtures.push({ key: fx.key, label: fx.label, scope: fx.scope, fields: fx.fields.map(f => ({ label: f.label, value: vals[f.key] ?? '' })) });
 }
 for (const fx of content.fixtures ?? []) for (const c of fx.captures ?? []) values.set(`${fx.key}.${c.key}`, `‹${c.label}›`);
 const render = (s: string) => s.replace(/\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, f, k) => values.get(`${f}.${k}`) ?? `[${f}.${k}?]`);
 const scenarios = content.scenarios.map(sc => ({ id: sc.id, title: sc.title, goal: sc.goal, before: sc.before ? render(sc.before) : undefined,
  steps: sc.steps.filter(s => !role || s.roles.includes(role)).map(s => ({ id: s.id, text: render(s.text), expect: render(s.expect), phase: s.phase, requires: s.requires })) })).filter(s => s.steps.length);
 return { role, fixtures, scenarios, statuses: statusesOf(content), phaseDates };
}
void formatDate;

async function releases(req: Request, env: Env, user: Identity, path: string): Promise<Response | undefined> {
 if (path === '/examples' && req.method === 'GET') return json(Object.entries(EXAMPLES).map(([key, e]) => ({ key, label: e.label })));
 if (path === '/releases' && req.method === 'GET') return json(await all<ReleaseRow>(env, 'SELECT * FROM releases ORDER BY COALESCE(seq,1e9) DESC, created_at DESC').then(rs => rs.map(summary)));
 if (path === '/releases' && req.method === 'POST') {
  const b = await body(req, MAX_CONTENT + 4096);
  const label = text(b.label ?? 'Draft', 80, true).trim();
  let content: unknown, base: string | null = null;
  if (typeof b.from === 'string' && EXAMPLES[b.from]) content = EXAMPLES[b.from].content;
  else if (typeof b.from === 'string' && b.from) { const src = await loadRelease(env, b.from); content = src.content; base = src.row.id; }
  else if (typeof b.csv === 'string') content = csvToContent(b.csv, text(b.title ?? label, 120));
  else if (b.content && typeof b.content === 'object') content = b.content;
  else throw new HttpError(400, 'Provide from (example key or release id), content or csv');
  const serial = JSON.stringify(content);
  if (serial.length > MAX_CONTENT) throw new HttpError(400, 'Content is too large');
  const id = uuid(), ts = now();
  await statement(env, "INSERT INTO releases(id,label,status,content,base_release_id,created_by,created_at,updated_at) VALUES(?,?,'draft',?,?,?,?,?)", id, label, serial, base, user.email, ts, ts).run();
  await record(env, user, 'release-create', id, label);
  const { issues } = validateContent(content, await docMap(env));
  return json({ id, issues }, 201);
 }
 const m = path.match(/^\/releases\/([^/]+)(?:\/(validate|publish|retire|export|preview|diff))?$/);
 if (!m) return;
 const { row, content } = await loadRelease(env, m[1]); const sub = m[2];
 if (!sub && req.method === 'GET') return json({ ...summary(row), content, issues: validateContent(content, await docMap(env)).issues });
 if (!sub && req.method === 'PUT') {
  if (row.status !== 'draft') throw new HttpError(409, 'Published releases are immutable. Clone it to a new draft to make changes.');
  const b = await body(req, MAX_CONTENT + 4096);
  const label = b.label === undefined ? row.label : text(b.label, 80, true).trim();
  const serial = b.content === undefined ? row.content : JSON.stringify(b.content);
  if (serial.length > MAX_CONTENT) throw new HttpError(400, 'Content is too large');
  await statement(env, "UPDATE releases SET label=?,content=?,updated_at=? WHERE id=? AND status='draft'", label, serial, now(), row.id).run();
  return json({ ok: true, issues: validateContent(JSON.parse(serial), await docMap(env)).issues });
 }
 if (!sub && req.method === 'DELETE') {
  if (row.status !== 'draft') throw new HttpError(409, 'Only drafts can be deleted');
  if (await first(env, 'SELECT 1 AS x FROM campaigns WHERE release_id=?', row.id)) throw new HttpError(409, 'A campaign uses this release');
  await statement(env, "DELETE FROM releases WHERE id=? AND status='draft'", row.id).run(); await record(env, user, 'release-delete', row.id);
  return json({ ok: true });
 }
 if (sub === 'validate' && req.method === 'POST') return json({ issues: validateContent(content, await docMap(env)).issues });
 if (sub === 'export' && req.method === 'GET') return new Response(JSON.stringify(content, null, 1), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="release-${row.seq ?? 'draft'}.json"` } });
 if (sub === 'preview' && req.method === 'GET') {
  const ws = await getWorkspace(env);
  return json(previewContent(content, new URL(req.url).searchParams.get('role') ?? content.roles[0]?.key ?? '', ws.namespace, ws.timezone));
 }
 if (sub === 'diff' && req.method === 'GET') {
  const against = new URL(req.url).searchParams.get('against') ?? row.base_release_id;
  const other = against ? await loadRelease(env, against) : null;
  return json({ against: other?.row.label ?? null, diff: diffContent(other?.content ?? null, content) });
 }
 if (sub === 'publish' && req.method === 'POST') {
  if (row.status !== 'draft') throw new HttpError(409, 'Release is already published');
  const { issues, content: clean } = validateContent(content, await docMap(env));
  if (!clean || issues.some(i => i.level === 'error')) return json({ error: 'Fix the validation errors before publishing', issues }, 400);
  // Re-write from the validated, canonical form so what is hashed is exactly what is served.
  const serial = canonicalize(clean), sha = await sha256Hex(serial), ts = now();
  const r = await statement(env, `UPDATE releases SET content=?,content_sha=?,seq=(SELECT COALESCE(MAX(seq),0)+1 FROM releases),status='published',published_by=?,published_at=?,updated_at=? WHERE id=? AND status='draft'`, serial, sha, user.email, ts, ts, row.id).run();
  if (r.meta.changes !== 1) throw new HttpError(409, 'Release changed — reload and retry');
  await record(env, user, 'release-publish', row.id, sha);
  const after = await first<ReleaseRow>(env, 'SELECT * FROM releases WHERE id=?', row.id);
  return json({ ok: true, seq: after!.seq, content_sha: sha, warnings: issues });
 }
 if (sub === 'retire' && req.method === 'POST') {
  if (row.status !== 'published') throw new HttpError(409, 'Only published releases can be retired');
  await statement(env, "UPDATE releases SET status='retired',updated_at=? WHERE id=?", now(), row.id).run(); await record(env, user, 'release-retire', row.id);
  return json({ ok: true });
 }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function phaseDatesFor(content: Content, startsOn: string) { return Object.fromEntries((content.phases ?? []).map(p => [p.key, addDays(startsOn, p.offsetDays)])); }
async function campaignDetail(env: Env, c: CampaignRow) {
 const { content, row } = await loadRelease(env, c.release_id);
 return {
  ...c, phase_dates: phaseDatesOf(c), release: { id: row.id, seq: row.seq, label: row.label }, roles: content.roles, handoff_defs: content.handoffs ?? [],
  invites: (await all<{ email: string; roles: string }>(env, 'SELECT i.email,i.roles,m.display_name,m.instance,m.active FROM campaign_invites i JOIN members m USING(email) WHERE campaign_id=? ORDER BY m.instance', c.id)).map(i => ({ ...i, roles: JSON.parse(i.roles) })),
  handoffs: await all(env, 'SELECT id,handoff_key,producer_email,consumer_email,status,ready_at,ack_at,record_ref,(SELECT COUNT(*) FROM handoff_overrides o WHERE o.handoff_id=handoffs.id) AS overrides FROM handoffs WHERE campaign_id=?', c.id)
 };
}
async function campaigns(req: Request, env: Env, user: Identity, path: string): Promise<Response | undefined> {
 if (path === '/campaigns' && req.method === 'GET') return json(await all(env, `SELECT c.*,r.seq AS release_seq,r.label AS release_label,(SELECT COUNT(*) FROM campaign_invites i WHERE i.campaign_id=c.id) AS invitees,(SELECT COUNT(*) FROM runs u WHERE u.campaign_id=c.id AND u.archived=0) AS runs FROM campaigns c JOIN releases r ON r.id=c.release_id ORDER BY c.created_at DESC`));
 if (path === '/campaigns' && req.method === 'POST') {
  const b = await body(req); const ws = await getWorkspace(env);
  const rel = await loadRelease(env, text(b.release_id, 60, true));
  if (rel.row.status !== 'published') throw new HttpError(400, 'Choose a published release');
  const startsOn = typeof b.starts_on === 'string' && DATE_RE.test(b.starts_on) ? b.starts_on : todayIn(ws.timezone);
  const tz = b.tz === undefined ? ws.timezone : text(b.tz, 60, true); if (!validTimeZone(tz)) throw new HttpError(400, 'Unknown time zone');
  const id = uuid();
  await statement(env, 'INSERT INTO campaigns(id,name,environment,build,release_id,starts_on,ends_on,tz,phase_dates,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
   id, text(b.name, 100, true).trim(), text(b.environment ?? '', 200), text(b.build ?? '', 100), rel.row.id, startsOn, typeof b.ends_on === 'string' && DATE_RE.test(b.ends_on) ? b.ends_on : null, tz, JSON.stringify(phaseDatesFor(rel.content, startsOn)), text(b.notes ?? '', 1000), user.email, now()).run();
  await record(env, user, 'campaign-create', id);
  return json({ id }, 201);
 }
 const m = path.match(/^\/campaigns\/([^/]+)(?:\/(close|reopen|invites|handoffs|purge))?$/);
 if (!m) return;
 const c = await loadCampaign(env, m[1]); const sub = m[2];
 if (!sub && req.method === 'GET') return json(await campaignDetail(env, c));
 if (!sub && req.method === 'PUT') {
  const b = await body(req);
  const hasRuns = !!(await first(env, 'SELECT 1 AS x FROM runs WHERE campaign_id=?', c.id));
  let { release_id: releaseId, starts_on: startsOn, tz } = c; let phaseDates = c.phase_dates;
  if (typeof b.release_id === 'string' && b.release_id !== c.release_id) {
   const rel = await loadRelease(env, b.release_id); if (rel.row.status !== 'published') throw new HttpError(400, 'Choose a published release');
   releaseId = rel.row.id; phaseDates = JSON.stringify({ ...phaseDatesFor(rel.content, startsOn), ...JSON.parse(c.phase_dates) }); // existing runs stay pinned to their own release, so their phase dates are kept
  }
  if (typeof b.starts_on === 'string' && b.starts_on !== c.starts_on) {
   if (hasRuns) throw new HttpError(409, 'Start date cannot change after testers have started: their fixture dates are already frozen');
   if (!DATE_RE.test(b.starts_on)) throw new HttpError(400, 'Invalid start date'); startsOn = b.starts_on;
   phaseDates = JSON.stringify(phaseDatesFor((await loadRelease(env, releaseId)).content, startsOn));
  }
  if (typeof b.tz === 'string' && b.tz !== c.tz) { if (hasRuns) throw new HttpError(409, 'Time zone cannot change after testers have started'); if (!validTimeZone(b.tz)) throw new HttpError(400, 'Unknown time zone'); tz = b.tz; }
  await statement(env, 'UPDATE campaigns SET name=?,environment=?,build=?,notes=?,ends_on=?,release_id=?,starts_on=?,tz=?,phase_dates=? WHERE id=?',
   b.name === undefined ? c.name : text(b.name, 100, true).trim(), b.environment === undefined ? c.environment : text(b.environment, 200), b.build === undefined ? c.build : text(b.build, 100),
   b.notes === undefined ? c.notes : text(b.notes, 1000), b.ends_on === undefined ? c.ends_on : (typeof b.ends_on === 'string' && DATE_RE.test(b.ends_on) ? b.ends_on : null), releaseId, startsOn, tz, phaseDates, c.id).run();
  await record(env, user, 'campaign-update', c.id); return json({ ok: true });
 }
 if ((sub === 'close' || sub === 'reopen') && req.method === 'POST') {
  await statement(env, 'UPDATE campaigns SET status=?,closed_at=? WHERE id=?', sub === 'close' ? 'closed' : 'open', sub === 'close' ? now() : null, c.id).run();
  await record(env, user, `campaign-${sub}`, c.id); return json({ ok: true });
 }
 if (sub === 'invites' && req.method === 'PUT') {
  const b = await body(req, 65536); const { content } = await loadRelease(env, c.release_id);
  if (!Array.isArray(b.invites) || b.invites.length > 500) throw new HttpError(400, 'invites must be a list of at most 500');
  const roleKeys = new Set(content.roles.map(r => r.key)); const keep: string[] = []; const stmts = [];
  for (const i of b.invites as { email?: unknown; roles?: unknown }[]) {
   const email = text(i?.email, 200, true).trim().toLowerCase();
   const m2 = await first<{ active: number }>(env, 'SELECT active FROM members WHERE email=?', email);
   if (!m2?.active) throw new HttpError(400, `${email} is not an active member. Add them to the roster first.`);
   if (!Array.isArray(i.roles) || !i.roles.length || i.roles.some(r => typeof r !== 'string' || !roleKeys.has(r))) throw new HttpError(400, `Choose at least one valid role for ${email}`);
   keep.push(email);
   stmts.push(statement(env, 'INSERT INTO campaign_invites(campaign_id,email,roles,invited_at) VALUES(?,?,?,?) ON CONFLICT(campaign_id,email) DO UPDATE SET roles=excluded.roles', c.id, email, JSON.stringify(i.roles), now()));
  }
  // Invitees with existing runs are never removed (their data would be orphaned); revoke by deactivating the member.
  const existing = await all<{ email: string }>(env, 'SELECT email FROM campaign_invites WHERE campaign_id=?', c.id);
  for (const e of existing) if (!keep.includes(e.email) && !(await first(env, 'SELECT 1 AS x FROM runs WHERE campaign_id=? AND owner_email=?', c.id, e.email))) stmts.push(statement(env, 'DELETE FROM campaign_invites WHERE campaign_id=? AND email=?', c.id, e.email));
  if (stmts.length) await env.DB.batch(stmts);
  await record(env, user, 'campaign-invites', c.id, String(keep.length)); return json({ ok: true });
 }
 if (sub === 'handoffs' && req.method === 'PUT') {
  const b = await body(req, 65536); const { content } = await loadRelease(env, c.release_id);
  if (!Array.isArray(b.bindings)) throw new HttpError(400, 'bindings must be a list');
  const keys = new Set((content.handoffs ?? []).map(h => h.key)); const wanted = new Set<string>(); const stmts = [];
  const invited = new Set((await all<{ email: string }>(env, 'SELECT email FROM campaign_invites WHERE campaign_id=?', c.id)).map(r => r.email));
  for (const bd of b.bindings as { key?: unknown; producer?: unknown; consumers?: unknown }[]) {
   if (typeof bd.key !== 'string' || !keys.has(bd.key)) throw new HttpError(400, 'Unknown handoff');
   const producer = text(bd.producer, 200, true).toLowerCase();
   if (!Array.isArray(bd.consumers) || !bd.consumers.length) throw new HttpError(400, 'Each handoff needs at least one consumer');
   for (const consumer of bd.consumers.map(x => text(x, 200, true).toLowerCase())) {
    if (!invited.has(producer) || !invited.has(consumer)) throw new HttpError(400, 'Producer and consumers must be invited to this campaign first');
    if (producer === consumer) throw new HttpError(400, 'Producer and consumer must be different people');
    wanted.add(`${bd.key}|${consumer}`);
    const cur = await first<{ producer_email: string }>(env, 'SELECT producer_email FROM handoffs WHERE campaign_id=? AND handoff_key=? AND consumer_email=?', c.id, bd.key, consumer);
    if (cur && cur.producer_email !== producer) {
     if (await first(env, "SELECT 1 AS x FROM handoffs WHERE campaign_id=? AND handoff_key=? AND consumer_email=? AND status!='pending'", c.id, bd.key, consumer)) throw new HttpError(409, 'This handoff has progressed; its producer can no longer change');
     stmts.push(statement(env, 'UPDATE handoffs SET producer_email=? WHERE campaign_id=? AND handoff_key=? AND consumer_email=?', producer, c.id, bd.key, consumer));
    } else if (!cur) stmts.push(statement(env, 'INSERT INTO handoffs(id,campaign_id,handoff_key,producer_email,consumer_email) VALUES(?,?,?,?,?)', uuid(), c.id, bd.key, producer, consumer));
   }
  }
  for (const h of await all<{ id: string; handoff_key: string; consumer_email: string; status: string }>(env, 'SELECT id,handoff_key,consumer_email,status FROM handoffs WHERE campaign_id=?', c.id))
   if (!wanted.has(`${h.handoff_key}|${h.consumer_email}`) && h.status === 'pending' && !(await first(env, 'SELECT 1 AS x FROM handoff_overrides WHERE handoff_id=?', h.id))) stmts.push(statement(env, 'DELETE FROM handoffs WHERE id=?', h.id));
  if (stmts.length) await env.DB.batch(stmts);
  await record(env, user, 'campaign-handoffs', c.id); return json({ ok: true });
 }
 if (sub === 'purge' && req.method === 'POST') {
  const b = await body(req);
  if (c.status !== 'closed') throw new HttpError(409, 'Close the campaign before purging its tester data');
  if (b.confirm !== c.name) throw new HttpError(400, 'Type the campaign name to confirm');
  const runs = '(SELECT id FROM runs WHERE campaign_id=?)';
  await env.DB.batch([
   statement(env, `DELETE FROM result_history WHERE run_id IN ${runs}`, c.id), statement(env, `DELETE FROM results WHERE run_id IN ${runs}`, c.id), statement(env, `DELETE FROM feedback WHERE run_id IN ${runs}`, c.id),
   statement(env, 'DELETE FROM handoff_overrides WHERE handoff_id IN (SELECT id FROM handoffs WHERE campaign_id=?)', c.id), statement(env, 'DELETE FROM handoffs WHERE campaign_id=?', c.id),
   statement(env, 'DELETE FROM fixture_snapshots WHERE campaign_id=?', c.id), statement(env, 'DELETE FROM generated_documents WHERE campaign_id=?', c.id),
   statement(env, 'DELETE FROM runs WHERE campaign_id=?', c.id), statement(env, 'DELETE FROM campaign_invites WHERE campaign_id=?', c.id)
  ]);
  await record(env, user, 'campaign-purge', c.id, c.name); return json({ ok: true });
 }
}

async function handoffAdmin(req: Request, env: Env, user: Identity, path: string): Promise<Response | undefined> {
 const m = path.match(/^\/handoffs\/([^/]+)\/(override|reset)$/);
 if (!m || req.method !== 'POST') return;
 const h = await first<{ id: string; campaign_id: string }>(env, 'SELECT id,campaign_id FROM handoffs WHERE id=?', m[1]);
 if (!h) throw new HttpError(404, 'Handoff not found');
 if (m[2] === 'override') {
  const b = await body(req); const reason = text(b.reason, 500, true).trim();
  await statement(env, 'INSERT INTO handoff_overrides(handoff_id,actor_email,reason,ts) VALUES(?,?,?,?)', h.id, user.email, reason, now()).run();
  await record(env, user, 'handoff-override', h.id, reason); return json({ ok: true });
 }
 await statement(env, "UPDATE handoffs SET status='pending',ready_at=NULL,ack_at=NULL,record_ref='' WHERE id=?", h.id).run();
 await record(env, user, 'handoff-reset', h.id); return json({ ok: true });
}

export async function adminContentApi(req: Request, env: Env, user: Identity, path: string) {
 return await releases(req, env, user, path) ?? await campaigns(req, env, user, path) ?? await handoffAdmin(req, env, user, path);
}
void limitedBytes;
