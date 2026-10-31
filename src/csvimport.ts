import type { Content } from './types';
import { HttpError } from './db';

// RFC 4180-style parser (quoted fields, doubled quotes, embedded newlines).
export function parseCsv(input: string): string[][] {
 const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
 const s = input.replace(/^\uFEFF/, '');
 for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (quoted) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
  else if (c === '"') quoted = true;
  else if (c === ',') { row.push(cell); cell = ''; }
  else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(v => v !== '')) rows.push(row); row = []; }
  else cell += c;
 }
 row.push(cell); if (row.some(v => v !== '')) rows.push(row);
 return rows;
}
const COLS = ['scenario_id', 'scenario_title', 'step_id', 'instructions', 'expected', 'roles'];
// One flat sheet: formulas and macros are never evaluated; cells are plain text.
export function csvToContent(csv: string, title: string): Content {
 const rows = parseCsv(csv);
 if (rows.length < 2) throw new HttpError(400, 'CSV needs a header row and at least one step');
 const head = rows[0].map(h => h.trim().toLowerCase());
 const idx = Object.fromEntries(COLS.map(c => [c, head.indexOf(c)]));
 const missing = COLS.filter(c => idx[c] < 0);
 if (missing.length) throw new HttpError(400, `CSV is missing columns: ${missing.join(', ')}`);
 const roles = new Map<string, string>(); const scenarios = new Map<string, Content['scenarios'][number]>();
 rows.slice(1).forEach((r, n) => {
  const get = (c: string) => (r[idx[c]] ?? '').trim();
  const roleKeys = get('roles').split(/[;|]/).map(x => x.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean);
  if (!get('scenario_id') || !get('step_id')) throw new HttpError(400, `Row ${n + 2}: scenario_id and step_id are required`);
  for (const k of roleKeys) roles.set(k, k.split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' '));
  let sc = scenarios.get(get('scenario_id'));
  if (!sc) { sc = { id: get('scenario_id'), title: get('scenario_title') || get('scenario_id'), steps: [] }; scenarios.set(sc.id, sc); }
  sc.steps.push({ id: get('step_id'), text: get('instructions'), expect: get('expected'), roles: roleKeys });
 });
 return { schema: 1, title, roles: [...roles].map(([key, label]) => ({ key, label })), scenarios: [...scenarios.values()] };
}
