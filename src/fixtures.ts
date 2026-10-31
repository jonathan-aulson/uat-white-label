import type { CampaignRow, Content, Env, Fixture, FixtureField, Rule, Run } from './types';
import { all, first, HttpError, now, statement, uuid } from './db';
import { assignedSteps, tokensIn, TOKEN_RE } from './content';

export interface EvalCtx { instance: number; namespace: string; anchorDate: string; campaignStart: string; phaseDates: Record<string, string>; seed: string }

// Small deterministic PRNG (xmur3 + mulberry32): the same seed always yields the same values on any device.
function seeded(seed: string) {
 let h = 1779033703 ^ seed.length;
 for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
 let a = (h = Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) ^ (h >>> 16);
 return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad = (n: number | string, width = 0) => String(n).padStart(width, '0');
export const parseDate = (d: string) => { const [y, m, day] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, day)); };
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => { const x = parseDate(d); x.setUTCDate(x.getUTCDate() + n); return isoDate(x); };
export function todayIn(tz: string, at = new Date()): string {
 try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
 catch { return isoDate(at); }
}
export const validTimeZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
export function formatDate(iso: string, format: string) {
 const [y, m, d] = iso.split('-');
 return format === 'YYYY-MM-DD' ? iso : format === 'DD/MM/YYYY' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
}
// "Next weekday" means strictly after the anchor, so a Monday anchor yields the following Monday.
export function nextWeekday(iso: string, weekday: number) {
 const cur = parseDate(iso).getUTCDay();
 return addDays(iso, ((weekday - cur + 7) % 7) || 7);
}

export function evalRule(rule: Rule, ctx: EvalCtx, field: string, values: Record<string, string>, evalField: (key: string) => string): string {
 switch (rule.type) {
  case 'literal': return rule.value;
  case 'namespace': return ctx.namespace;
  case 'instance': return pad(ctx.instance, rule.pad ?? 0);
  case 'concat': return rule.parts.map(p => evalRule(p, ctx, field, values, evalField)).join('');
  case 'ref': return evalField(rule.field);
  case 'int': { const r = seeded(`${ctx.seed}|${field}`)(); return pad(rule.min + Math.floor(r * (rule.max - rule.min + 1)), rule.pad ?? 0); }
  case 'pick': { const r = seeded(`${ctx.seed}|${field}`)(); return rule.items[Math.floor(r * rule.items.length)]; }
  case 'date': {
   let base = rule.anchor === 'campaignStart' ? ctx.campaignStart : rule.anchor.startsWith('phase:') ? ctx.phaseDates[rule.anchor.slice(6)] : ctx.anchorDate;
   if (!base) throw new Error(`No date for anchor ${rule.anchor}`);
   if (rule.weekday !== undefined) base = nextWeekday(base, rule.weekday);
   return formatDate(addDays(base, rule.offsetDays ?? 0), rule.format ?? 'MM/DD/YYYY');
  }
 }
}
const clip = (v: string) => v.slice(0, 200);

// Evaluate the requested fields (respecting refs). `existing` values are never recomputed.
export function evalFields(fixture: Fixture, ctx: EvalCtx, want: (f: FixtureField) => boolean, existing: Record<string, string> = {}): Record<string, string> {
 const out: Record<string, string> = { ...existing };
 const byKey = new Map(fixture.fields.map(f => [f.key, f]));
 const resolving = new Set<string>();
 const get = (key: string): string => {
  if (key in out) return out[key];
  const f = byKey.get(key);
  if (!f) throw new Error(`Unknown field ${key}`);
  if (resolving.has(key)) throw new Error('Circular field reference');
  resolving.add(key);
  out[key] = clip(evalRule(f.rule, ctx, key, out, get));
  resolving.delete(key);
  return out[key];
 };
 for (const f of fixture.fields) if (!(f.key in existing) && want(f)) get(f.key);
 return out;
}

export interface Snapshot { id: string; fixture_key: string; scope: string; owner_email: string; run_id: string | null; generation: number; instance: number; anchor_date: string; tz: string; vals: string; captured: string; scope_key: string; created_at: string }
export interface ResolvedField { key: string; label: string; value: string | null; phase?: string; pending?: boolean }
export interface ResolvedFixture { key: string; label: string; scope: string; description?: string; state: 'ready' | 'waiting' | 'unassigned'; handoff?: string; owner?: string; generation?: number; fields: ResolvedField[]; captures: { key: string; label: string; value: string | null }[] }

export const phaseDatesOf = (c: CampaignRow) => JSON.parse(c.phase_dates || '{}') as Record<string, string>;
export const phaseAvailable = (c: CampaignRow, phase: string | undefined, today = todayIn(c.tz)) => {
 if (!phase) return true; const d = phaseDatesOf(c)[phase]; return !d || d <= today;
};

function scopeKey(fixture: Fixture, owner: string, runId: string | null) {
 return fixture.scope === 'run' ? `${owner}|${runId}` : owner;
}
export async function ensureSnapshot(env: Env, camp: CampaignRow, content: Content, fixture: Fixture, owner: string, ownerInstance: number, runId: string | null, generation: number, namespace: string, releaseId: string, create = true): Promise<Snapshot | null> {
 const key = scopeKey(fixture, owner, runId);
 const find = () => first<Snapshot>(env, 'SELECT * FROM fixture_snapshots WHERE campaign_id=? AND fixture_key=? AND scope_key=? AND generation=?', camp.id, fixture.key, key, generation);
 let snap = await find();
 if (!snap && !create) return null;
 if (!snap) {
  const anchor = todayIn(camp.tz);
  const ctx: EvalCtx = { instance: ownerInstance, namespace, anchorDate: anchor, campaignStart: camp.starts_on, phaseDates: phaseDatesOf(camp), seed: `${camp.id}|${fixture.key}|${key}|${generation}` };
  const vals = evalFields(fixture, ctx, f => !f.phase);
  await statement(env, `INSERT OR IGNORE INTO fixture_snapshots(id,campaign_id,fixture_key,scope,owner_email,run_id,generation,instance,anchor_date,tz,release_id,vals,created_at,scope_key)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uuid(), camp.id, fixture.key, fixture.scope, owner, fixture.scope === 'run' ? runId : null, generation, ownerInstance, anchor, camp.tz, releaseId, JSON.stringify(vals), now(), key).run();
  snap = await find();
  if (!snap) throw new HttpError(503, 'Could not save fixture values — retry');
 }
 if (!snap) return null;
 // Phase fields are appended once their phase date is reached; existing values are never recomputed.
 const have = JSON.parse(snap.vals) as Record<string, string>;
 const missing = fixture.fields.filter(f => f.phase && !(f.key in have) && phaseAvailable(camp, f.phase));
 if (missing.length) {
  const ctx: EvalCtx = { instance: snap.instance, namespace, anchorDate: snap.anchor_date, campaignStart: camp.starts_on, phaseDates: phaseDatesOf(camp), seed: `${camp.id}|${fixture.key}|${key}|${generation}` };
  const merged = evalFields(fixture, ctx, f => missing.includes(f), have);
  await statement(env, 'UPDATE fixture_snapshots SET vals=? WHERE id=? AND vals=?', JSON.stringify(merged), snap.id, snap.vals).run();
  snap = (await find())!;
 }
 return snap;
}

export async function latestSharedGeneration(env: Env, campaignId: string, fixtureKey: string, producer: string) {
 return (await first<{ g: number | null }>(env, 'SELECT MAX(generation) AS g FROM fixture_snapshots WHERE campaign_id=? AND fixture_key=? AND scope_key=?', campaignId, fixtureKey, producer))?.g ?? 1;
}
export function fixturesUsedBy(content: Content, role: string): Set<string> {
 const used = new Set<string>();
 const scan = (s?: string) => { if (s) for (const t of tokensIn(s)) used.add(t.fixture); };
 for (const sc of content.scenarios) {
  const steps = sc.steps.filter(s => s.roles.includes(role));
  if (!steps.length) continue;
  scan(sc.before); steps.forEach(s => { scan(s.text); scan(s.expect); });
 }
 for (const d of content.documents ?? []) if (d.kind === 'generated' && (!d.roles?.length || d.roles.includes(role)) && d.recipe) {
  d.recipe.rows.forEach(r => scan(r.value)); scan(d.recipe.subtitle); scan(d.recipe.footer);
 }
 for (const h of content.handoffs ?? []) if (assignedSteps(content, role).some(s => s.requires?.includes(h.key)) || h.producerRoles?.includes(role)) used.add(h.fixture);
 return used;
}

export async function resolveRunFixtures(env: Env, camp: CampaignRow, content: Content, run: Run, namespace: string, create = true): Promise<ResolvedFixture[]> {
 const out: ResolvedFixture[] = [];
 const used = fixturesUsedBy(content, run.role);
 const instanceOf = async (email: string) => (await first<{ instance: number }>(env, 'SELECT instance FROM members WHERE email=?', email))?.instance ?? 0;
 const bindings = await all<{ handoff_key: string; producer_email: string; consumer_email: string; status: string }>(env,
  'SELECT handoff_key,producer_email,consumer_email,status FROM handoffs WHERE campaign_id=? AND (producer_email=? OR consumer_email=?)', camp.id, run.owner_email, run.owner_email);
 for (const fx of content.fixtures ?? []) {
  if (!used.has(fx.key)) continue;
  const captureDefs = fx.captures ?? [];
  const base: ResolvedFixture = { key: fx.key, label: fx.label, scope: fx.scope, description: fx.description, state: 'ready', fields: [], captures: [] };
  let snap: Snapshot | null = null;
  if (fx.scope === 'shared') {
   const hDefs = (content.handoffs ?? []).filter(h => h.fixture === fx.key).map(h => h.key);
   const asProducer = bindings.find(b => hDefs.includes(b.handoff_key) && b.producer_email === run.owner_email);
   const asConsumer = bindings.find(b => hDefs.includes(b.handoff_key) && b.consumer_email === run.owner_email);
   if (asProducer) {
    base.handoff = asProducer.handoff_key; base.owner = asProducer.producer_email;
    snap = await ensureSnapshot(env, camp, content, fx, asProducer.producer_email, await instanceOf(asProducer.producer_email), null, await latestSharedGeneration(env, camp.id, fx.key, asProducer.producer_email), namespace, run.release_id, create);
   } else if (asConsumer) {
    base.handoff = asConsumer.handoff_key; base.owner = asConsumer.producer_email;
    if (asConsumer.status === 'pending') base.state = 'waiting';
    else snap = await first<Snapshot>(env, 'SELECT * FROM fixture_snapshots WHERE campaign_id=? AND fixture_key=? AND scope_key=? ORDER BY generation DESC LIMIT 1', camp.id, fx.key, asConsumer.producer_email);
   } else base.state = 'unassigned';
  } else {
   snap = await ensureSnapshot(env, camp, content, fx, run.owner_email, await instanceOf(run.owner_email), run.id, fx.scope === 'run' ? 1 : run.fixture_generation, namespace, run.release_id, create);
  }
  const vals = snap ? JSON.parse(snap.vals) as Record<string, string> : {};
  const captured = snap ? JSON.parse(snap.captured) as Record<string, string> : {};
  base.generation = snap?.generation;
  base.fields = fx.fields.map(f => ({ key: f.key, label: f.label, phase: f.phase, value: snap && f.key in vals ? vals[f.key] : null, pending: !!f.phase && !(f.key in vals) && !!snap }));
  base.captures = captureDefs.map(c => ({ key: c.key, label: c.label, value: captured[c.key] ?? null }));
  out.push(base);
 }
 return out;
}

export function valueMap(fixtures: ResolvedFixture[]): Map<string, string> {
 const m = new Map<string, string>();
 for (const f of fixtures) {
  for (const fl of f.fields) if (fl.value !== null) m.set(`${f.key}.${fl.key}`, fl.value);
  for (const c of f.captures) if (c.value !== null) m.set(`${f.key}.${c.key}`, c.value);
 }
 return m;
}
export function renderTokens(template: string, values: Map<string, string>): { text: string; unresolved: string[] } {
 const unresolved: string[] = [];
 const text = template.replace(TOKEN_RE, (_m, f: string, k: string) => {
  const v = values.get(`${f}.${k}`); if (v === undefined) { unresolved.push(`${f}.${k}`); return `[${f}.${k} not available]`; } return v;
 });
 return { text, unresolved };
}
