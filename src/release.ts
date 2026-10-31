import type { CampaignRow, Content, Env, ReleaseRow, Run } from './types';
import { first, HttpError } from './db';
import { getWorkspace } from './settings';

const cache = new Map<string, Content>();
// Published/retired content is immutable, so a parsed copy can be cached for the isolate's lifetime.
export async function loadRelease(env: Env, id: string): Promise<{ row: ReleaseRow; content: Content }> {
 const row = await first<ReleaseRow>(env, 'SELECT * FROM releases WHERE id=?', id);
 if (!row) throw new HttpError(404, 'Release not found');
 if (row.status !== 'draft' && cache.has(id)) return { row, content: cache.get(id)! };
 const content = JSON.parse(row.content) as Content;
 if (row.status !== 'draft') cache.set(id, content);
 return { row, content };
}
export async function loadCampaign(env: Env, id: string): Promise<CampaignRow> {
 const c = await first<CampaignRow>(env, 'SELECT * FROM campaigns WHERE id=?', id);
 if (!c) throw new HttpError(404, 'Campaign not found');
 return c;
}
export async function runContext(env: Env, run: Run) {
 const [campaign, release, workspace] = await Promise.all([loadCampaign(env, run.campaign_id), loadRelease(env, run.release_id), getWorkspace(env)]);
 return { campaign, release: release.row, content: release.content, workspace };
}
