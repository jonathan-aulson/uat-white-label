import { api, button, el, field, fmtDate, input, select, show, table, safe } from './ui.js';

export async function rosterTab(main, _p, me) {
 main.append(el('h2', 'Roster'), el('p', 'Only people on this roster can sign in. Each gets a permanent two-digit code used in their test data. Removing someone deactivates them; their code is never reused.', 'help'));
 const email = input('', { type: 'email', 'aria-label': 'Email' }), name = input('', { 'aria-label': 'Name' }), role = select([['tester', 'Tester'], ['admin', 'Administrator']], 'tester');
 const form = el('div', undefined, 'card row'); form.append(field('Email', email), field('Name', name), field('Access', role),
  button('Add or reactivate', safe(async () => { await api('/api/admin/members', 'POST', { email: email.value, display_name: name.value, role: role.value }); email.value = name.value = ''; await draw(); }), 'primary'));
 const out = el('div'); main.append(form, out);
 async function draw() {
  const list = await api('/api/admin/members');
  out.replaceChildren(table(['Code', 'Email', 'Name', 'Access', 'Status', ''], list.map(m => [String(m.instance).padStart(2, '0'), m.email, m.display_name, m.role, m.active ? 'Active' : 'Inactive',
   (() => { const r = el('div', undefined, 'row');
    r.append(button(m.active ? 'Deactivate' : 'Reactivate', safe(async () => { await api('/api/admin/members/' + encodeURIComponent(m.email), 'PATCH', { active: !m.active }); await draw(); }), 'small'));
    r.append(button(m.role === 'admin' ? 'Make tester' : 'Make admin', safe(async () => { await api('/api/admin/members/' + encodeURIComponent(m.email), 'PATCH', { role: m.role === 'admin' ? 'tester' : 'admin' }); await draw(); }), 'small')); return r; })()])));
 }
 void me; await draw();
}

export async function campaignsTab(main, parts) {
 if (parts[0]) return campaignDetail(main, parts[0]);
 main.append(el('h2', 'Campaigns'));
 const releases = (await api('/api/admin/releases')).filter(r => r.status === 'published');
 const list = await api('/api/admin/campaigns');
 const form = el('section', undefined, 'card'); form.append(el('h3', 'New campaign'));
 if (!releases.length) form.append(el('p', 'Publish a release in the Content tab first.', 'help'));
 else {
  const name = input('', { maxlength: '100', 'aria-label': 'Name' }), rel = select(releases.map(r => [r.id, `#${r.seq} ${r.label}`]), releases[0].id), env = input('', { 'aria-label': 'Environment' }), build = input('', { 'aria-label': 'Build' }), start = input('', { type: 'date', 'aria-label': 'Starts on' });
  const row = el('div', undefined, 'row'); row.append(field('Name', name), field('Release', rel), field('Environment', env), field('Build or version', build), field('Starts on', start, 'Blank = today. Fixes dates in test data.'));
  form.append(row, button('Create campaign', safe(async () => { const r = await api('/api/admin/campaigns', 'POST', { name: name.value, release_id: rel.value, environment: env.value, build: build.value, ...(start.value ? { starts_on: start.value } : {}) }); location.hash = '#campaigns/' + r.id; }), 'primary'));
 }
 main.append(form, table(['Name', 'Release', 'Status', 'Invitees', 'Runs', ''], list.map(c => [c.name, `#${c.release_seq} ${c.release_label}`, c.status, c.invitees, c.runs, (() => { const a = el('a', 'Manage'); a.href = '#campaigns/' + c.id; return a; })()])));
}

async function campaignDetail(main, id) {
 const c = await api('/api/admin/campaigns/' + id); const members = (await api('/api/admin/members')).filter(m => m.active);
 const releases = (await api('/api/admin/releases')).filter(r => r.status === 'published');
 const back = el('a', '← All campaigns'); back.href = '#campaigns'; main.append(back, el('h2', c.name), el('p', `${c.status} · start ${c.starts_on} (${c.tz}) · release #${c.release.seq} ${c.release.label}`, 'state'));
 const det = el('section', undefined, 'card'); const name = input(c.name, { 'aria-label': 'Name' }), env = input(c.environment, { 'aria-label': 'Environment' }), build = input(c.build, { 'aria-label': 'Build' });
 const rel = select(releases.map(r => [r.id, `#${r.seq} ${r.label}`]), c.release_id);
 const r1 = el('div', undefined, 'row'); r1.append(field('Name', name), field('Environment', env), field('Build or version', build), field('Release for new runs', rel, 'Existing testers stay on the release they started with.'));
 det.append(el('h3', 'Details'), r1, el('p', Object.entries(c.phase_dates).map(([k, v]) => `${k}: ${v}`).join(' · '), 'state'));
 const rowB = el('div', undefined, 'row'); rowB.append(button('Save', safe(async () => { await api('/api/admin/campaigns/' + id, 'PUT', { name: name.value, environment: env.value, build: build.value, release_id: rel.value }); show('Saved', 'ok'); }), 'primary'),
  button(c.status === 'open' ? 'Close campaign' : 'Reopen', safe(async () => { await api(`/api/admin/campaigns/${id}/${c.status === 'open' ? 'close' : 'reopen'}`, 'POST', {}); route(); })));
 if (c.status === 'closed') rowB.append(button('Purge tester data…', safe(async () => { const v = window.prompt(`This permanently deletes all tester results, feedback and test data for this campaign. Type the campaign name (“${c.name}”) to confirm.`); if (v === null) return; await api(`/api/admin/campaigns/${id}/purge`, 'POST', { confirm: v }); show('Purged', 'ok'); }), 'danger'));
 det.append(rowB); main.append(det);

 const inv = el('section', undefined, 'card'); inv.append(el('h3', 'Invited testers'), el('p', 'Choose who tests which role.', 'help'));
 const state = new Map(c.invites.map(i => [i.email, new Set(i.roles)]));
 const grid = el('div'); inv.append(grid);
 function drawInv() {
  grid.replaceChildren(...members.filter(m => m.role !== 'admin' || state.has(m.email) || true).map(m => {
   const row = el('div', undefined, 'row'); row.append(el('strong', m.display_name || m.email, 'name-col'), el('span', m.email, 'state'));
   for (const r of c.roles) { const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!state.get(m.email)?.has(r.key); cb.onchange = () => { const s = state.get(m.email) || new Set(); cb.checked ? s.add(r.key) : s.delete(r.key); s.size ? state.set(m.email, s) : state.delete(m.email); }; const l = el('label'); l.append(cb, ' ' + r.label); row.append(l); }
   return row;
  }));
 }
 drawInv();
 inv.append(button('Save invitations', safe(async () => { await api(`/api/admin/campaigns/${id}/invites`, 'PUT', { invites: [...state].map(([email, roles]) => ({ email, roles: [...roles] })) }); show('Invitations saved', 'ok'); route(); }), 'primary'));
 main.append(inv);

 if (c.handoff_defs.length) {
  const ho = el('section', undefined, 'card'); ho.append(el('h3', 'Handoffs'), el('p', 'Who produces each shared record and who consumes it.', 'help'));
  const invited = c.invites; const bindings = new Map();
  for (const h of c.handoffs) { const b = bindings.get(h.handoff_key) || { producer: h.producer_email, consumers: [] }; b.consumers.push(h.consumer_email); bindings.set(h.handoff_key, b); }
  const sels = [];
  for (const d of c.handoff_defs) {
   const b = bindings.get(d.key) || { producer: '', consumers: [] };
   const prod = select([['', '— choose —'], ...invited.map(i => [i.email, i.display_name || i.email])], b.producer);
   const cons = select([['', '— choose —'], ...invited.map(i => [i.email, i.display_name || i.email])], b.consumers[0] || ''); cons.multiple = true; cons.size = Math.min(5, invited.length + 1);
   for (const o of cons.options) o.selected = b.consumers.includes(o.value);
   sels.push([d.key, prod, cons]);
   const row = el('div', undefined, 'row'); row.append(el('strong', d.label), field('Producer', prod), field('Consumers', cons)); ho.append(row);
  }
  ho.append(button('Save handoffs', safe(async () => {
   const bindings = sels.map(([key, p, cs]) => ({ key, producer: p.value, consumers: [...cs.selectedOptions].map(o => o.value).filter(Boolean) })).filter(b => b.producer && b.consumers.length);
   await api(`/api/admin/campaigns/${id}/handoffs`, 'PUT', { bindings }); show('Handoffs saved', 'ok'); route();
  }), 'primary'));
  if (c.handoffs.length) ho.append(table(['Handoff', 'Producer', 'Consumer', 'Status', 'Overrides', ''], c.handoffs.map(h => [c.handoff_defs.find(d => d.key === h.handoff_key)?.label || h.handoff_key, h.producer_email, h.consumer_email, h.status, h.overrides,
   (() => { const r = el('div', undefined, 'row'); r.append(button('Override…', safe(async () => { const reason = window.prompt('Reason for letting the consumer proceed without the producer (recorded in the audit log):'); if (!reason) return; await api(`/api/admin/handoffs/${h.id}/override`, 'POST', { reason }); show('Override recorded', 'ok'); route(); }), 'small'), button('Reset', safe(async () => { if (!window.confirm('Reset this handoff to pending?')) return; await api(`/api/admin/handoffs/${h.id}/reset`, 'POST', {}); route(); }), 'small')); return r; })()])));
  main.append(ho);
 }
 function route() { window.dispatchEvent(new HashChangeEvent('hashchange')); }
}
void fmtDate;
