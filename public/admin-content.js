import { api, button, el, field, fmtDate, input, select, show, table, safe } from './ui.js';

const redraw = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const issueList = issues => { const ul = el('ul', undefined, 'issues'); for (const i of issues) ul.append(el('li', `${i.level.toUpperCase()}: ${i.path ? i.path + ' – ' : ''}${i.message}`, i.level === 'error' ? 'issue error' : 'issue')); return issues.length ? ul : el('p', 'No validation issues.', 'state'); };

export async function contentTab(main, parts) {
 if (parts[0]) return editor(main, parts[0]);
 main.append(el('h2', 'Content'), el('p', 'Releases hold the roles, scenarios, steps and test data. Published releases are immutable; edit a copy to change them.', 'help'));
 const [list, examples] = await Promise.all([api('/api/admin/releases'), api('/api/admin/examples')]);
 const label = input('', { 'aria-label': 'Label', placeholder: 'e.g. Spring 2025', maxlength: '80' });
 const src = select([...examples.map(e => ['ex:' + e.key, 'Example: ' + e.label]), ...list.map(r => ['rel:' + r.id, `Copy of #${r.seq ?? 'draft'} ${r.label}`]), ['csv', 'Import from CSV…']], 'ex:' + (examples[0]?.key ?? ''));
 const csv = el('textarea', '', 'json', { 'aria-label': 'CSV', placeholder: 'Paste CSV', hidden: '' }); const file = input('', { type: 'file', accept: '.csv,text/csv', hidden: '', 'aria-label': 'CSV file' });
 file.onchange = async () => { csv.value = await file.files[0].text(); };
 src.onchange = () => { csv.hidden = file.hidden = src.value !== 'csv'; };
 const form = el('section', undefined, 'card'); form.append(el('h3', 'New draft'), el('div', undefined, 'row'));
 form.children[1].append(field('Label', label), field('Start from', src));
 form.append(file, csv, button('Create draft', safe(async () => {
  const body = { label: label.value || 'Draft' }; if (src.value === 'csv') body.csv = csv.value; else body.from = src.value.slice(src.value.indexOf(':') + 1);
  const r = await api('/api/admin/releases', 'POST', body); location.hash = '#content/' + r.id;
 }), 'primary'));
 main.append(form, table(['#', 'Label', 'Status', 'Updated', ''], list.map(r => [r.seq ?? '—', r.label, r.status, fmtDate(r.updated_at), (() => { const a = el('a', r.status === 'draft' ? 'Edit' : 'View'); a.href = '#content/' + r.id; return a; })()])));
}

async function editor(main, id) {
 const r = await api('/api/admin/releases/' + id); const draft = r.status === 'draft';
 const back = el('a', '← All releases'); back.href = '#content'; main.append(back, el('h2', `${r.label} (${r.status}${r.seq ? ' #' + r.seq : ''})`));
 const ta = el('textarea', JSON.stringify(r.content, null, 2), 'json', { 'aria-label': 'Release content JSON', spellcheck: 'false' }); ta.readOnly = !draft; ta.style.minHeight = '28rem';
 const out = el('div'); const bar = el('div', undefined, 'row');
 const parse = () => { try { return JSON.parse(ta.value); } catch (e) { throw new Error('Not valid JSON: ' + e.message); } };
 if (draft) {
  const lbl = input(r.label, { 'aria-label': 'Label', maxlength: '80' });
  bar.append(field('Label', lbl), button('Save draft', safe(async () => { const x = await api('/api/admin/releases/' + id, 'PUT', { label: lbl.value, content: parse() }); out.replaceChildren(issueList(x.issues)); show('Saved', 'ok'); }), 'primary'),
   button('Validate', safe(async () => { out.replaceChildren(issueList((await api(`/api/admin/releases/${id}/validate`, 'POST', { content: parse() })).issues)); })),
   button('Publish…', safe(async () => { if (!window.confirm('Publishing freezes this release permanently. Continue?')) return; await api('/api/admin/releases/' + id, 'PUT', { label: lbl.value, content: parse() }); const x = await api(`/api/admin/releases/${id}/publish`, 'POST', {}); show('Published as #' + x.seq, 'ok'); redraw(); }), 'primary'),
   button('Delete draft', safe(async () => { if (!window.confirm('Delete this draft?')) return; await api('/api/admin/releases/' + id, 'DELETE'); location.hash = '#content'; }), 'danger'));
 } else {
  bar.append(button('Make an editable copy', safe(async () => { const x = await api('/api/admin/releases', 'POST', { from: id, label: r.label + ' (copy)' }); location.hash = '#content/' + x.id; }), 'primary'));
  if (r.status === 'published') bar.append(button('Retire', safe(async () => { await api(`/api/admin/releases/${id}/retire`, 'POST', {}); redraw(); })));
 }
 const roleSel = select(r.content.roles.map(x => [x.key, x.label]));
 const pv = el('div'); bar.append(roleSel, button('Preview as role', safe(async () => {
  const p = await api(`/api/admin/releases/${id}/preview?role=${encodeURIComponent(roleSel.value)}`); pv.replaceChildren(el('h3', 'Preview'), el('pre', JSON.stringify(p, null, 2), 'json'));
 })), button('Diff vs previous', safe(async () => { const d = await api(`/api/admin/releases/${id}/diff` + (r.base_release_id ? '?against=' + r.base_release_id : '')); pv.replaceChildren(el('h3', 'Changes' + (d.against ? ' vs ' + d.against : '')), el('pre', JSON.stringify(d.diff, null, 2), 'json')); })));
 const exp = el('a', 'Export JSON'); exp.href = `/api/admin/releases/${id}/export`; bar.append(exp);
 main.append(bar, ta, out, issueList(r.issues || []), pv);
}
