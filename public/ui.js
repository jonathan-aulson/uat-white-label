export const $ = id => document.getElementById(id);
export function el(tag, text, className, attrs) {
 const n = document.createElement(tag);
 if (text !== undefined && text !== null) n.textContent = String(text);
 if (className) n.className = className;
 if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
 return n;
}
export function button(text, action, className = '', attrs) {
 const b = el('button', text, className, attrs); b.type = 'button'; b.onclick = action; return b;
}
export function field(label, input, help) {
 const wrap = el('label', undefined, 'field'); wrap.append(el('span', label, 'field-label'), input);
 if (help) wrap.append(el('span', help, 'help')); return wrap;
}
export function input(value = '', attrs = {}) { const i = el('input'); i.value = value; for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v); return i; }
export function select(options, value) {
 const s = el('select'); for (const [v, l] of options) { const o = el('option', l ?? v); o.value = v; s.append(o); } if (value !== undefined) s.value = value; return s;
}
let participantId = null;
export async function api(path, method = 'GET', value, raw) {
 let res;
 try {
  const headers = {}; let body;
  if (participantId && !['GET', 'HEAD'].includes(method)) headers['X-UAT-Participant'] = participantId;
  if (raw) { headers['Content-Type'] = raw.type; body = raw.body; } else if (value !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(value); }
  res = await fetch(path, { method, headers, body, cache: 'no-store' });
 } catch { const e = new Error('Not saved – offline or unreachable'); e.status = 0; throw e; }
 if (res.status === 401) { const e = new Error('Your session has expired. Reload the page to sign in again.'); e.status = 401; throw e; }
 const type = res.headers.get('content-type') || '';
 const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
 if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; e.data = data; throw e; }
 return data;
}
let msgTimer;
export function show(message, kind = 'error') {
 const m = $('message'); m.textContent = message; m.hidden = !message; m.className = 'msg ' + kind;
 clearTimeout(msgTimer); if (message && kind !== 'error') msgTimer = setTimeout(() => { m.hidden = true; }, 4000);
}
export const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { show(e.message); } };
export function table(headers, rows) {
 const t = el('table'); const head = el('thead'), tr = el('tr');
 headers.forEach(h => tr.append(el('th', h, undefined, { scope: 'col' }))); head.append(tr); t.append(head);
 const body = el('tbody');
 for (const row of rows) { const r = el('tr'); for (const v of row) { const c = el('td'); c.append(v instanceof Node ? v : document.createTextNode(String(v ?? ''))); r.append(c); } body.append(r); }
 t.append(body); const wrap = el('div', undefined, 'table-wrap'); wrap.append(t); return wrap;
}
export function copyChip(label, value) {
 const wrap = el('div', undefined, 'chip'); wrap.append(el('span', label, 'chip-label'), el('code', value));
 const b = button('Copy', async () => {
  try { await navigator.clipboard.writeText(value); toast('Copied'); }
  catch { let i = wrap.querySelector('input'); if (!i) { i = input(value, { readonly: '', 'aria-label': `Copy ${label} manually` }); wrap.append(i); } i.focus(); i.select(); }
 }, 'small', { 'aria-label': 'Copy ' + label });
 wrap.append(b); return wrap;
}
export function toast(text) {
 let t = $('toast'); if (!t) { t = el('div', undefined, 'toast', { role: 'status' }); t.id = 'toast'; document.body.append(t); }
 t.textContent = text; clearTimeout(toast.t); toast.t = setTimeout(() => { t.textContent = ''; }, 2000);
}
export function confirmDialog(message) { return window.confirm(message); }
export async function loadShell(admin) {
 const bootstrap = await api('/api/participants');
 let me;
 if (bootstrap.openAccess && (admin || !bootstrap.selectedId)) {
  me = { openAccess: true, canAdmin: true, selected: false, participantId: null, displayName: admin ? 'Open-access admin (unverified)' : '',
   workspace: bootstrap.workspace };
 } else {
  try { me = await api('/api/me'); }
  catch (e) {
   if (!bootstrap.openAccess || e.data?.code !== 'selection_required') throw e;
   me = { openAccess: true, canAdmin: true, selected: false, participantId: null, workspace: bootstrap.workspace };
   show(e.message);
  }
 }
 participantId = me.participantId || null;
 const ws = me.workspace;
 document.title = ws.project_name + (admin ? ' – admin' : '');
 $('product').textContent = ws.project_name;
 const logo = $('logo'); if (ws.has_logo) { logo.src = '/brand/logo?v=' + ws.branding_revision; logo.onload = () => { logo.hidden = false; }; logo.onerror = () => { logo.hidden = true; }; } else logo.hidden = true;
 const nav = $('nav'); nav.replaceChildren();
 const a = (href, text) => { const x = el('a', text); x.href = href; return x; };
 nav.append(a('/', 'My testing'));
 if (me.isAdmin || me.canAdmin) nav.append(a('/admin', 'Admin'));
 for (const l of ws.links) { const x = a(l.url, l.label); x.target = '_blank'; x.rel = 'noopener noreferrer'; nav.append(x); }
 if (me.openAccess) {
  nav.append(el('span', 'Open access — identities are not verified.', 'badge warn'));
  if (admin) nav.append(el('span', 'Open-access admin (unverified)', 'who'));
  else if (me.selected) {
   const label = bootstrap.participants.find(p => p.id === me.participantId)?.label || 'Tester';
   nav.append(el('span', label, 'who'), button('Change tester', () => window.dispatchEvent(new Event('change-tester')), 'small'));
  }
 } else nav.append(el('span', me.displayName || me.email, 'who'));
 return me;
}
export async function chooseTester(main) {
 const data = await api('/api/participants');
 main.replaceChildren(el('h2', 'Choose a tester'), el('p', 'Select your name to keep your progress and feedback together. This does not verify your identity.', 'help'));
 if (data.selectionError) main.append(el('p', data.selectionError, 'warn'));
 if (!data.participants.length) {
  const link = el('a', 'Add testers in Admin → Roster'); link.href = '/admin#roster';
  main.append(el('p', 'No active testers are available yet.', 'card'), link);
  return;
 }
 const picker = select([['', 'Choose your name…'], ...data.participants.map(p => [p.id, p.label])], '');
 main.append(field('Tester', picker), button('Continue', safe(async () => {
  if (!picker.value) throw new Error('Choose a tester to continue.');
  await api('/api/participant', 'POST', { id: picker.value });
  location.reload();
 }), 'primary'));
}
export const fmtDate = s => s ? new Date(s).toLocaleString() : '';
