export interface Env {
 DB: D1Database; ASSETS: Fetcher; DOCS?: R2Bucket;
 DEPLOYMENT_ID: string; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; BOOTSTRAP_ADMINS: string; ALLOWED_DOMAINS?: string;
 ADO_PAT?: string; DEV_AUTH_BYPASS?: string;
}
export interface Identity { sub: string; email: string; isAdmin: boolean; instance: number; displayName: string }

export interface Role { key: string; label: string; description?: string }
export type StatusKind = 'pass' | 'fail' | 'info' | 'blocked';
export interface StatusDef { key: string; label: string; kind: StatusKind; needsNote?: boolean; needsReference?: 'number' | 'url' }
export interface Phase { key: string; label: string; offsetDays: number }
export type Rule =
 | { type: 'literal'; value: string }
 | { type: 'namespace' }
 | { type: 'instance'; pad?: number }
 | { type: 'concat'; parts: Rule[] }
 | { type: 'ref'; field: string }
 | { type: 'int'; min: number; max: number; pad?: number }
 | { type: 'pick'; items: string[] }
 | { type: 'date'; anchor: string; offsetDays?: number; weekday?: number; format?: 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD/MM/YYYY' };
export interface FixtureField { key: string; label: string; rule: Rule; phase?: string }
export type Scope = 'run' | 'tester' | 'shared';
export interface Fixture { key: string; label: string; scope: Scope; description?: string; fields: FixtureField[]; captures?: { key: string; label: string }[] }
export interface Handoff { key: string; label: string; fixture: string; producerRoles?: string[]; consumerRoles?: string[]; dependsOn?: string[] }
export interface Recipe { title: string; subtitle?: string; rows: { label: string; value: string }[]; footer?: string }
export interface DocDef { key: string; title: string; kind: 'upload' | 'generated'; roles?: string[]; documentId?: string; sha256?: string; recipe?: Recipe }
export interface Step { id: string; text: string; expect: string; roles: string[]; phase?: string; requires?: string[]; docs?: string[] }
export interface Scenario { id: string; title: string; goal?: string; before?: string; steps: Step[] }
export interface Content {
 schema: 1; title: string; roles: Role[]; statuses?: StatusDef[]; phases?: Phase[]; fixtures?: Fixture[];
 handoffs?: Handoff[]; documents?: DocDef[]; scenarios: Scenario[];
}
export interface ReleaseRow { id: string; seq: number | null; label: string; status: 'draft' | 'published' | 'retired'; content: string; content_sha: string | null; base_release_id: string | null; created_by: string; created_at: string; updated_at: string; published_by: string | null; published_at: string | null }
export interface CampaignRow { id: string; name: string; environment: string; build: string; status: 'open' | 'closed'; release_id: string; starts_on: string; ends_on: string | null; tz: string; phase_dates: string; notes: string; created_by: string; created_at: string; closed_at: string | null }
export interface Run { id: string; owner_sub: string; owner_email: string; campaign_id: string; release_id: string; role: string; build: string; environment: string; created_at: string; archived: number; fixture_generation: number }
export interface ResultRow { run_id: string; step_id: string; status: string | null; note: string; rev: number; updated_at: string; triage: string; ado_id: number | null; ado_claim_at?: string | null; admin_note: string; redacted: number; blocked_by_override?: string | null }
export interface Feedback { id: string; run_id: string; owner_sub: string; text: string; created_at: string; triage: string; ado_id: number | null; admin_note: string; redacted: number }
export interface Workspace {
 project_name: string; support_text: string; privacy_notice: string; namespace: string; links: { label: string; url: string }[];
 primary: string; accent: string; background: string; font: 'system' | 'roboto' | 'roboto-baskerville'; branding_revision: number;
 ado_org_url: string; ado_project: string; ado_area_path: string; ado_work_item_type: string; ado_repro_field: string; ado_tags: string;
 ado_severity_field: string; ado_priority_field: string; timezone: string;
}
