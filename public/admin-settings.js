import { api, button, el, field, fmtDate, input, select, show, table, safe } from './ui.js';

export async function settingsTab(main) {
 const { settings: s, ado_pat_configured, deployment_id, bootstrap_admins } = await api('/api/admin/settings');
 main.append(el('h2', 'Settings & Azure DevOps'));
 const f = {}; const mk = (k, label, attrs = {}, help) => { f[k] = input(s[k] ?? '', { maxlength: '300', ...attrs }); return field(label, f[k], help); };
 const ws = el('section', undefined, 'card'); ws.append(el('h3', 'Workspace'), mk('project_name', 'Product name'), mk('support_text', 'Support text'), mk('privacy_notice', 'Privacy notice shown to testers'), mk('namespace', 'Test-data name prefix', {}, 'Letters, digits, spaces; max 20.'), mk('timezone', 'Time zone (IANA)', {}, 'e.g. America/Chicago'));
 f.links = el('textarea', (s.links || []).map(l => `${l.label} | ${l.url}`).join('\n'), 'json', { 'aria-label': 'Links', placeholder: 'Label | https://…  (one per line)' });
 ws.append(field('Links', f.links, 'One per line: Label | https://url'));
 const ado = el('section', undefined, 'card'); ado.append(el('h3', 'Azure DevOps'), el('p', ado_pat_configured ? 'PAT secret: configured on this deployment.' : 'PAT secret: not set. Set the ADO_PAT secret with wrangler.', 'state'),
  mk('ado_org_url', 'Organization URL', {}, 'https://dev.azure.com/<org>'), mk('ado_project', 'Project'), mk('ado_area_path', 'Area path'), mk('ado_work_item_type', 'Work item type'), mk('ado_tags', 'Tags'), mk('ado_repro_field', 'Repro field'), mk('ado_severity_field', 'Severity field'), mk('ado_priority_field', 'Priority field'));
 const save = safe(async () => {
  const body = {}; for (const [k, i] of Object.entries(f)) if (k !== 'links') body[k] = i.value;
  body.links = f.links.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [label, ...u] = l.split('|'); return { label: label.trim(), url: u.join('|').trim() }; });
  await api('/api/admin/settings', 'PUT', body); show('Settings saved', 'ok');
 });
 const res = el('p', '', 'state');
 main.append(ws, ado, el('div', undefined, 'row'), res);
 main.children[main.children.length - 2].append(button('Save settings', save, 'primary'), button('Test ADO connection', safe(async () => { await save(); const r = await api('/api/admin/settings/ado-test', 'POST', {}); res.textContent = JSON.stringify(r); })));
 main.append(el('p', `Deployment ID: ${deployment_id}. Bootstrap admins: ${bootstrap_admins.join(', ') || 'none'}.`, 'help'));
}

export async function brandingTab(main) {
 const b = await api('/api/admin/branding');
 main.append(el('h2', 'Branding'), el('p', 'Use your approved brand colours. Contrast checks are advisory: valid colours can always be saved without changing your palette.', 'help'));
 const c = {}; const row = el('div', undefined, 'card row'); const out = el('div');
 for (const k of ['primary', 'accent', 'background']) { c[k] = input(b[k], { type: 'color', 'aria-label': k }); row.append(field(k[0].toUpperCase() + k.slice(1), c[k])); }
 const font = select([['system', 'System'], ['roboto', 'Roboto'], ['roboto-baskerville', 'Roboto + Baskerville']], b.font); row.append(field('Font', font));
 const vals = () => ({ primary: c.primary.value, accent: c.accent.value, background: c.background.value });
 const showCheck = ck => {
  const nodes = [];
  if (Object.keys(ck.ratios).length) nodes.push(el('p', 'Contrast ratios: ' + Object.entries(ck.ratios).map(([k, v]) => `${k} ${Number(v).toFixed(2)}:1`).join(', '), 'state'));
  for (const [issues, className] of [[ck.errors, 'issue error'], [ck.warnings || [], 'issue warn']]) {
   if (!issues.length) continue;
   const list = el('ul');
   for (const issue of issues) list.append(el('li', `${issue.field}: ${issue.message}${issue.suggestion ? ' Optional alternative: ' + issue.suggestion : ''}`, className));
   nodes.push(list);
  }
  out.replaceChildren(...nodes);
 };
 let checkVersion = 0;
 const live = safe(async () => {
  const version = ++checkVersion;
  const check = await api('/api/admin/branding/check', 'POST', vals());
  if (version === checkVersion) showCheck(check);
 });
 for (const i of Object.values(c)) i.oninput = live;
 row.append(button('Save colours', safe(async () => {
  const version = ++checkVersion;
  try {
   const saved = await api('/api/admin/branding', 'PUT', { ...vals(), font: font.value });
   if (version === checkVersion) showCheck(saved.check);
   show(saved.check.warnings.length ? 'Brand colours saved. Contrast warnings are advisory; your palette was not changed.' : 'Brand colours saved.', 'ok');
  } catch (e) { if (version === checkVersion && e.data?.check) showCheck(e.data.check); throw e; }
 }), 'primary'));
 main.append(row, out); showCheck(b.check);
 for (const kind of ['logo', 'favicon']) {
  const has = b.assets.find(a => a.kind === kind); const card = el('section', undefined, 'card'); const f = input('', { type: 'file', accept: 'image/png,image/jpeg', 'aria-label': kind + ' file' });
  card.append(el('h3', kind === 'logo' ? 'Logo' : 'Favicon (square)'), el('p', has ? `Current: ${has.width}×${has.height} ${has.mime}` : 'Using the default.', 'state'), f,
   button('Upload', safe(async () => { const file = f.files[0]; if (!file) throw new Error('Choose a PNG or JPEG file'); await api('/api/admin/branding/' + kind, 'PUT', undefined, { type: file.type, body: await file.arrayBuffer() }); show('Uploaded', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); }), 'primary'));
  if (has) card.append(button('Remove', safe(async () => { await api('/api/admin/branding/' + kind, 'DELETE'); window.dispatchEvent(new HashChangeEvent('hashchange')); })));
  main.append(card);
 }
 main.append(el('h3', 'Revisions'), table(['When', 'By'], b.revisions.map(r => [fmtDate(r.ts), r.actor_sub])));
}

export async function documentsTab(main) {
 const d = await api('/api/admin/documents'); main.append(el('h2', 'Documents'));
 if (!d.enabled) { main.append(el('p', 'Document storage (R2) is not enabled on this deployment.', 'card')); return; }
 const title = input('', { maxlength: '120', 'aria-label': 'Title' }), aud = input('', { 'aria-label': 'Audience roles', placeholder: 'role keys, comma-separated (blank = all)' }), file = input('', { type: 'file', accept: 'application/pdf', 'aria-label': 'PDF file' });
 const cb = el('input'); cb.type = 'checkbox'; const l = el('label', undefined, 'field'); l.append(cb, ' I attest this file contains only synthetic or generic data');
 const uploadInfo = el('div', undefined, 'state', { role: 'status' });
 const form = el('section', undefined, 'card'); form.append(el('h3', 'Upload PDF'), el('p', 'PDFs are kept unchanged, including web links and internal navigation. Link destinations are not verified. Scripts, executable actions and embedded files are not allowed.', 'help'), field('Title', title), field('Audience', aud), file, l,
  button('Upload', safe(async () => {
   const f = file.files[0]; if (!f) throw new Error('Choose a PDF');
   const uploaded = await api(`/api/admin/documents?title=${encodeURIComponent(title.value)}&audience=${encodeURIComponent(aud.value)}&attested=${cb.checked ? 1 : 0}&filename=${encodeURIComponent(f.name)}`, 'POST', undefined, { type: 'application/pdf', body: await f.arrayBuffer() });
   title.value = aud.value = file.value = ''; cb.checked = false;
   uploadInfo.replaceChildren(el('p', 'Uploaded unchanged; links are preserved.'), ...(uploaded.warnings || []).map(w => el('p', w, 'warn')));
   await drawDocuments();
  }), 'primary'), uploadInfo);
 const documentList = el('div');
 const drawDocuments = async () => {
  const { documents } = await api('/api/admin/documents');
  documentList.replaceChildren(table(['Title', 'Id', 'Status', 'Size', 'Uploaded', ''], documents.map(x => [x.title, x.id, x.status, Math.round(x.size / 1024) + ' KB', fmtDate(x.created_at),
   (() => { const r = el('div', undefined, 'row'); const a = el('a', 'Download'); a.href = `/api/admin/documents/${x.id}/download`; r.append(a); if (x.status !== 'revoked') r.append(button('Revoke', safe(async () => { await api(`/api/admin/documents/${x.id}/revoke`, 'POST', {}); await drawDocuments(); }), 'small danger')); return r; })()])));
 };
 main.append(form, documentList,
  el('p', 'Reference a document from a step using its Id in the release content.', 'help'));
 await drawDocuments();
}

export async function auditTab(main) {
 main.append(el('h2', 'Audit log'), table(['When', 'Actor', 'Action', 'Target', 'Detail'], (await api('/api/admin/audit')).map(a => [fmtDate(a.ts), a.actor_sub, a.action, a.target, a.detail])));
}
