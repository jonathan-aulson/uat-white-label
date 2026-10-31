import { api, button, el, field, fmtDate, input, select, show, table, safe } from './ui.js';

export async function progressTab(main) {
 const campaigns = await api('/api/admin/campaigns');
 main.append(el('h2', 'Progress'));
 if (!campaigns.length) { main.append(el('p', 'No campaigns yet. Create one in the Campaigns tab.', 'card')); return; }
 const sel = select(campaigns.map(c => [c.id, `${c.name}${c.status === 'closed' ? ' (closed)' : ''}`]), campaigns[0].id);
 const out = el('div'); main.append(field('Campaign', sel), out);
 async function draw() {
  const rows = await api(`/api/admin/campaigns/${sel.value}/progress`);
  const exp = el('p'); for (const [label, path] of [['Export all results (CSV)', 'results'], ['Export findings (CSV)', 'findings']]) { const a = el('a', label); a.href = `/api/admin/export/${path}.csv?campaign=${sel.value}`; exp.append(a, ' · '); }
  out.replaceChildren(exp, el('p', 'Recorded counts every step with a status. Passing counts only steps whose status means “pass”.', 'help'),
   table(['Tester', 'Code', 'Role', 'Recorded', 'Passing', 'Issues', 'Blocked', 'Last activity', ''], rows.map(r => [r.name, String(r.instance).padStart(2, '0'), r.role,
    r.run_id ? `${r.recorded}/${r.total}` : 'Not started', r.run_id ? r.passing : '', r.run_id ? r.issues : '', r.run_id ? r.blocked : '', r.last_activity ? fmtDate(r.last_activity) : '',
    r.run_id ? (() => { const a = el('a', 'View'); a.href = '#run=' + r.run_id; return a; })() : ''])));
 }
 sel.onchange = safe(draw); await draw();
}

export async function findingsTab(main) {
 main.append(el('h2', 'Findings'));
 const campaigns = await api('/api/admin/campaigns');
 const sel = select([['', 'All campaigns'], ...campaigns.map(c => [c.id, c.name])], '');
 const triageFilter = select([['', 'Any triage'], ...['New', 'Accepted', 'Duplicate', 'Not a defect', 'Fixed - retest', 'Closed'].map(t => [t])], 'New');
 const out = el('div'); main.append(el('div', undefined, 'row'), out); main.firstChild.nextSibling.append(field('Campaign', sel), field('Triage', triageFilter));
 const TRIAGES = ['New', 'Accepted', 'Duplicate', 'Not a defect', 'Fixed - retest', 'Closed'];
 async function draw() {
  const list = (await api('/api/admin/findings' + (sel.value ? '?campaign=' + sel.value : ''))).filter(f => !triageFilter.value || f.triage === triageFilter.value);
  if (!list.length) { out.replaceChildren(el('p', 'No findings match.', 'card')); return; }
  out.replaceChildren(...list.map(f => {
   const card = el('section', undefined, 'card'); const head = el('div', undefined, 'row spread');
   head.append(el('strong', f.kind === 'result' ? `${f.step_id} · ${f.scenario}` : 'General feedback'), el('span', f.status, 'badge' + (f.status_kind === 'fail' ? ' bad' : f.status_kind === 'blocked' ? ' warn' : '')));
   card.append(head, el('p', `${f.owner_email} · ${f.role} · ${f.campaign} · ${fmtDate(f.at)}`, 'state'), el('p', f.note || '(no note)'));
   const t = select(TRIAGES.map(x => [x]), f.triage); const note = input(f.admin_note, { 'aria-label': 'Admin note', placeholder: 'Admin note (internal)', maxlength: '1000' });
   const row = el('div', undefined, 'row'); row.append(t, note, button('Save triage', safe(async () => { await api(`/api/admin/findings/${f.kind}/${encodeURIComponent(f.id)}`, 'PATCH', { triage: t.value, admin_note: note.value }); show('Saved', 'ok'); })));
   if (f.ado_id) { const a = el('a', `Open bug #${f.ado_id}`); if (f.ado_url) a.href = f.ado_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a); }
   else if (!f.redacted) { row.append(button('Create bug…', safe(() => adoDialog(f, draw)))); row.append(button('Link existing…', safe(async () => { const v = window.prompt('Existing Azure DevOps work item ID'); if (!v) return; await api(`/api/admin/findings/${f.kind}/${encodeURIComponent(f.id)}/link-ado`, 'POST', { ado_id: Number(v) }); await draw(); }), 'small')); }
   if (!f.redacted) row.append(button('Redact', safe(async () => { if (!window.confirm('Permanently hide this text everywhere (including history)?')) return; await api(`/api/admin/findings/${f.kind}/${encodeURIComponent(f.id)}/redact`, 'POST', {}); await draw(); }), 'small danger'));
   const view = el('a', 'Open run'); view.href = '#run=' + f.run_id; row.append(view);
   card.append(row); return card;
  }));
 }
 sel.onchange = triageFilter.onchange = safe(draw); await draw();
}

async function adoDialog(f, done) {
 const p = await api(`/api/admin/findings/${f.kind}/${encodeURIComponent(f.id)}/ado-preview`);
 if (!p.configured) throw new Error('Azure DevOps is not configured. Set the organization, project and server PAT in Settings & ADO.');
 const dlg = el('dialog', undefined, undefined, { 'aria-labelledby': 'bug-dialog-title' }); const title = input(p.title, { maxlength: '255' }); const repro = el('textarea', p.repro, 'json bug-repro', { maxlength: '32000' });
 const sev = select(['1 - Critical', '2 - High', '3 - Medium', '4 - Low'].map(x => [x]), p.severity); const pri = select([1, 2, 3, 4].map(x => [String(x)]), String(p.priority));
 const phi = el('input'); phi.type = 'checkbox'; const lbl = el('label', undefined, 'field'); lbl.append(phi, ' I confirm this contains no real personal, client or confidential information');
 const err = el('p', '', 'issue error', { role: 'alert' });
 dlg.append(el('h3', 'Create Azure DevOps bug', undefined, { id: 'bug-dialog-title' }), field('Title', title), field('Reproduction (review steps, expected and actual results)', repro, 'Keep the three result headings. Replace any ADMIN REQUIRED prompts. The ordered script is not a chronological activity log.'), el('div', undefined, 'row'), lbl, err);
 dlg.children[3].append(field('Severity', sev), field('Priority', pri));
 const row = el('div', undefined, 'row end');
 const cancel = button('Cancel', () => dlg.close());
 const create = button('Create bug', async () => {
  err.textContent = '';
  if (!phi.checked) { err.textContent = 'Confirm this contains no real personal, client or confidential information.'; return; }
  if (repro.value.includes('[ADMIN REQUIRED:')) { err.textContent = 'Replace all ADMIN REQUIRED prompts with the observed reproduction details.'; return; }
  create.disabled = cancel.disabled = true;
  try {
   const result = await api(`/api/admin/findings/${f.kind}/${encodeURIComponent(f.id)}/create-ado`, 'POST', { title: title.value, repro: repro.value, severity: sev.value, priority: Number(pri.value), confirmNoPhi: phi.checked });
   dlg.close(); show(`Bug #${result.ado_id} ${result.recovered ? 'recovered' : 'linked'}. Use Open bug to view it.`, 'ok'); await done();
  } catch (e) { err.textContent = e.message; }
  finally { create.disabled = cancel.disabled = false; }
 }, 'primary');
 dlg.oncancel = e => { if (create.disabled) e.preventDefault(); };
 row.append(cancel, create); dlg.append(row); dlg.onclose = () => dlg.remove(); document.body.append(dlg); dlg.showModal();
}
