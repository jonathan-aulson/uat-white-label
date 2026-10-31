import type { CampaignRow, Content, Env, Identity, ResultRow, Run } from './types';
import { all, audit, record, body, first, HttpError, json, now, statement, text } from './db';
import { assignedSteps, statusesOf } from './content';
import { adoWorkItemUrl, ADMIN_REQUIRED, correlationTag, findOrCreateWorkItem, MAX_REPRO_LENGTH, SEVERITIES, validateRepro, verifyAdo } from './ado';
import { loadCampaign, loadRelease } from './release';
import { getWorkspace } from './settings';
import { csv } from './csv';
import { getRun, runPayload } from './api-tester';

export const TRIAGE = ['New', 'Accepted', 'Duplicate', 'Not a defect', 'Fixed - retest', 'Closed'];

async function progress(env: Env, c: CampaignRow) {
 const invites = await all<{ email: string; roles: string; display_name: string; instance: number }>(env, 'SELECT i.email,i.roles,m.display_name,m.instance FROM campaign_invites i JOIN members m USING(email) WHERE campaign_id=? ORDER BY m.instance', c.id);
 const runs = await all<Run>(env, 'SELECT * FROM runs WHERE campaign_id=? AND archived=0', c.id);
 const results = await all<{ run_id: string; step_id: string; status: string | null; updated_at: string }>(env, 'SELECT run_id,step_id,status,updated_at FROM results WHERE run_id IN (SELECT id FROM runs WHERE campaign_id=? AND archived=0)', c.id);
 const rows: Record<string, unknown>[] = [];
 for (const inv of invites) for (const role of JSON.parse(inv.roles) as string[]) {
  const run = runs.find(r => r.owner_email === inv.email && r.role === role);
  const base = { email: inv.email, name: inv.display_name || inv.email, instance: inv.instance, role };
  if (!run) { rows.push({ ...base, run_id: null, total: null, recorded: 0, passing: 0, issues: 0, blocked: 0, last_activity: null }); continue; }
  const { content } = await loadRelease(env, run.release_id); const kinds = new Map(statusesOf(content).map(s => [s.key, s.kind]));
  const mine = results.filter(r => r.run_id === run.id && r.status);
  rows.push({ ...base, run_id: run.id, total: assignedSteps(content, role).length, recorded: mine.length, passing: mine.filter(r => kinds.get(r.status!) === 'pass').length,
   issues: mine.filter(r => kinds.get(r.status!) === 'fail').length, blocked: mine.filter(r => kinds.get(r.status!) === 'blocked').length, last_activity: mine.map(r => r.updated_at).sort().pop() ?? run.created_at });
 }
 return rows;
}

interface Finding { kind: 'result' | 'feedback'; id: string; run_id: string; step_id: string; scenario: string; step_text: string; owner_email: string; role: string; campaign_id: string; campaign: string; status: string; status_kind: string; note: string; triage: string; ado_id: number | null; ado_url: string | null; admin_note: string; redacted: number; at: string }
async function findings(env: Env, campaign: string | null, all_: boolean): Promise<Finding[]> {
 const ws = await getWorkspace(env); const out: Finding[] = []; const contentCache = new Map<string, Content>();
 const content = async (id: string) => { if (!contentCache.has(id)) contentCache.set(id, (await loadRelease(env, id)).content); return contentCache.get(id)!; };
 const rs = await all<ResultRow & Run & { cname: string }>(env, `SELECT r.*,u.owner_email,u.role,u.campaign_id,u.release_id,c.name AS cname FROM results r JOIN runs u ON u.id=r.run_id JOIN campaigns c ON c.id=u.campaign_id WHERE r.status IS NOT NULL AND u.archived=0 ${campaign ? 'AND u.campaign_id=?' : ''} ORDER BY r.updated_at DESC LIMIT 1000`, ...(campaign ? [campaign] : []));
 for (const r of rs) {
  const cont = await content(r.release_id); const st = statusesOf(cont).find(s => s.key === r.status);
  if (!all_ && (!st || st.kind === 'pass')) continue;
  const sc = cont.scenarios.find(s => s.steps.some(x => x.id === r.step_id)); const step = sc?.steps.find(x => x.id === r.step_id);
  out.push({ kind: 'result', id: `${r.run_id}~${r.step_id}`, run_id: r.run_id, step_id: r.step_id, scenario: sc?.title ?? '', step_text: step?.text ?? '', owner_email: r.owner_email, role: r.role, campaign_id: r.campaign_id, campaign: r.cname, status: st?.label ?? r.status!, status_kind: st?.kind ?? 'info', note: r.redacted ? '[redacted by administrator]' : r.note, triage: r.triage, ado_id: r.ado_id, ado_url: r.ado_id ? adoWorkItemUrl(ws, r.ado_id) : null, admin_note: r.admin_note, redacted: r.redacted, at: r.updated_at });
 }
 const fs = await all<{ id: string; run_id: string; text: string; created_at: string; triage: string; ado_id: number | null; admin_note: string; redacted: number; owner_email: string; role: string; campaign_id: string; cname: string }>(env, `SELECT f.*,u.owner_email,u.role,u.campaign_id,c.name AS cname FROM feedback f JOIN runs u ON u.id=f.run_id JOIN campaigns c ON c.id=u.campaign_id ${campaign ? 'WHERE u.campaign_id=?' : ''} ORDER BY f.created_at DESC LIMIT 500`, ...(campaign ? [campaign] : []));
 for (const f of fs) out.push({ kind: 'feedback', id: f.id, run_id: f.run_id, step_id: '', scenario: 'General feedback', step_text: '', owner_email: f.owner_email, role: f.role, campaign_id: f.campaign_id, campaign: f.cname, status: 'Feedback', status_kind: 'info', note: f.redacted ? '[redacted by administrator]' : f.text, triage: f.triage, ado_id: f.ado_id, ado_url: f.ado_id ? adoWorkItemUrl(ws, f.ado_id) : null, admin_note: f.admin_note, redacted: f.redacted, at: f.created_at });
 return out;
}

async function target(env: Env, kind: string, id: string) {
 if (kind === 'result') {
  const [runId, stepId] = id.split('~'); const row = await first<ResultRow>(env, 'SELECT * FROM results WHERE run_id=? AND step_id=?', runId ?? '', stepId ?? '');
  if (!row) throw new HttpError(404, 'Finding not found');
  return { table: 'results' as const, where: 'run_id=? AND step_id=?', args: [runId, stepId], runId, row };
 }
 if (kind === 'feedback') {
  const row = await first<{ run_id: string; ado_id: number | null; redacted: number; text: string; ado_claim_at: string | null }>(env, 'SELECT * FROM feedback WHERE id=?', id);
  if (!row) throw new HttpError(404, 'Finding not found');
  return { table: 'feedback' as const, where: 'id=?', args: [id], runId: row.run_id, row };
 }
 throw new HttpError(404, 'Finding not found');
}
const runUrl = (req: Request, runId: string) => `${new URL(req.url).origin}/admin#run=${encodeURIComponent(runId)}`;

async function preview(req: Request, env: Env, kind: string, id: string) {
 const t = await target(env, kind, id); const run = await first<Run>(env, 'SELECT * FROM runs WHERE id=?', t.runId); if (!run) throw new HttpError(404, 'Run not found');
 if (t.row.redacted) throw new HttpError(409, 'This finding has been redacted and cannot be exported');
 const [{ content, row: rel }, camp, ws] = await Promise.all([loadRelease(env, run.release_id), loadCampaign(env, run.campaign_id), getWorkspace(env)]);
 // Resolve the tester's real frozen values so the repro steps show exactly what they were told to enter.
 const payload = await runPayload(env, run, true);
 const { valueMap, renderTokens } = await import('./fixtures'); const values = valueMap(payload.fixtures);
 const stepId = 'step_id' in t.row ? t.row.step_id : 'Feedback';
 const sc = content.scenarios.find(s => s.steps.some(x => x.id === stepId)); const step = sc?.steps.find(x => x.id === stepId);
 const obs = 'note' in t.row ? t.row.note : t.row.text;
 const r = (s: string) => renderTokens(s, values).text;
 const role = content.roles.find(x => x.key === run.role)?.label ?? run.role;
 const assigned = content.scenarios.flatMap(scenario => scenario.steps.filter(s => s.roles.includes(run.role)).map(s => ({ scenario, step: s })));
 const issueIndex = assigned.findIndex(s => s.step.id === stepId);
 if (kind === 'result' && issueIndex < 0) throw new HttpError(409, 'Finding step is not in this run’s pinned release and role');
 const results = new Map(payload.results.map(result => [result.step_id, result]));
 const statuses = new Map(statusesOf(content).map(status => [status.key, status.label]));
 const history = step ? assigned.slice(0, issueIndex + 1) : assigned.filter(s => results.get(s.step.id)?.status);
 const script = history.map(({ scenario, step: s }, index) => {
  const result = results.get(s.id);
  const status = result?.status ? statuses.get(result.status) ?? result.status : 'Not recorded';
  return [
   `${index + 1}. [${scenario.id} / ${s.id}] ${r(scenario.title)}`,
   ...(scenario.before ? [`Scenario prerequisites: ${r(scenario.before)}`] : []),
   r(s.text),
   `Expected at this step: ${r(s.expect)}`,
   `Recorded status: ${status}`,
   ...(s.docs?.length ? [`Documents: ${s.docs.map(key => content.documents?.find(d => d.key === key)?.title ?? key).join(', ')}`] : [])
  ].join('\n');
 }).join('\n\n');
 const context = step
  ? 'Ordered test script for this role through the issue step. Recorded statuses are shown; this is not a chronological execution log. Fixture values are the saved values currently available for this run.'
  : `${ADMIN_REQUIRED} describe the exact actions that reproduce this general feedback.]\nRecorded role-specific script steps below are context only, not a proven causal sequence. Fixture values are the saved values currently available for this run.`;
 const sections: [string, string][] = [
  ['Steps to Reproduce', `${context}\n\n${script || 'No steps have a recorded status.'}`],
  ['Expected Result', step?.expect.trim() ? r(step.expect) : `${ADMIN_REQUIRED} describe the expected behavior.]`],
  ['Actual Result', obs.trim() || `${ADMIN_REQUIRED} describe what actually happened.]`],
  ['Step ID', stepId], ['Scenario', sc?.title ?? 'General feedback'], ['Role', role], ['Campaign', camp.name], ['Environment', run.environment || camp.environment], ['Build', run.build || camp.build],
  ['Release', rel.label], ['Portal reference', `UAT-${kind}-${id}`], ['Admin run view', runUrl(req, run.id)]
 ];
 const repro = sections.map(([h, v]) => `${h}:\n${v}`).join('\n\n');
 if (repro.length > MAX_REPRO_LENGTH) throw new HttpError(400, `The complete test script exceeds ${MAX_REPRO_LENGTH.toLocaleString('en-US')} characters. Link an existing bug or prepare a shorter reproduction manually; no steps have been truncated.`);
 return { title: `UAT [${stepId}] ${sc?.title ?? 'General feedback'} – ${obs.trim().slice(0, 80)}`.slice(0, 255), repro, severity: '3 - Medium', priority: 2, correlationTag: await correlationTag(kind, id), configured: !!(env.ADO_PAT && ws.ado_org_url && ws.ado_project) };
}

async function createAdo(req: Request, env: Env, user: Identity, kind: string, id: string, fetcher: typeof fetch) {
 const t = await target(env, kind, id); const ws = await getWorkspace(env); const b = await body(req, 256 * 1024);
 const title = text(b.title, 255, true).trim(), repro = text(b.repro, MAX_REPRO_LENGTH);
 if (b.confirmNoPhi !== true) throw new HttpError(400, 'Confirm this contains no real personal, client or confidential information');
 validateRepro(repro);
 const severity = text(b.severity, 30); if (!SEVERITIES.includes(severity)) throw new HttpError(400, 'Invalid severity');
 if (typeof b.priority !== 'number' || !Number.isInteger(b.priority) || b.priority < 1 || b.priority > 4) throw new HttpError(400, 'Priority must be 1–4');
 if (t.row.redacted) throw new HttpError(409, 'This finding has been redacted and cannot be exported');
 if (t.row.ado_id !== null) return json({ ado_id: t.row.ado_id, ado_url: adoWorkItemUrl(ws, t.row.ado_id) });
 if (!env.ADO_PAT) throw new HttpError(503, 'ADO is not configured (ADO_PAT secret missing)');
 const claim = now(), expired = new Date(Date.now() - 120000).toISOString();
 const claimed = await statement(env, `UPDATE ${t.table} SET ado_claim_at=? WHERE ${t.where} AND ado_id IS NULL AND (ado_claim_at IS NULL OR ado_claim_at < ?)`, claim, ...t.args as string[], expired).run();
 if (claimed.meta.changes !== 1) {
  const latest = await first<{ ado_id: number | null }>(env, `SELECT ado_id FROM ${t.table} WHERE ${t.where}`, ...t.args as string[]);
  if (latest?.ado_id) return json({ ado_id: latest.ado_id, ado_url: adoWorkItemUrl(ws, latest.ado_id) });
  throw new HttpError(409, 'ADO creation already in progress — retry shortly');
 }
 try {
  const tag = await correlationTag(kind, id);
  const result = await findOrCreateWorkItem(env, ws, tag, { title, repro, severity, priority: b.priority }, runUrl(req, t.runId), fetcher);
  const saved = await env.DB.batch([
   statement(env, `UPDATE ${t.table} SET ado_id=?,ado_claim_at=NULL,triage=CASE WHEN triage='New' THEN 'Accepted' ELSE triage END,triaged_by=?,triaged_at=? WHERE ${t.where} AND ado_claim_at=? AND ado_id IS NULL`, result.adoId, user.sub, now(), ...t.args as string[], claim),
   statement(env, 'INSERT INTO audit(ts,actor_sub,action,target,detail) SELECT ?,?,?,?,? WHERE changes()=1', now(), user.sub, result.recovered ? 'link-ado' : 'create-ado', `${kind}:${id}`, String(result.adoId))
  ]);
  if (saved[0].meta.changes !== 1) throw new HttpError(409, 'ADO claim changed — retry to recover the existing item');
  return json({ ado_id: result.adoId, ado_url: adoWorkItemUrl(ws, result.adoId), recovered: result.recovered });
 } finally {
  // Fenced by our claim timestamp so a late response cannot clear a newer claimant's lease.
  await statement(env, `UPDATE ${t.table} SET ado_claim_at=NULL WHERE ${t.where} AND ado_claim_at=?`, ...t.args as string[], claim).run();
 }
}

export async function adminFindingsApi(req: Request, env: Env, user: Identity, path: string, fetcher: typeof fetch): Promise<Response | undefined> {
 const q = new URL(req.url).searchParams;
 let m = path.match(/^\/campaigns\/([^/]+)\/progress$/);
 if (m && req.method === 'GET') return json(await progress(env, await loadCampaign(env, m[1])));
 if (path === '/findings' && req.method === 'GET') return json(await findings(env, q.get('campaign'), q.get('all') === '1'));
 m = path.match(/^\/findings\/(result|feedback)\/([^/]+)(?:\/(ado-preview|create-ado|link-ado|redact))?$/);
 if (m) {
  const id = decodeURIComponent(m[2]);
  if (!m[3] && req.method === 'PATCH') {
   const t = await target(env, m[1], id); const b = await body(req);
   const triage = text(b.triage, 30); if (!TRIAGE.includes(triage)) throw new HttpError(400, 'Invalid triage status');
   await statement(env, `UPDATE ${t.table} SET triage=?,admin_note=?,triaged_by=?,triaged_at=? WHERE ${t.where}`, triage, text(b.admin_note ?? '', 1000), user.sub, now(), ...t.args as string[]).run();
   await record(env, user, 'triage', `${m[1]}:${id}`, triage); return json({ ok: true });
  }
  if (m[3] === 'ado-preview' && req.method === 'GET') return json(await preview(req, env, m[1], id));
  if (m[3] === 'create-ado' && req.method === 'POST') return createAdo(req, env, user, m[1], id, fetcher);
  if (m[3] === 'link-ado' && req.method === 'POST') {
   const t = await target(env, m[1], id); const b = await body(req);
   const ado = await verifyAdo(env, await getWorkspace(env), b.ado_id, fetcher);
   await statement(env, `UPDATE ${t.table} SET ado_id=?,triaged_by=?,triaged_at=? WHERE ${t.where} AND ado_id IS NULL`, ado, user.sub, now(), ...t.args as string[]).run();
   await record(env, user, 'link-ado', `${m[1]}:${id}`, String(ado)); return json({ ok: true, ado_id: ado });
  }
  if (m[3] === 'redact' && req.method === 'POST') {
   const t = await target(env, m[1], id); const stmts = [statement(env, `UPDATE ${t.table} SET redacted=1 WHERE ${t.where}`, ...t.args as string[])];
   if (t.table === 'results') stmts.push(statement(env, "UPDATE result_history SET note='[redacted]' WHERE run_id=? AND step_id=?", ...t.args as string[]));
   await env.DB.batch(stmts); await record(env, user, 'redact', `${m[1]}:${id}`); return json({ ok: true });
  }
 }
 m = path.match(/^\/runs\/([^/]+)$/);
 if (m && req.method === 'GET') return json(await runPayload(env, await getRun(env, user, m[1]), true));
 if (path === '/audit' && req.method === 'GET') return json(await all(env, 'SELECT id,ts,actor_sub,action,target,detail FROM audit ORDER BY id DESC LIMIT ?', Math.min(500, Number(q.get('limit')) || 200)));
 m = path.match(/^\/export\/(results|findings)\.csv$/);
 if (m && req.method === 'GET') {
  const c = q.get('campaign');
  if (m[1] === 'findings') {
   const rows = (await findings(env, c, false)).map(f => ({ campaign: f.campaign, tester: f.owner_email, role: f.role, step: f.step_id, scenario: f.scenario, status: f.status, note: f.note, triage: f.triage, ado_id: f.ado_id ?? '', recorded_at: f.at }));
   return new Response(csv(rows, ['campaign', 'tester', 'role', 'step', 'scenario', 'status', 'note', 'triage', 'ado_id', 'recorded_at']), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="findings.csv"' } });
  }
  const rows = (await findings(env, c, true)).filter(f => f.kind === 'result').map(f => ({ campaign: f.campaign, tester: f.owner_email, role: f.role, step: f.step_id, scenario: f.scenario, status: f.status, recorded: 1, passing: f.status_kind === 'pass' ? 1 : 0, note: f.note, triage: f.triage, ado_id: f.ado_id ?? '', recorded_at: f.at }));
  return new Response(csv(rows, ['campaign', 'tester', 'role', 'step', 'scenario', 'status', 'recorded', 'passing', 'note', 'triage', 'ado_id', 'recorded_at']), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="results.csv"' } });
 }
}
