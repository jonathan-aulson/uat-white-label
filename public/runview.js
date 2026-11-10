import { $, api, button, copyChip, el, field, fmtDate, input, safe, show } from './ui.js';

const TOKEN = /\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;
const SYMBOL = { pass: '✓', fail: '✗', info: '?', blocked: '⏸' };
const KIND_HINT = { pass: 'passed', fail: 'issue', info: 'question or info', blocked: 'blocked' };

function values(fixtures) {
 const m = new Map();
 for (const f of fixtures) {
  for (const x of f.fields) if (x.value !== null) m.set(`${f.key}.${x.key}`, x.value);
  for (const c of f.captures) if (c.value !== null) m.set(`${f.key}.${c.key}`, c.value);
 }
 return m;
}
// Renders text with {{fixture.field}} tokens as highlighted values using DOM nodes only (never HTML).
export function renderRich(parent, template, vals) {
 let last = 0; template.replace(TOKEN, (m, f, k, offset) => {
  parent.append(document.createTextNode(template.slice(last, offset)));
  const v = vals.get(`${f}.${k}`);
  parent.append(v === undefined ? el('span', 'not available yet', 'badge warn') : el('code', v, 'val'));
  last = offset + m.length; return m;
 });
 parent.append(document.createTextNode(template.slice(last)));
 return parent;
}

export function mountRun(container, runId, opts) {
 const readonly = !!opts.readonly; const base = opts.base;
 const outboxKey = 'uat-outbox:' + runId;
 let data, timer, stopped = false; const draft = new Map(); const conflicts = new Map(); const inflight = new Map(); const warnings = new Map(); const openState = new Map();
 const outbox = () => { try { return JSON.parse(localStorage.getItem(outboxKey) || '{}'); } catch { return {}; } };
 const putOutbox = o => { try { Object.keys(o).length ? localStorage.setItem(outboxKey, JSON.stringify(o)) : localStorage.removeItem(outboxKey); } catch { /* storage unavailable */ } };
 const results = () => new Map(data.results.map(r => [r.step_id, r]));
 const statusMap = () => new Map(data.content.statuses.map(s => [s.key, s]));

 function setState(text, cls = '') { const s = $('saveState'); if (!s) return; s.textContent = text; s.className = 'savestate ' + cls; }
 function refreshState() {
  const pend = Object.keys(outbox()).length + [...inflight.values()].filter(Boolean).length + conflicts.size;
  if (conflicts.size) setState('Conflict: choose which version to keep', 'error');
  else if (Object.keys(outbox()).length) setState('Not saved – retrying when you are back online', 'error');
  else if (pend) setState('Saving…', 'pending'); else setState(data && data.results.length ? 'All changes saved' : '');
 }
 async function load(keepScroll) {
  const y = window.scrollY;
  data = await api(base + '/' + encodeURIComponent(runId));
  if (stopped) return;
  render(); if (keepScroll) window.scrollTo(0, y);
 }

 async function saveStep(stepId) {
  if (readonly || stopped) return;
  const d = draft.get(stepId); if (!d) return;
  if (inflight.get(stepId)) { inflight.set(stepId, 'again'); return; }
  const def = statusMap().get(d.status);
  if (d.status && def?.needsNote && !d.note.trim()) { warnings.set(stepId, 'Add a note to save this status.'); refreshWarn(stepId); return; }
  warnings.delete(stepId); refreshWarn(stepId);
  inflight.set(stepId, true); refreshState();
  const current = results().get(stepId);
  try {
   const r = await api(`${base}/${encodeURIComponent(runId)}/results/${encodeURIComponent(stepId)}`, 'PUT', { status: d.status, note: d.note, rev: current ? current.rev : 0 });
   const row = { run_id: runId, step_id: stepId, status: d.status, note: d.note, rev: r.rev, updated_at: r.updated_at, triage: 'New', ado_id: null, redacted: 0 };
   data.results = [...data.results.filter(x => x.step_id !== stepId), row];
   if (draft.get(stepId) === d) draft.delete(stepId);
   const o = outbox(); delete o[stepId]; putOutbox(o); conflicts.delete(stepId);
  } catch (e) {
   if (e.status === 0) { const o = outbox(); o[stepId] = d; putOutbox(o); }
   else if (e.status === 409 && e.data?.server !== undefined && !e.data.code) {
    if (e.data.locked) { warnings.set(stepId, 'This result is locked because an administrator has triaged it. Contact the admin to change it.'); draft.delete(stepId); data.results = [...data.results.filter(x => x.step_id !== stepId), ...(e.data.server ? [e.data.server] : [])]; }
    else conflicts.set(stepId, { mine: { ...d }, server: e.data.server });
    const o = outbox(); delete o[stepId]; putOutbox(o);
   } else { warnings.set(stepId, e.message); draft.delete(stepId); const o = outbox(); delete o[stepId]; putOutbox(o); await load(true).catch(() => {}); }
  } finally {
   const again = inflight.get(stepId) === 'again'; inflight.delete(stepId);
   if (again && !stopped && !conflicts.has(stepId)) await saveStep(stepId);
  }
  if (!stopped) { renderStep(stepId); refreshState(); }
 }
 function refreshWarn(stepId) { const w = container.querySelector(`[data-step="${CSS.escape(stepId)}"] .warn`); if (w) w.textContent = warnings.get(stepId) || ''; }
 const timers = new Map();
 function edit(stepId, patch, immediate) {
  const cur = draft.get(stepId) || (() => { const r = results().get(stepId); return { status: r?.status ?? null, note: r?.note ?? '' }; })();
  draft.set(stepId, { ...cur, ...patch });
  clearTimeout(timers.get(stepId));
  if (immediate) saveStep(stepId); else timers.set(stepId, setTimeout(() => saveStep(stepId), 900));
  refreshState();
 }
 async function retryOutbox() {
  if (stopped) return;
  const o = outbox(); for (const [stepId, d] of Object.entries(o)) { if (!draft.has(stepId)) draft.set(stepId, d); await saveStep(stepId); }
 }

 // Step rendering
 const stepLookup = () => new Map(data.content.scenarios.flatMap(s => s.steps.map(st => [st.id, st])));
 function locks(step) {
  const phase = step.phase ? data.content.phases.find(p => p.key === step.phase) : null;
  const phaseLocked = phase && !phase.available;
  const unmet = (step.requires || []).filter(key => {
   const h = data.handoffs.find(x => x.key === key && x.as === 'consumer');
   return h && h.status !== 'acknowledged' && !h.overridden;
  }).map(key => (data.handoffs.find(x => x.key === key) || {}).label || key);
  return { phaseLocked, phase, unmet };
 }
 function stepNode(step, vals) {
  const r = results().get(step.id); const d = draft.get(step.id) || { status: r?.status ?? null, note: r?.note ?? '' };
  const node = el('div', undefined, 'step', { 'data-step': step.id });
  const head = el('p'); head.append(el('strong', step.id + ' '), renderRich(el('span'), step.text, vals)); node.append(head);
  if (step.expect) { const p = el('p', undefined, 'expect'); p.append(el('em', 'Expected: '), renderRich(el('span'), step.expect, vals)); node.append(p); }
  const { phaseLocked, phase, unmet } = locks(step);
  if (phaseLocked) { node.append(el('p', `Available from ${phase.date}.`, 'badge warn')); }
  const locked = readonly || r?.triage && r.triage !== 'New' || r?.ado_id || r?.redacted;
  const sb = el('div', undefined, 'statuses', { role: 'group', 'aria-label': 'Result for ' + step.id });
  for (const s of data.content.statuses) {
   const disabled = locked || phaseLocked || (s.kind === 'pass' && unmet.length > 0);
   const b = button(`${SYMBOL[s.kind]} ${s.label}`, () => edit(step.id, { status: d.status === s.key ? null : s.key }, true), 'status-' + s.kind, { 'aria-pressed': String(d.status === s.key), title: KIND_HINT[s.kind] });
   b.disabled = !!disabled; sb.append(b);
  }
  node.append(sb);
  if (unmet.length) node.append(el('p', `Waiting for handoff: ${unmet.join(', ')}. You can record Blocked in the meantime.`, 'state'));
  const def = statusMap().get(d.status);
  const ta = el('textarea', undefined, 'step-note', { 'aria-label': 'Notes for ' + step.id, maxlength: '4000', placeholder: def?.needsNote ? 'Required: describe what you saw' + (def.needsReference ? (def.needsReference === 'url' ? ' (include a link)' : ' (include a reference number)') : '') : 'Notes (optional)' });
  ta.value = r?.redacted ? '[redacted by administrator]' : d.note; ta.disabled = !!locked; ta.oninput = () => edit(step.id, { note: ta.value }, false); ta.onblur = () => { clearTimeout(timers.get(step.id)); if (draft.has(step.id)) saveStep(step.id); };
  node.append(ta);
  node.append(el('p', warnings.get(step.id) || '', 'warn state', { role: 'status' }));
  if (r?.triage && r.triage !== 'New') node.append(el('span', `Triage: ${r.triage}`, 'badge'));
  if (r?.ado_id) node.append(el('span', ` Work item #${r.ado_id}`, 'badge good'));
  const c = conflicts.get(step.id);
  if (c) {
   const box = el('div', undefined, 'conflict', { role: 'alert' });
   box.append(el('p', 'This step was changed on another device.'), el('p', `Server: ${c.server?.status ?? 'no status'} — ${c.server?.note || '(no note)'}`), el('p', `Yours: ${c.mine.status ?? 'no status'} — ${c.mine.note || '(no note)'}`));
   box.append(button('Keep mine', () => { data.results = [...data.results.filter(x => x.step_id !== step.id), ...(c.server ? [c.server] : [])]; conflicts.delete(step.id); draft.set(step.id, c.mine); saveStep(step.id); }, 'small'), ' ',
    button('Use server version', () => { data.results = [...data.results.filter(x => x.step_id !== step.id), ...(c.server ? [c.server] : [])]; conflicts.delete(step.id); draft.delete(step.id); renderStep(step.id); refreshState(); }, 'small'));
   node.append(box);
  }
  if ((step.docs || []).length) {
   const p = el('p');
   for (const key of step.docs) { const doc = data.content.documents.find(x => x.key === key); if (!doc) continue; p.append(docLink(doc), ' '); }
   node.append(p);
  }
  return node;
 }
 const docLink = doc => {
  if (doc.removed) return el('span', `${doc.title} (removed by administrator)`, 'badge bad');
  const a = el('a', '📄 ' + doc.title); a.href = `/api/runs/${encodeURIComponent(runId)}/documents/${encodeURIComponent(doc.key)}`; a.download = ''; return a;
 };
 function renderStep(stepId) {
  const old = container.querySelector(`[data-step="${CSS.escape(stepId)}"]`); if (!old) return;
  const step = stepLookup().get(stepId); const hadFocus = old.contains(document.activeElement); const pos = hadFocus ? document.activeElement.selectionStart : 0;
  const fresh = stepNode(step, values(data.fixtures)); old.replaceWith(fresh);
  if (hadFocus) { const ta = fresh.querySelector('textarea'); ta && !ta.disabled && (ta.focus(), ta.setSelectionRange(pos, pos)); }
  updateSummary();
 }
 function updateSummary() {
  const total = data.content.scenarios.reduce((n, s) => n + s.steps.length, 0); const rec = data.results.filter(r => r.status).length;
  const kinds = statusMap(); const pass = data.results.filter(r => r.status && kinds.get(r.status)?.kind === 'pass').length;
  const bar = container.querySelector('.progress>span'); if (bar) bar.style.width = total ? `${Math.round(rec / total * 100)}%` : '0';
  const t = container.querySelector('.summary-text'); if (t) t.textContent = `${rec} of ${total} steps recorded · ${pass} passing`;
 }

 function dataCard() {
  const card = el('section', undefined, 'card', { 'aria-labelledby': 'data-h' }); card.append(el('h3', 'Your test data', undefined, { id: 'data-h' }));
  card.append(el('p', data.workspace_privacy || 'Use exactly these synthetic values.', 'help'));
  if (!data.fixtures.length) { card.append(el('p', 'No test data is needed for your role.', 'state')); return card; }
  for (const f of data.fixtures) {
   const box = el('div'); box.append(el('h4', f.label)); if (f.description) box.append(el('p', f.description, 'help'));
   if (f.state === 'waiting') box.append(el('p', 'Waiting for the other tester to confirm this record is ready.', 'badge warn'));
   else if (f.state === 'unassigned') box.append(el('p', 'No tester has been assigned to this shared record yet. Ask the administrator.', 'badge warn'));
   else {
    for (const x of f.fields) box.append(x.value !== null ? copyChip(x.label, x.value) : el('span', `${x.label}: available later`, 'badge'));
    for (const c of f.captures) {
     if (f.scope === 'shared' && f.owner !== opts.email && !readonly) { if (c.value) box.append(copyChip(c.label, c.value)); continue; }
     if (readonly) { if (c.value) box.append(copyChip(c.label, c.value)); continue; }
     const i = input(c.value || '', { maxlength: '64', 'aria-label': c.label, pattern: '[A-Za-z0-9._ #-]*' });
     const save = button('Save', safe(async () => { await api(`${base}/${encodeURIComponent(runId)}/fixtures/${encodeURIComponent(f.key)}/captured`, 'PUT', { values: { [c.key]: i.value.trim() } }); show('Saved', 'ok'); await load(true); }), 'small');
     box.append(field(c.label + ' (record the value shown by the application)', i), save);
    }
   }
   card.append(box);
  }
  return card;
 }
 function handoffCard() {
  if (!data.handoffs.length) return null;
  const card = el('section', undefined, 'card', { 'aria-labelledby': 'ho-h' }); card.append(el('h3', 'Handoffs', undefined, { id: 'ho-h' }));
  for (const h of data.handoffs) {
   const row = el('div', undefined, 'row'); row.append(el('strong', h.label), el('span', h.as === 'producer' ? `→ ${h.counterpart}` : `← ${h.counterpart}`, 'state'));
   row.append(el('span', h.status === 'pending' ? 'Pending' : h.status === 'ready' ? 'Ready' : 'Acknowledged', 'badge ' + (h.status === 'acknowledged' ? 'good' : 'warn')));
   if (h.overridden) row.append(el('span', 'Admin override', 'badge'));
   if (h.record_ref) row.append(el('span', 'Ref: ' + h.record_ref, 'state'));
   if (!readonly && h.as === 'producer') {
    const ref = input(h.record_ref || '', { maxlength: '64', 'aria-label': 'Record reference (optional)', placeholder: 'Record reference (optional)' });
    row.append(ref, button(h.status === 'pending' ? 'Confirm record is ready' : 'Update reference', safe(async () => { await api(`/api/handoffs/${h.id}/ready`, 'POST', { recordRef: ref.value.trim() }); await load(true); })));
   }
   if (!readonly && h.as === 'consumer' && h.status === 'ready') row.append(button('Acknowledge – I can see it', safe(async () => { await api(`/api/handoffs/${h.id}/acknowledge`, 'POST', {}); await load(true); }), 'primary'));
   card.append(row);
  }
  return card;
 }
 function docsCard() {
  const docs = data.content.documents; if (!docs.length) return null;
  const card = el('section', undefined, 'card', { 'aria-labelledby': 'doc-h' }); card.append(el('h3', 'Documents', undefined, { id: 'doc-h' }));
  const ul = el('ul'); for (const d of docs) { const li = el('li'); li.append(docLink(d), d.kind === 'generated' ? ' (generated from your values)' : ''); ul.append(li); }
  card.append(ul); return card;
 }
 function feedbackCard() {
  const card = el('section', undefined, 'card', { 'aria-labelledby': 'fb-h' }); card.append(el('h3', 'General feedback', undefined, { id: 'fb-h' }));
  const list = el('ul'); for (const f of data.feedback) { const li = el('li', f.redacted ? '[redacted by administrator]' : f.text); list.append(li); } card.append(list);
  if (readonly) return card;
  const ta = el('textarea', undefined, undefined, { 'aria-label': 'General feedback', maxlength: '4000', placeholder: 'Anything that is not tied to a single step' });
  card.append(ta, button('Send feedback', safe(async () => {
   if (!ta.value.trim()) return;
   await api(`${base}/${encodeURIComponent(runId)}/feedback`, 'POST', { id: crypto.randomUUID(), text: ta.value.trim() }); ta.value = ''; show('Feedback sent', 'ok'); await load(true);
  })));
  return card;
 }
 function render() {
  for (const d of container.querySelectorAll('details.scenario')) openState.set(d.dataset.id, d.open);
  const vals = values(data.fixtures);
  const root = el('div'); const c = data.campaign;
  const head = el('div', undefined, 'card');
  head.append(el('h2', data.content.title), el('p', `${c.name}${c.environment ? ' · ' + c.environment : ''}${c.build ? ' · build ' + c.build : ''} · release ${data.release.label} · role ${data.content.roles.find(r => r.key === data.run.role)?.label || data.run.role}`, 'state'));
  if (c.status !== 'open') head.append(el('p', 'This campaign is closed. Results are read-only.', 'badge warn'));
  if (readonly) head.append(el('p', `Read-only administrator view · tester ${data.run.owner_email}`, 'badge'));
  head.append(el('p', undefined, 'summary-text'), el('div', undefined, 'progress'));
  head.querySelector('.progress').append(el('span'));
  root.append(head, dataCard());
  for (const x of [handoffCard(), docsCard()]) if (x) root.append(x);
  for (const sc of data.content.scenarios) {
   const d = el('details', undefined, 'scenario', { 'data-id': sc.id }); d.open = openState.has(sc.id) ? openState.get(sc.id) : true;
   d.append(el('summary', `${sc.id}: ${sc.title}`));
   const body = el('div', undefined, 'step');
   if (sc.goal) body.append(el('p', 'Goal: ' + sc.goal, 'help'));
   if (sc.before) body.append(renderRich(el('p'), sc.before, vals));
   if (body.childNodes.length) d.append(body);
   for (const st of sc.steps) d.append(stepNode(st, vals));
   root.append(d);
  }
  root.append(feedbackCard());
  container.replaceChildren(root); updateSummary(); refreshState();
 }
 const tick = () => { if (stopped || document.hidden || container.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return; if (draft.size || inflight.size || conflicts.size) return; load(true).catch(e => { if (!stopped) show(e.message); }); };
 const visible = () => { if (!document.hidden) tick(); };
 (async () => {
  try { await load(false); await retryOutbox(); }
  catch (e) {
   if (!stopped) show(e.status === 404 && opts.openAccess ? 'This run belongs to another tester or is no longer available. Return to My testing or change tester.' : e.message);
  }
  if (stopped) return;
  timer = setInterval(tick, 30000);
  window.addEventListener('online', retryOutbox); document.addEventListener('visibilitychange', visible);
 })();
 return () => {
  stopped = true; clearInterval(timer);
  for (const timeout of timers.values()) clearTimeout(timeout);
  window.removeEventListener('online', retryOutbox); document.removeEventListener('visibilitychange', visible);
 };
}
export { fmtDate };
