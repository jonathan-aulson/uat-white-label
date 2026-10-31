import { $, api, button, el, loadShell, safe, show, confirmDialog } from './ui.js';
import { mountRun } from './runview.js';

let me, stop;
async function home() {
 if (stop) { stop(); stop = null; } $('saveState').textContent = ''; show('');
 const main = $('main'); main.replaceChildren(el('h2', 'My testing'));
 const campaigns = await api('/api/campaigns');
 if (!campaigns.length) { main.append(el('p', 'You have not been assigned to a test campaign yet. Contact the administrator.', 'card')); return; }
 for (const c of campaigns) {
  const card = el('section', undefined, 'card'); card.append(el('h3', c.name));
  card.append(el('p', `${c.environment || ''}${c.build ? ' · build ' + c.build : ''} · release ${c.release.label}${c.status === 'closed' ? ' · closed' : ''}`, 'state'));
  for (const role of c.roles) {
   const run = c.runs.find(r => r.role === role.key); const row = el('div', undefined, 'row');
   row.append(el('strong', role.label), el('span', `${run ? run.completed : 0} of ${role.steps} steps recorded`, 'state'));
   const open = id => { location.hash = '#run=' + id; };
   if (run) row.append(button(c.status === 'open' ? 'Resume' : 'View', () => open(run.id), 'primary'));
   else if (c.status === 'open') row.append(button('Start', safe(async () => open((await api(`/api/campaigns/${c.id}/runs`, 'POST', { role: role.key })).run.id)), 'primary'));
   if (run && c.status === 'open') row.append(button('Start over with new values', safe(async () => {
    if (!confirmDialog('Start over? Your current results are archived and you receive a new set of test values.')) return;
    open((await api(`/api/campaigns/${c.id}/runs`, 'POST', { role: role.key, reset: true })).run.id);
   }), 'small'));
   card.append(row); if (role.description) card.append(el('p', role.description, 'help'));
  }
  main.append(card);
 }
}
async function route() {
 const m = location.hash.match(/^#run=(.+)$/);
 try {
  if (stop) { stop(); stop = null; }
  if (m) { const main = $('main'); main.replaceChildren(); main.append(button('← All campaigns', () => { location.hash = ''; }, 'small')); const box = el('div'); main.append(box); stop = mountRun(box, decodeURIComponent(m[1]), { base: '/api/runs', email: me.email }); }
  else await home();
 } catch (e) { show(e.message); }
}
(async () => {
 try {
  me = await loadShell(false);
  const n = $('notice'); if (me.workspace.privacy_notice) { n.textContent = me.workspace.privacy_notice; n.hidden = false; }
  if (me.workspace.support_text) { const s = el('p', me.workspace.support_text, 'help'); s.style.textAlign = 'center'; n.after(s); }
  window.addEventListener('hashchange', route); route();
 } catch (e) {
  show(e.status === 403 ? e.message : e.message || 'Could not load');
  $('main').replaceChildren(el('p', e.status === 403 ? 'Access to this workspace is by invitation only.' : '', 'card'));
 }
})();
