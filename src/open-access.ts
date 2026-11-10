import type { Env, Identity } from './types';
import { all, body, first, HttpError, json, now, statement } from './db';
import { getWorkspace, publicWorkspace } from './settings';

export const isOpen = (env: Env) => env.OPEN_ACCESS === '1';
export const openAdmin: Identity = { sub: 'open:admin', email: 'open-admin@unverified.invalid', isAdmin: true, instance: 0, displayName: 'Open-access admin (unverified)' };
interface Member { email: string; display_name: string; instance: number }
const cookieName = (req: Request) => new URL(req.url).protocol === 'https:' ? '__Host-uat-participant' : 'uat-participant';
const cookie = (req: Request, id: string, age: number) => `${cookieName(req)}=${id}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}`;
function selectionResponse(req: Request, id: string, age: number) {
 const response = json({ ok: true, participantId: id || null });
 response.headers.set('Set-Cookie', cookie(req, id, age));
 return response;
}
const selectionRequired = (message = 'Choose a tester to continue.') => new HttpError(409, message, { code: 'selection_required' });
function selectedId(req: Request): string | undefined {
 const prefix = cookieName(req) + '=';
 return (req.headers.get('Cookie') ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length);
}
async function memberFor(env: Env, id: string | undefined): Promise<Member | null> {
 if (!id || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return null;
 return first<Member>(env, 'SELECT email,display_name,instance FROM members WHERE instance=? AND active=1', Number(id));
}
async function subjectFor(env: Env, member: Member) {
 const existing = await all<{ sub: string }>(env, 'SELECT sub FROM users WHERE email=?', member.email);
 if (existing.length > 1) throw new HttpError(409, 'This tester has multiple historical identities. Ask the administrator to resolve them before continuing.', { code: 'identity_ambiguous' });
 return existing[0]?.sub ?? `open:tester:${member.instance}`;
}
export async function openWorkspace(env: Env) {
 const workspace = await getWorkspace(env);
 return { ...publicWorkspace(workspace), has_logo: !!(await first(env, "SELECT 1 AS x FROM assets WHERE kind='logo'")) };
}
export async function selectionApi(req: Request, env: Env, path: string): Promise<Response | undefined> {
 if (path === '/api/participants' && req.method === 'GET') {
  if (!isOpen(env)) return json({ openAccess: false });
  const members = await all<Member>(env, 'SELECT email,display_name,instance FROM members WHERE active=1 ORDER BY instance');
  const label = (member: Member) => member.display_name || 'Tester';
  const participants = members.map(m => {
   const duplicate = !m.display_name || members.filter(other => label(other) === label(m)).length > 1;
   return { id: String(m.instance), label: `${label(m)}${duplicate ? ' #' + String(m.instance).padStart(2, '0') : ''}` };
  });
  const id = selectedId(req), selected = members.find(m => String(m.instance) === id);
  return json({ openAccess: true, participants, selectedId: selected ? id : null,
   selectionError: id !== undefined && !selected ? 'The selected tester is no longer available. Choose an active tester.' : null,
   workspace: await openWorkspace(env) });
 }
 if (!isOpen(env) || path !== '/api/participant' || !['POST', 'DELETE'].includes(req.method)) return;
 if (req.method === 'DELETE') return selectionResponse(req, '', 0);
 const data = await body(req);
 const member = await memberFor(env, typeof data.id === 'string' ? data.id : undefined);
 if (!member) throw new HttpError(400, 'Choose an active tester from the roster.');
 await subjectFor(env, member);
 return selectionResponse(req, String(member.instance), 30 * 86400);
}
export async function openIdentity(req: Request, env: Env): Promise<Identity> {
 const path = new URL(req.url).pathname;
 if (path.startsWith('/api/admin/')) return openAdmin;
 const id = selectedId(req);
 if (id === undefined && path === '/api/me' && req.method === 'GET')
  return { sub: 'open:unselected', email: '', isAdmin: false, instance: 0, displayName: '' };
 const member = await memberFor(env, id);
 if (!member) throw selectionRequired(id === undefined ? undefined : 'The selected tester is no longer available. Choose an active tester.');
 if (!['GET', 'HEAD'].includes(req.method) && req.headers.get('X-UAT-Participant') !== String(member.instance))
  throw new HttpError(409, 'The tester changed in another tab. Reload before continuing; this change was not saved.', { code: 'participant_changed' });
 const sub = await subjectFor(env, member), ts = now();
 await statement(env, `INSERT INTO users(sub,email,display_name,first_seen,last_seen) VALUES(?,?,?,?,?)
  ON CONFLICT(sub) DO UPDATE SET last_seen=excluded.last_seen WHERE users.last_seen <= ?`,
  sub, member.email, member.display_name, ts, ts, new Date(Date.now() - 900000).toISOString()).run();
 return { sub, email: member.email, isAdmin: false, instance: member.instance, displayName: member.display_name };
}
