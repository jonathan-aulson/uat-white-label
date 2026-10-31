import type { Content, DocDef, Rule, StatusDef } from './types';

export interface Issue { path: string; message: string; level: 'error' | 'warning' }
export const DEFAULT_STATUSES: StatusDef[] = [
 { key: 'pass', label: 'Passed', kind: 'pass' },
 { key: 'issue', label: 'Issue', kind: 'fail', needsNote: true },
 { key: 'question', label: 'Question', kind: 'info', needsNote: true },
 { key: 'blocked', label: 'Blocked', kind: 'blocked', needsNote: true }
];
export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const FIELD_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;
export const TOKEN_RE = /\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;
export const LIMITS = { bytes: 400_000, steps: 1000, fixtures: 40, fields: 60, scenarios: 200 };
export const REFERENCE_PATTERNS = { number: /\b\d{3,8}\b/, url: /https?:\/\/\S+/ } as const;

export const statusesOf = (c: Content) => c.statuses?.length ? c.statuses : DEFAULT_STATUSES;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function tokensIn(value: string): { fixture: string; field: string }[] {
 return [...value.matchAll(TOKEN_RE)].map(m => ({ fixture: m[1], field: m[2] }));
}
// Any "{{" that is not a well-formed token is an authoring mistake.
const strayBraces = (value: string) => value.replace(TOKEN_RE, '').includes('{{');

function validateRule(rule: unknown, path: string, fieldKeys: Set<string>, phases: Set<string>, issues: Issue[], depth = 0): string[] {
 const refs: string[] = [];
 const err = (message: string) => issues.push({ path, message, level: 'error' });
 if (!isObj(rule) || typeof rule.type !== 'string') { err('Rule must be an object with a type'); return refs; }
 if (depth > 5) { err('Rule nesting is too deep (max 5)'); return refs; }
 switch (rule.type) {
  case 'literal': if (typeof rule.value !== 'string' || rule.value.length > 200) err('literal.value must be text up to 200 characters'); break;
  case 'namespace': break;
  case 'instance': if (rule.pad !== undefined && !(Number.isInteger(rule.pad) && (rule.pad as number) >= 0 && (rule.pad as number) <= 8)) err('instance.pad must be 0–8'); break;
  case 'concat':
   if (!Array.isArray(rule.parts) || !rule.parts.length || rule.parts.length > 10) err('concat.parts must have 1–10 rules');
   else rule.parts.forEach((p, i) => refs.push(...validateRule(p, `${path}.parts[${i}]`, fieldKeys, phases, issues, depth + 1)));
   break;
  case 'ref':
   if (typeof rule.field !== 'string' || !fieldKeys.has(rule.field)) err(`ref.field "${String(rule.field)}" is not a field of this fixture`);
   else refs.push(rule.field);
   break;
  case 'int':
   if (!Number.isInteger(rule.min) || !Number.isInteger(rule.max) || (rule.min as number) > (rule.max as number) || Math.abs(rule.min as number) > 1e9 || Math.abs(rule.max as number) > 1e9) err('int needs integer min <= max within ±1,000,000,000');
   if (rule.pad !== undefined && !(Number.isInteger(rule.pad) && (rule.pad as number) >= 0 && (rule.pad as number) <= 12)) err('int.pad must be 0–12');
   break;
  case 'pick':
   if (!Array.isArray(rule.items) || !rule.items.length || rule.items.length > 50 || rule.items.some(i => typeof i !== 'string' || i.length > 100)) err('pick.items must be 1–50 texts up to 100 characters');
   break;
  case 'date': {
   const anchor = rule.anchor;
   if (typeof anchor !== 'string' || !(anchor === 'created' || anchor === 'campaignStart' || (anchor.startsWith('phase:') && phases.has(anchor.slice(6))))) err('date.anchor must be created, campaignStart or phase:<existing phase key>');
   if (rule.offsetDays !== undefined && !(Number.isInteger(rule.offsetDays) && Math.abs(rule.offsetDays as number) <= 36500)) err('date.offsetDays must be an integer within ±36500');
   if (rule.weekday !== undefined && !(Number.isInteger(rule.weekday) && (rule.weekday as number) >= 0 && (rule.weekday as number) <= 6)) err('date.weekday must be 0 (Sunday) – 6');
   if (rule.format !== undefined && !['MM/DD/YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY'].includes(rule.format as string)) err('date.format is not supported');
   break;
  }
  default: err(`Unknown rule type "${rule.type}"`);
 }
 return refs;
}

function findCycle(graph: Map<string, string[]>): string[] | null {
 const state = new Map<string, number>(); const stack: string[] = [];
 const visit = (n: string): string[] | null => {
  state.set(n, 1); stack.push(n);
  for (const m of graph.get(n) ?? []) {
   if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
   if (!state.get(m)) { const c = visit(m); if (c) return c; }
  }
  stack.pop(); state.set(n, 2); return null;
 };
 for (const n of graph.keys()) if (!state.get(n)) { const c = visit(n); if (c) return c; }
 return null;
}

export interface DocInfo { id: string; sha256: string; status: string }

export function validateContent(input: unknown, docs: Map<string, DocInfo> = new Map()): { issues: Issue[]; content: Content | null } {
 const issues: Issue[] = [];
 const err = (path: string, message: string) => issues.push({ path, message, level: 'error' });
 const warn = (path: string, message: string) => issues.push({ path, message, level: 'warning' });
 if (!isObj(input)) { err('', 'Content must be a JSON object'); return { issues, content: null }; }
 if (JSON.stringify(input).length > LIMITS.bytes) { err('', `Content exceeds ${LIMITS.bytes} bytes`); return { issues, content: null }; }
 const c = input as unknown as Content;
 if (c.schema !== 1) err('schema', 'schema must be 1');
 if (!str(c.title, 120)) err('title', 'title is required (max 120 characters)');

 const roleKeys = new Set<string>();
 if (!Array.isArray(c.roles) || !c.roles.length) err('roles', 'At least one role is required');
 else c.roles.forEach((r, i) => {
  const p = `roles[${i}]`;
  if (!isObj(r) || !KEY_RE.test(String(r.key))) err(`${p}.key`, 'Role key must be lower-case letters, digits and hyphens (max 40)');
  else if (roleKeys.has(r.key)) err(`${p}.key`, `Duplicate role key "${r.key}"`);
  else roleKeys.add(r.key);
  if (!isObj(r) || !str(r.label, 80)) err(`${p}.label`, 'Role label is required (max 80 characters)');
 });

 const statuses = c.statuses === undefined ? DEFAULT_STATUSES : c.statuses;
 const statusKeys = new Set<string>();
 if (!Array.isArray(statuses) || !statuses.length || statuses.length > 10) err('statuses', 'Provide 1–10 statuses (or omit for the defaults)');
 else {
  statuses.forEach((s, i) => {
   const p = `statuses[${i}]`;
   if (!isObj(s) || !KEY_RE.test(String(s.key))) err(`${p}.key`, 'Status key must be lower-case letters, digits and hyphens');
   else if (statusKeys.has(s.key)) err(`${p}.key`, `Duplicate status key "${s.key}"`); else statusKeys.add(s.key);
   if (!isObj(s) || !str(s.label, 40)) err(`${p}.label`, 'Status label is required (max 40 characters)');
   if (!isObj(s) || !['pass', 'fail', 'info', 'blocked'].includes(String(s.kind))) err(`${p}.kind`, 'kind must be pass, fail, info or blocked');
   if (isObj(s) && s.needsReference !== undefined && !(s.needsReference in REFERENCE_PATTERNS)) err(`${p}.needsReference`, 'needsReference must be "number" or "url"');
  });
  if (!statuses.some(s => isObj(s) && s.kind === 'pass')) err('statuses', 'At least one status must have kind "pass"');
 }

 const phaseKeys = new Set<string>();
 (c.phases ?? []).forEach((p, i) => {
  if (!isObj(p) || !KEY_RE.test(String(p.key))) err(`phases[${i}].key`, 'Phase key must be lower-case letters, digits and hyphens');
  else if (phaseKeys.has(p.key)) err(`phases[${i}].key`, `Duplicate phase key "${p.key}"`); else phaseKeys.add(p.key);
  if (!isObj(p) || !str(p.label, 80)) err(`phases[${i}].label`, 'Phase label is required');
  if (!isObj(p) || !Number.isInteger(p.offsetDays) || p.offsetDays < 0 || p.offsetDays > 365) err(`phases[${i}].offsetDays`, 'offsetDays must be an integer 0–365');
 });

 const fixtures = new Map<string, Set<string>>(); const sharedFixtures = new Set<string>();
 if ((c.fixtures?.length ?? 0) > LIMITS.fixtures) err('fixtures', `At most ${LIMITS.fixtures} fixtures`);
 (c.fixtures ?? []).forEach((f, i) => {
  const p = `fixtures[${i}]`;
  if (!isObj(f) || !KEY_RE.test(String(f.key))) { err(`${p}.key`, 'Fixture key must be lower-case letters, digits and hyphens'); return; }
  if (fixtures.has(f.key)) { err(`${p}.key`, `Duplicate fixture key "${f.key}"`); return; }
  if (!str(f.label, 80)) err(`${p}.label`, 'Fixture label is required');
  if (!['run', 'tester', 'shared'].includes(f.scope)) err(`${p}.scope`, 'scope must be run, tester or shared');
  if (f.scope === 'shared') sharedFixtures.add(f.key);
  const keys = new Set<string>();
  if (!Array.isArray(f.fields) || !f.fields.length || f.fields.length > LIMITS.fields) { err(`${p}.fields`, `Provide 1–${LIMITS.fields} fields`); fixtures.set(f.key, keys); return; }
  f.fields.forEach((fl, j) => {
   if (!isObj(fl) || !FIELD_RE.test(String(fl.key))) err(`${p}.fields[${j}].key`, 'Field key must start with a lower-case letter and contain letters, digits or underscores');
   else if (keys.has(fl.key)) err(`${p}.fields[${j}].key`, `Duplicate field key "${fl.key}"`); else keys.add(fl.key);
  });
  const captureKeys = new Set<string>();
  (f.captures ?? []).forEach((cp, j) => {
   if (!isObj(cp) || !FIELD_RE.test(String(cp.key)) || !str(cp.label, 80)) err(`${p}.captures[${j}]`, 'Capture needs a field-style key and a label');
   else if (keys.has(cp.key) || captureKeys.has(cp.key)) err(`${p}.captures[${j}].key`, `Duplicate key "${cp.key}"`); else captureKeys.add(cp.key);
  });
  fixtures.set(f.key, new Set([...keys, ...captureKeys]));
  const graph = new Map<string, string[]>();
  f.fields.forEach((fl, j) => {
   if (!isObj(fl)) return;
   const fp = `${p}.fields[${j}]`;
   if (!str(fl.label, 80)) err(`${fp}.label`, 'Field label is required');
   if (fl.phase !== undefined && !phaseKeys.has(fl.phase)) err(`${fp}.phase`, `Unknown phase "${fl.phase}"`);
   const refs = validateRule(fl.rule, `${fp}.rule`, keys, phaseKeys, issues);
   graph.set(fl.key, refs);
  });
  const cycle = findCycle(graph);
  if (cycle) err(`${p}.fields`, `Circular field reference: ${cycle.join(' → ')}`);
 });
 if (sharedFixtures.size && c.fixtures?.some(f => f.scope === 'shared' && f.fields?.some(fl => fl.rule && JSON.stringify(fl.rule).includes('"created"')))) warn('fixtures', 'Shared fixtures using the "created" date anchor take the producer\'s creation date');

 const handoffKeys = new Set<string>();
 (c.handoffs ?? []).forEach((h, i) => {
  const p = `handoffs[${i}]`;
  if (!isObj(h) || !KEY_RE.test(String(h.key))) err(`${p}.key`, 'Handoff key must be lower-case letters, digits and hyphens');
  else if (handoffKeys.has(h.key)) err(`${p}.key`, `Duplicate handoff key "${h.key}"`); else handoffKeys.add(h.key);
  if (!isObj(h)) return;
  if (!str(h.label, 120)) err(`${p}.label`, 'Handoff label is required');
  if (!sharedFixtures.has(h.fixture)) err(`${p}.fixture`, `Handoff fixture "${String(h.fixture)}" must be an existing fixture with scope "shared"`);
  for (const k of ['producerRoles', 'consumerRoles'] as const) for (const r of h[k] ?? []) if (!roleKeys.has(r)) err(`${p}.${k}`, `Unknown role "${r}"`);
 });
 const hGraph = new Map<string, string[]>();
 (c.handoffs ?? []).forEach((h, i) => {
  if (!isObj(h)) return;
  for (const d of h.dependsOn ?? []) if (!handoffKeys.has(d)) err(`handoffs[${i}].dependsOn`, `Unknown handoff "${d}"`);
  hGraph.set(h.key, h.dependsOn ?? []);
 });
 const hc = findCycle(hGraph); if (hc) err('handoffs', `Circular handoff dependency: ${hc.join(' → ')}`);

 const docKeys = new Set<string>();
 (c.documents ?? []).forEach((d: DocDef, i) => {
  const p = `documents[${i}]`;
  if (!isObj(d) || !KEY_RE.test(String(d.key))) { err(`${p}.key`, 'Document key must be lower-case letters, digits and hyphens'); return; }
  if (docKeys.has(d.key)) err(`${p}.key`, `Duplicate document key "${d.key}"`); docKeys.add(d.key);
  if (!str(d.title, 120)) err(`${p}.title`, 'Document title is required');
  for (const r of d.roles ?? []) if (!roleKeys.has(r)) err(`${p}.roles`, `Unknown role "${r}"`);
  if (d.kind === 'upload') {
   const info = typeof d.documentId === 'string' ? docs.get(d.documentId) : undefined;
   if (!info) err(`${p}.documentId`, 'documentId does not match an uploaded document');
   else {
    if (info.status !== 'active') err(`${p}.documentId`, 'This uploaded document has been revoked');
    if (d.sha256 && d.sha256 !== info.sha256) err(`${p}.sha256`, 'sha256 does not match the uploaded document');
   }
  } else if (d.kind === 'generated') {
   const r = d.recipe;
   if (!isObj(r) || !str(r.title, 120) || !Array.isArray(r.rows) || !r.rows.length || r.rows.length > 60) err(`${p}.recipe`, 'recipe needs a title and 1–60 rows');
   else r.rows.forEach((row, j) => {
    if (!isObj(row) || !str(row.label, 80) || typeof row.value !== 'string' || row.value.length > 300) { err(`${p}.recipe.rows[${j}]`, 'Each row needs a label and a value (max 300 characters)'); return; }
    checkTokens(row.value, `${p}.recipe.rows[${j}].value`);
   });
   if (isObj(r)) for (const k of ['subtitle', 'footer'] as const) if (r[k] !== undefined) { if (typeof r[k] !== 'string' || (r[k] as string).length > 300) err(`${p}.recipe.${k}`, 'Max 300 characters'); else checkTokens(r[k] as string, `${p}.recipe.${k}`); }
  } else err(`${p}.kind`, 'kind must be upload or generated');
 });

 function checkTokens(value: string, path: string) {
  if (strayBraces(value)) err(path, 'Contains "{{" that is not a valid {{fixture.field}} token');
  for (const t of tokensIn(value)) {
   const fields = fixtures.get(t.fixture);
   if (!fields) err(path, `Unknown fixture "${t.fixture}" in {{${t.fixture}.${t.field}}}`);
   else if (!fields.has(t.field)) err(path, `Fixture "${t.fixture}" has no field "${t.field}"`);
  }
 }

 const stepIds = new Set<string>(), scenarioIds = new Set<string>(); let stepCount = 0;
 const usedRoles = new Set<string>();
 if (!Array.isArray(c.scenarios) || !c.scenarios.length) err('scenarios', 'At least one scenario is required');
 else if (c.scenarios.length > LIMITS.scenarios) err('scenarios', `At most ${LIMITS.scenarios} scenarios`);
 else c.scenarios.forEach((s, i) => {
  const p = `scenarios[${i}]`;
  if (!isObj(s) || !ID_RE.test(String(s.id))) err(`${p}.id`, 'Scenario id must be letters, digits, dot, dash or underscore (max 40)');
  else if (scenarioIds.has(s.id)) err(`${p}.id`, `Duplicate scenario id "${s.id}"`); else scenarioIds.add(s.id);
  if (!isObj(s)) return;
  if (!str(s.title, 160)) err(`${p}.title`, 'Scenario title is required');
  if (s.before !== undefined) { if (typeof s.before !== 'string' || s.before.length > 4000) err(`${p}.before`, 'Max 4000 characters'); else checkTokens(s.before, `${p}.before`); }
  if (!Array.isArray(s.steps) || !s.steps.length) { err(`${p}.steps`, 'A scenario needs at least one step'); return; }
  s.steps.forEach((st, j) => {
   const sp = `${p}.steps[${j}]`; stepCount++;
   if (!isObj(st) || !ID_RE.test(String(st.id))) err(`${sp}.id`, 'Step id must be letters, digits, dot, dash or underscore (max 40)');
   else if (stepIds.has(st.id)) err(`${sp}.id`, `Duplicate step id "${st.id}"`); else stepIds.add(st.id);
   if (!isObj(st)) return;
   if (!str(st.text, 4000)) err(`${sp}.text`, 'Step instructions are required (max 4000 characters)'); else checkTokens(st.text, `${sp}.text`);
   if (st.expect === undefined || st.expect === '') warn(`${sp}.expect`, 'No expected result');
   else if (typeof st.expect !== 'string' || st.expect.length > 2000) err(`${sp}.expect`, 'Expected result max 2000 characters'); else checkTokens(st.expect, `${sp}.expect`);
   if (!Array.isArray(st.roles) || !st.roles.length) err(`${sp}.roles`, 'Assign the step to at least one role');
   else for (const r of st.roles) { if (!roleKeys.has(r)) err(`${sp}.roles`, `Unknown role "${r}"`); usedRoles.add(r); }
   if (st.phase !== undefined && !phaseKeys.has(st.phase)) err(`${sp}.phase`, `Unknown phase "${st.phase}"`);
   for (const h of st.requires ?? []) if (!handoffKeys.has(h)) err(`${sp}.requires`, `Unknown handoff "${h}"`);
   for (const d of st.docs ?? []) if (!docKeys.has(d)) err(`${sp}.docs`, `Unknown document "${d}"`);
   const sharedUsed = new Set(tokensIn(`${st.text} ${st.expect ?? ''}`).map(t => t.fixture).filter(f => sharedFixtures.has(f)));
   for (const f of sharedUsed) if (!(st.requires ?? []).some(h => c.handoffs?.find(x => x.key === h)?.fixture === f)) warn(`${sp}.requires`, `Step uses shared fixture "${f}" but does not require its handoff`);
  });
 });
 if (stepCount > LIMITS.steps) err('scenarios', `At most ${LIMITS.steps} steps`);
 for (const r of roleKeys) if (!usedRoles.has(r)) warn('roles', `Role "${r}" has no steps`);
 return { issues, content: issues.some(i => i.level === 'error') ? null : c };
}

export const assignedSteps = (c: Content, role: string) => c.scenarios.flatMap(sc => sc.steps.filter(s => s.roles.includes(role)));
export const visibleScenarios = (c: Content, role: string) =>
 c.scenarios.map(sc => ({ ...sc, steps: sc.steps.filter(s => s.roles.includes(role)) })).filter(sc => sc.steps.length);

export function canonicalize(content: Content): string { return JSON.stringify(content, (_k, v) => isObj(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v); }

// Structural diff between two content versions: used for the publish change comparison.
export function diffContent(a: Content | null, b: Content) {
 const index = (c: Content | null) => new Map((c?.scenarios ?? []).flatMap(sc => sc.steps.map(s => [s.id, JSON.stringify(s)] as const)));
 const x = index(a), y = index(b);
 const added = [...y.keys()].filter(k => !x.has(k)), removed = [...x.keys()].filter(k => !y.has(k));
 const changed = [...y.keys()].filter(k => x.has(k) && x.get(k) !== y.get(k));
 const keysOf = (c: Content | null, f: 'roles' | 'fixtures' | 'handoffs' | 'documents') => new Set(((c?.[f] ?? []) as { key: string }[]).map(i => i.key));
 const sets = Object.fromEntries((['roles', 'fixtures', 'handoffs', 'documents'] as const).map(f => {
  const p = keysOf(a, f), n = keysOf(b, f);
  return [f, { added: [...n].filter(k => !p.has(k)), removed: [...p].filter(k => !n.has(k)) }];
 }));
 return { steps: { added, removed, changed }, ...sets };
}

export type { Rule };
