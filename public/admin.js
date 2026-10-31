import { $, api, el, loadShell, button, safe, show } from './ui.js';
import { mountRun } from './runview.js';
import { progressTab, findingsTab } from './admin-findings.js';
import { contentTab } from './admin-content.js';
import { campaignsTab, rosterTab } from './admin-campaigns.js';
import { brandingTab, documentsTab, settingsTab, auditTab } from './admin-settings.js';

const TABS = [['progress', 'Progress', progressTab], ['findings', 'Findings', findingsTab], ['content', 'Content', contentTab], ['campaigns', 'Campaigns', campaignsTab],
 ['roster', 'Roster', rosterTab], ['branding', 'Branding', brandingTab], ['documents', 'Documents', documentsTab], ['settings', 'Settings & ADO', settingsTab], ['audit', 'Audit', auditTab]];
let me, stop;

async function route() {
 if (stop) { stop(); stop = null; } show('');
 const hash = location.hash.replace(/^#/, ''); const main = $('main');
 const run = hash.match(/^run=(.+)$/);
 const key = run ? 'findings' : (TABS.find(t => t[0] === hash.split('/')[0]) || TABS[0])[0];
 const tabs = $('tabs'); tabs.replaceChildren();
 for (const [k, label] of TABS) { const b = button(label, () => { location.hash = '#' + k; }, 'tab', { role: 'tab', 'aria-selected': String(k === key) }); tabs.append(b); }
 try {
  if (run) {
   main.replaceChildren(button('← Back to findings', () => { location.hash = '#findings'; }, 'small')); const box = el('div'); main.append(box);
   stop = mountRun(box, decodeURIComponent(run[1]), { base: '/api/admin/runs', readonly: true, email: me.email });
  } else { main.replaceChildren(); await TABS.find(t => t[0] === key)[2](main, hash.split('/').slice(1), me); }
 } catch (e) { show(e.message); }
}
(async () => {
 try { me = await loadShell(true); } catch (e) { show(e.message); return; }
 if (!me.isAdmin) { $('main').replaceChildren(el('p', 'Administrator access is required.', 'card')); return; }
 window.addEventListener('hashchange', route); route();
})();
export { safe, api };
