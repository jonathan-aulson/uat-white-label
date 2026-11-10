import type { Content, Env, Identity, ResultRow, Run, Feedback, CampaignRow } from './types';
import { all, body, first, HttpError, isUuid, json, now, sha256Hex, statement, text, uuid, audit } from './db';
import { assignedSteps, REFERENCE_PATTERNS, statusesOf, visibleScenarios } from './content';
import { loadCampaign, runContext } from './release';
import { getWorkspace, publicWorkspace } from './settings';
import { latestSharedGeneration, phaseAvailable, phaseDatesOf, renderTokens, resolveRunFixtures, valueMap, ensureSnapshot, type Snapshot } from './fixtures';
import { generatePdf } from './pdf';
import { isOpen, openWorkspace } from './open-access';

export const displayOf = async (env: Env, email: string) => {
 const m = await first<{ display_name: string }>(env, 'SELECT display_name FROM members WHERE email=?', email);
 return m?.display_name || email;
};
async function invite(env: Env, campaignId: string, email: string) {
 const row = await first<{ roles: string }>(env, 'SELECT roles FROM campaign_invites WHERE campaign_id=? AND email=?', campaignId, email);
 return row ? JSON.parse(row.roles) as string[] : null;
}
export async function getRun(env: Env, user: Identity, id: string, ownerOnly = false) {
 const run = await first<Run>(env, 'SELECT * FROM runs WHERE id=?', id);
 if (!run || (run.owner_sub !== user.sub && (ownerOnly || !user.isAdmin))) throw new HttpError(404, 'Run not found');
 return run;
}
interface HandoffView { id: string; key: string; label: string; as: 'producer' | 'consumer'; counterpart: string; status: string; ready_at: string | null; ack_at: string | null; record_ref: string; overridden: boolean }
async function handoffViews(env: Env, content: Content, campaignId: string, email: string): Promise<HandoffView[]> {
 const rows = await all<{ id: string; handoff_key: string; producer_email: string; consumer_email: string; status: string; ready_at: string | null; ack_at: string | null; record_ref: string; overrides: number }>(env,
  `SELECT h.*,(SELECT COUNT(*) FROM handoff_overrides o WHERE o.handoff_id=h.id) AS overrides FROM handoffs h WHERE campaign_id=? AND (producer_email=? OR consumer_email=?)`, campaignId, email, email);
 const out: HandoffView[] = [];
 for (const r of rows) {
  const def = content.handoffs?.find(h => h.key === r.handoff_key); if (!def) continue;
  const as = r.producer_email === email ? 'producer' : 'consumer';
  out.push({ id: r.id, key: r.handoff_key, label: def.label, as, counterpart: await displayOf(env, as === 'producer' ? r.consumer_email : r.producer_email), status: r.status, ready_at: r.ready_at, ack_at: r.ack_at, record_ref: r.record_ref, overridden: r.overrides > 0 });
 }
 return out;
}

export async function runPayload(env: Env, run: Run, readonly: boolean) {
 const { campaign, release, content, workspace } = await runContext(env, run);
 const fixtures = await resolveRunFixtures(env, campaign, content, run, workspace.namespace, !readonly);
 const handoffs = await handoffViews(env, content, campaign.id, run.owner_email);
 const phaseDates = phaseDatesOf(campaign);
 const scenarios = visibleScenarios(content, run.role);
 const docKeys = new Set(scenarios.flatMap(s => s.steps.flatMap(st => st.docs ?? [])));
 const docRows = await all<{ id: string; status: string }>(env, 'SELECT id,status FROM documents');
 const docStatus = new Map(docRows.map(d => [d.id, d.status]));
 const documents = (content.documents ?? []).filter(d => !d.roles?.length || d.roles.includes(run.role)).map(d => ({
  key: d.key, title: d.title, kind: d.kind, linked: docKeys.has(d.key),
  removed: d.kind === 'upload' && docStatus.get(d.documentId ?? '') !== 'active'
 }));
 const results = await all<ResultRow>(env, 'SELECT * FROM results WHERE run_id=?', run.id);
 return {
  run, readonly,
  campaign: { id: campaign.id, name: campaign.name, environment: campaign.environment, build: campaign.build, status: campaign.status, starts_on: campaign.starts_on, tz: campaign.tz },
  release: { id: release.id, seq: release.seq, label: release.label },
  content: { title: content.title, roles: content.roles, statuses: statusesOf(content), phases: (content.phases ?? []).map(p => ({ ...p, date: phaseDates[p.key] ?? null, available: phaseAvailable(campaign, p.key) })), scenarios, documents },
  fixtures, handoffs, results,
  feedback: await all<Feedback>(env, 'SELECT * FROM feedback WHERE run_id=? ORDER BY created_at', run.id)
 };
}

// Server-side gate for a "pass"-kind result: phase availability and acknowledged handoffs.
async function gateStep(env: Env, run: Run, campaign: CampaignRow, content: Content, stepId: string) {
 const step = assignedSteps(content, run.role).find(s => s.id === stepId);
 if (!step) throw new HttpError(400, 'Step not in pinned release and role');
 if (!phaseAvailable(campaign, step.phase)) throw new HttpError(409, `This step is not available until ${phaseDatesOf(campaign)[step.phase!]}`, { code: 'phase_locked' });
 const unmet: string[] = [];
 for (const key of step.requires ?? []) {
  const h = await first<{ id: string; status: string; ov: number }>(env, `SELECT id,status,(SELECT COUNT(*) FROM handoff_overrides o WHERE o.handoff_id=handoffs.id) AS ov FROM handoffs WHERE campaign_id=? AND handoff_key=? AND consumer_email=?`, campaign.id, key, run.owner_email);
  const own = !h && !!(await first(env, 'SELECT 1 AS x FROM handoffs WHERE campaign_id=? AND handoff_key=? AND producer_email=?', campaign.id, key, run.owner_email));
  if (own) continue; // producers are never blocked by the record they create
  if (!h || (h.status !== 'acknowledged' && !h.ov)) unmet.push(content.handoffs?.find(x => x.key === key)?.label ?? key);
 }
 return { step, unmet };
}

export async function testerApi(req: Request, env: Env, user: Identity, path: string): Promise<Response | undefined> {
 const method = req.method;
 if (path === '/api/me' && ['GET', 'PUT'].includes(method)) {
  if (method === 'PUT') {
   if (isOpen(env)) throw new HttpError(400, 'Edit tester names in the admin roster.');
   const b = await body(req); const name = text(b.displayName, 80);
   await env.DB.batch([
    statement(env, 'UPDATE users SET display_name=? WHERE sub=?', name, user.sub),
    statement(env, "UPDATE members SET display_name=? WHERE email=? AND display_name=''", name, user.email)
   ]);
  }
  if (isOpen(env)) return json({ email: user.email, sub: user.sub, isAdmin: false, canAdmin: true, openAccess: true,
   selected: !!user.instance, participantId: user.instance ? String(user.instance) : null, instance: user.instance,
   displayName: user.displayName, workspace: await openWorkspace(env) });
  const row = await first<{ display_name: string }>(env, 'SELECT display_name FROM users WHERE sub=?', user.sub);
  const ws = await getWorkspace(env);
  return json({ email: user.email, sub: user.sub, isAdmin: user.isAdmin, instance: user.instance, displayName: row?.display_name || '', workspace: { ...publicWorkspace(ws), has_logo: !!(await first(env, "SELECT 1 AS x FROM assets WHERE kind='logo'")) } });
 }
 if (path === '/api/campaigns' && method === 'GET') {
  const rows = await all<CampaignRow & { roles: string }>(env, `SELECT c.*,i.roles FROM campaigns c JOIN campaign_invites i ON i.campaign_id=c.id WHERE i.email=? ORDER BY c.status, c.created_at DESC`, user.email);
  const runs = await all<Run & { completed: number }>(env, `SELECT runs.*,(SELECT COUNT(*) FROM results WHERE results.run_id=runs.id AND results.status IS NOT NULL) AS completed FROM runs WHERE owner_sub=? AND archived=0 ORDER BY created_at DESC`, user.sub);
  const out = [];
  for (const c of rows) {
   const { content, row } = await (await import('./release')).loadRelease(env, c.release_id);
   const allowed = JSON.parse(c.roles) as string[];
   out.push({ id: c.id, name: c.name, environment: c.environment, build: c.build, status: c.status, starts_on: c.starts_on, ends_on: c.ends_on, release: { seq: row.seq, label: row.label },
    roles: content.roles.filter(r => allowed.includes(r.key)).map(r => ({ key: r.key, label: r.label, description: r.description ?? '', steps: assignedSteps(content, r.key).length })),
    runs: runs.filter(r => r.campaign_id === c.id) });
  }
  return json(out);
 }
 let m = path.match(/^\/api\/campaigns\/([^/]+)\/runs$/);
 if (m && method === 'POST') {
  const campaign = await loadCampaign(env, decodeURIComponent(m[1]));
  const allowed = await invite(env, campaign.id, user.email);
  if (!allowed) throw new HttpError(404, 'Campaign not found');
  if (campaign.status !== 'open') throw new HttpError(409, 'This campaign is closed');
  const b = await body(req); const role = text(b.role, 50, true);
  if (!allowed.includes(role)) throw new HttpError(403, 'You are not assigned to that role in this campaign');
  const existing = await first<Run>(env, 'SELECT * FROM runs WHERE owner_sub=? AND campaign_id=? AND role=? AND archived=0', user.sub, campaign.id, role);
  const reset = b.reset === true;
  if (existing && !reset) return json({ run: existing, resumed: true });
  const gen = ((await first<{ g: number | null }>(env, 'SELECT MAX(fixture_generation) AS g FROM runs WHERE owner_sub=? AND campaign_id=?', user.sub, campaign.id))?.g ?? 0) + (reset ? 1 : (existing ? 0 : 0));
  const id = uuid(), ts = now();
  const stmts = [];
  if (existing && reset) stmts.push(statement(env, 'UPDATE runs SET archived=1 WHERE id=?', existing.id), audit(env, user, 'reset-run', existing.id, `new generation ${gen}`));
  stmts.push(statement(env, 'INSERT INTO runs(id,owner_sub,owner_email,campaign_id,release_id,role,build,environment,created_at,fixture_generation) VALUES(?,?,?,?,?,?,?,?,?,?)', id, user.sub, user.email, campaign.id, campaign.release_id, role, campaign.build, campaign.environment, ts, Math.max(gen, 1)));
  await env.DB.batch(stmts);
  return json({ run: await first<Run>(env, 'SELECT * FROM runs WHERE id=?', id) }, 201);
 }
 if (path === '/api/runs' && method === 'GET') return json(await all(env, `SELECT runs.*,campaigns.name AS campaign_name,(SELECT COUNT(*) FROM results WHERE results.run_id=runs.id AND results.status IS NOT NULL) AS completed FROM runs JOIN campaigns ON campaigns.id=runs.campaign_id WHERE owner_sub=? AND archived=0 ORDER BY runs.created_at DESC`, user.sub));

 if (path === '/api/handoffs' && method === 'GET') {
  const rows = await all<{ id: string; campaign_id: string }>(env, 'SELECT id,campaign_id FROM handoffs WHERE producer_email=? OR consumer_email=?', user.email, user.email);
  const campaigns = [...new Set(rows.map(r => r.campaign_id))]; const out: HandoffView[] = [];
  for (const cid of campaigns) { const c = await loadCampaign(env, cid); const { content } = await (await import('./release')).loadRelease(env, c.release_id); out.push(...(await handoffViews(env, content, cid, user.email)).map(h => ({ ...h, campaign: c.name } as HandoffView))); }
  return json(out);
 }
 m = path.match(/^\/api\/handoffs\/([^/]+)\/(ready|acknowledge)$/);
 if (m && method === 'POST') {
  const h = await first<{ id: string; campaign_id: string; handoff_key: string; producer_email: string; consumer_email: string; status: string }>(env, 'SELECT * FROM handoffs WHERE id=?', m[1]);
  if (!h || (m[2] === 'ready' ? h.producer_email !== user.email : h.consumer_email !== user.email)) throw new HttpError(404, 'Handoff not found');
  const campaign = await loadCampaign(env, h.campaign_id);
  if (campaign.status !== 'open') throw new HttpError(409, 'This campaign is closed');
  const b = await body(req);
  if (m[2] === 'ready') {
   const ref = typeof b.recordRef === 'string' ? b.recordRef.trim() : '';
   if (ref.length > 64 || !/^[A-Za-z0-9._ #-]*$/.test(ref)) throw new HttpError(400, 'Record reference must be up to 64 letters, digits or . _ - # characters');
   // The producer's shared values must exist before anyone is told the record is ready.
   const { content } = await (await import('./release')).loadRelease(env, campaign.release_id);
   const def = content.handoffs?.find(x => x.key === h.handoff_key); const fx = content.fixtures?.find(f => f.key === def?.fixture);
   if (fx) { const ws = await getWorkspace(env); const inst = (await first<{ instance: number }>(env, 'SELECT instance FROM members WHERE email=?', h.producer_email))!.instance; await ensureSnapshot(env, campaign, content, fx, h.producer_email, inst, null, await latestSharedGeneration(env, campaign.id, fx.key, h.producer_email), ws.namespace, campaign.release_id); }
   await env.DB.batch([
    statement(env, "UPDATE handoffs SET status='ready',ready_at=?,record_ref=? WHERE campaign_id=? AND handoff_key=? AND producer_email=? AND status='pending'", now(), ref, h.campaign_id, h.handoff_key, h.producer_email),
    statement(env, "UPDATE handoffs SET record_ref=? WHERE campaign_id=? AND handoff_key=? AND producer_email=? AND status!='pending'", ref, h.campaign_id, h.handoff_key, h.producer_email)
   ]);
   // One producer confirmation covers every consumer bound to the same producer and handoff.
  } else {
   if (h.status === 'pending') throw new HttpError(409, 'The producer has not confirmed this record yet');
   await statement(env, "UPDATE handoffs SET status='acknowledged',ack_at=? WHERE id=? AND status IN ('ready','acknowledged')", now(), h.id).run();
  }
  return json({ ok: true });
 }

 m = path.match(/^\/api\/runs\/([^/]+)(?:\/(results\/([^/]+)|feedback|archive|fixtures\/([^/]+)\/captured|documents\/([^/]+)))?$/);
 if (!m) return;
 const id = decodeURIComponent(m[1]);
 const run = await getRun(env, user, id, method !== 'GET');
 if (method === 'GET' && !m[2]) return json(await runPayload(env, run, run.owner_sub !== user.sub));
 if (method === 'GET' && m[5]) return documentResponse(env, run, decodeURIComponent(m[5]), run.owner_sub !== user.sub);
 const ctx = await runContext(env, run);
 if (ctx.campaign.status !== 'open' && method !== 'GET') throw new HttpError(409, 'This campaign is closed');
 if (run.archived) throw new HttpError(409, 'Run archived — start a new session or contact the administrator');
 if (method === 'POST' && m[2] === 'archive') { await statement(env, 'UPDATE runs SET archived=1 WHERE id=?', id).run(); return json({ archived: true }); }
 if (method === 'POST' && m[2] === 'feedback') {
  const b = await body(req); const feedbackId = text(b.id, 36, true), message = text(b.text, 4000, true);
  if (!isUuid(feedbackId)) throw new HttpError(400, 'A client UUID is required');
  await statement(env, 'INSERT OR IGNORE INTO feedback(id,run_id,owner_sub,text,created_at) VALUES(?,?,?,?,?)', feedbackId, id, user.sub, message, now()).run();
  const saved = await first<Feedback>(env, 'SELECT * FROM feedback WHERE id=?', feedbackId);
  if (!saved || saved.owner_sub !== user.sub || saved.run_id !== id) throw new HttpError(404, 'Feedback not found');
  return json(saved);
 }
 if (method === 'PUT' && m[4]) {
  const key = decodeURIComponent(m[4]); const fx = ctx.content.fixtures?.find(f => f.key === key);
  if (!fx || !fx.captures?.length) throw new HttpError(404, 'Fixture has no capture fields');
  const b = await body(req); const incoming = b.values;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new HttpError(400, 'values must be an object');
  const fixtures = await resolveRunFixtures(env, ctx.campaign, ctx.content, run, ctx.workspace.namespace);
  const rf = fixtures.find(f => f.key === key);
  // Only the snapshot owner (tester/run scope, or the producer of a shared record) may capture IDs.
  if (!rf || (fx.scope === 'shared' && rf.owner !== run.owner_email)) throw new HttpError(403, 'Only the owner of this record can capture its identifiers');
  const snapRow = await first<Snapshot>(env, 'SELECT * FROM fixture_snapshots WHERE campaign_id=? AND fixture_key=? AND scope_key=? AND generation=?', ctx.campaign.id, key, fx.scope === 'run' ? `${run.owner_email}|${run.id}` : run.owner_email, fx.scope === 'run' ? 1 : (fx.scope === 'shared' ? await latestSharedGeneration(env, ctx.campaign.id, key, run.owner_email) : run.fixture_generation));
  if (!snapRow) throw new HttpError(404, 'Fixture values not found');
  const current = JSON.parse(snapRow.captured) as Record<string, string>;
  for (const [k, v] of Object.entries(incoming)) {
   if (!fx.captures.some(c => c.key === k)) throw new HttpError(400, `Unknown capture field "${k}"`);
   if (typeof v !== 'string' || v.length > 64 || !/^[A-Za-z0-9._ #-]*$/.test(v)) throw new HttpError(400, 'Captured identifiers must be up to 64 letters, digits or . _ - # characters');
   if (v) current[k] = v; else delete current[k];
  }
  await statement(env, 'UPDATE fixture_snapshots SET captured=? WHERE id=?', JSON.stringify(current), snapRow.id).run();
  return json({ captured: current });
 }
 if (method === 'PUT' && m[3]) {
  const stepId = decodeURIComponent(m[3]); const statuses = statusesOf(ctx.content);
  const b = await body(req), status = b.status;
  const def = typeof status === 'string' ? statuses.find(s => s.key === status) : undefined;
  if (status !== null && !def) throw new HttpError(400, 'Invalid status');
  const note = text(b.note ?? '', 4000, !!def?.needsNote);
  if (def?.needsReference && !REFERENCE_PATTERNS[def.needsReference].test(note)) throw new HttpError(400, def.needsReference === 'url' ? 'This status needs a link in the note' : 'This status needs a reference number in the note');
  if (!Number.isSafeInteger(b.rev) || Number(b.rev) < 0) throw new HttpError(400, 'Invalid revision');
  const { step, unmet } = await gateStep(env, run, ctx.campaign, ctx.content, stepId);
  if (def?.kind === 'pass' && unmet.length) throw new HttpError(409, `Waiting for handoff: ${unmet.join(', ')}. You can record a Blocked status instead.`, { code: 'handoff_blocked', unmet });
  void step;
  const rev = Number(b.rev), ts = now();
  const server = await first<ResultRow>(env, 'SELECT * FROM results WHERE run_id=? AND step_id=?', id, stepId);
  if (server && (server.triage !== 'New' || server.ado_id !== null || server.redacted)) throw new HttpError(409, 'locked – contact admin', { server, locked: true });
  const write = server
   ? statement(env, `UPDATE results SET status=?,note=?,rev=rev+1,updated_at=? WHERE run_id=? AND step_id=? AND rev=? AND triage='New' AND ado_id IS NULL AND redacted=0`, status as string | null, note, ts, id, stepId, rev)
   : statement(env, `INSERT OR IGNORE INTO results(run_id,step_id,status,note,rev,updated_at) SELECT ?,?,?,?,?,? WHERE ?=0`, id, stepId, status as string | null, note, 1, ts, rev);
  const saved = await env.DB.batch([
   write,
   statement(env, `INSERT INTO result_history(run_id,step_id,status,note,rev,changed_at,changed_by) SELECT run_id,step_id,status,note,rev,updated_at,? FROM results WHERE run_id=? AND step_id=? AND changes()=1`, user.sub, id, stepId)
  ]);
  if (saved[0].meta.changes !== 1) {
   const latest = await first<ResultRow>(env, 'SELECT * FROM results WHERE run_id=? AND step_id=?', id, stepId);
   const locked = !!latest && (latest.triage !== 'New' || latest.ado_id !== null || !!latest.redacted);
   throw new HttpError(409, locked ? 'locked – contact admin' : 'Changed on another device', { server: latest, locked });
  }
  return json({ rev: rev + 1, updated_at: ts });
 }
}

export async function documentResponse(env: Env, run: Run, key: string, readonly: boolean): Promise<Response> {
 const { campaign, content, workspace, release } = await runContext(env, run);
 const def = content.documents?.find(d => d.key === key);
 if (!def || (def.roles?.length && !def.roles.includes(run.role))) throw new HttpError(404, 'Document not found');
 if (def.kind === 'upload') {
  const doc = await first<{ id: string; filename: string; r2_key: string; status: string; sha256: string; audience: string }>(env, 'SELECT * FROM documents WHERE id=?', def.documentId ?? '');
  if (!doc) throw new HttpError(404, 'Document not found');
  if (doc.status !== 'active') throw new HttpError(410, 'This document has been removed by an administrator');
  const audience = JSON.parse(doc.audience) as string[];
  if (audience.length && !audience.includes(run.role)) throw new HttpError(404, 'Document not found');
  if (!env.DOCS) throw new HttpError(503, 'Document storage is not available on this deployment');
  const obj = await env.DOCS.get(doc.r2_key);
  if (!obj) throw new HttpError(404, 'Document file is missing');
  return new Response(obj.body, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${doc.filename.replace(/"/g, '')}"`, 'X-Content-SHA256': doc.sha256 } });
 }
 const fixtures = await resolveRunFixtures(env, campaign, content, run, workspace.namespace, !readonly);
 const values = valueMap(fixtures); const unresolved = new Set<string>();
 const r = def.recipe!;
 const rend = (s: string) => { const x = renderTokens(s, values); x.unresolved.forEach(u => unresolved.add(u)); return x.text; };
 const spec = { title: rend(r.title), subtitle: r.subtitle ? rend(r.subtitle) : undefined, rows: r.rows.map(row => ({ label: row.label, value: rend(row.value) })), footer: r.footer ? rend(r.footer) : undefined, created: campaign.starts_on };
 if (unresolved.size) throw new HttpError(409, `Document values are not ready yet: ${[...unresolved].join(', ')}`, { code: 'values_unavailable', unresolved: [...unresolved] });
 const bytes = generatePdf(spec); const hash = await sha256Hex(bytes);
 await statement(env, 'INSERT OR IGNORE INTO generated_documents(campaign_id,owner_email,doc_key,release_id,input_sha,sha256,created_at) VALUES(?,?,?,?,?,?,?)', campaign.id, run.owner_email, key, release.id, await sha256Hex(JSON.stringify(spec)), hash, now()).run();
 return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${key}.pdf"`, 'X-Content-SHA256': hash } });
}
