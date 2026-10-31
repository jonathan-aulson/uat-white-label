PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE branding_revisions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_sub TEXT NOT NULL, snapshot TEXT NOT NULL
);
-- Sanitized logo/favicon, bounded to a few hundred KiB each by the API.
CREATE TABLE assets (
 kind TEXT PRIMARY KEY CHECK(kind IN ('logo','favicon')), mime TEXT NOT NULL, bytes BLOB NOT NULL,
 sha256 TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, updated_at TEXT NOT NULL
);

-- Members are never deleted, so a reserved instance number is never reused for another person.
CREATE TABLE members (
 email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('admin','tester')),
 display_name TEXT NOT NULL DEFAULT '', instance INTEGER NOT NULL UNIQUE,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), added_by TEXT NOT NULL, added_at TEXT NOT NULL
);
CREATE TABLE users (
 sub TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
);

CREATE TABLE releases (
 id TEXT PRIMARY KEY, seq INTEGER, label TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','published','retired')),
 content TEXT NOT NULL, content_sha TEXT, base_release_id TEXT,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 published_by TEXT, published_at TEXT
);
CREATE UNIQUE INDEX releases_seq ON releases(seq) WHERE seq IS NOT NULL;
CREATE TRIGGER releases_immutable BEFORE UPDATE OF content, label, content_sha, seq ON releases
 WHEN OLD.status != 'draft' BEGIN SELECT RAISE(ABORT, 'published releases are immutable'); END;
CREATE TRIGGER releases_no_delete BEFORE DELETE ON releases
 WHEN OLD.status != 'draft' BEGIN SELECT RAISE(ABORT, 'published releases cannot be deleted'); END;

CREATE TABLE campaigns (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, environment TEXT NOT NULL DEFAULT '', build TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 release_id TEXT NOT NULL REFERENCES releases(id),
 starts_on TEXT NOT NULL, ends_on TEXT, tz TEXT NOT NULL DEFAULT 'UTC',
 phase_dates TEXT NOT NULL DEFAULT '{}', notes TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT
);
CREATE TABLE campaign_invites (
 campaign_id TEXT NOT NULL REFERENCES campaigns(id), email TEXT NOT NULL REFERENCES members(email),
 roles TEXT NOT NULL DEFAULT '[]', invited_at TEXT NOT NULL,
 PRIMARY KEY (campaign_id, email)
);

CREATE TABLE runs (
 id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL REFERENCES users(sub), owner_email TEXT NOT NULL,
 campaign_id TEXT NOT NULL REFERENCES campaigns(id), release_id TEXT NOT NULL REFERENCES releases(id),
 role TEXT NOT NULL, build TEXT NOT NULL DEFAULT '', environment TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 fixture_generation INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX runs_owner ON runs(owner_sub);
CREATE INDEX runs_campaign ON runs(campaign_id);

CREATE TABLE results (
 run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL,
 status TEXT, note TEXT NOT NULL DEFAULT '', rev INTEGER NOT NULL, updated_at TEXT NOT NULL,
 triage TEXT NOT NULL DEFAULT 'New' CHECK(triage IN ('New','Accepted','Duplicate','Not a defect','Fixed - retest','Closed')),
 ado_id INTEGER, ado_claim_at TEXT, triaged_by TEXT, triaged_at TEXT, admin_note TEXT NOT NULL DEFAULT '',
 redacted INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (run_id, step_id)
);
CREATE INDEX results_status ON results(status);
CREATE TABLE feedback (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), owner_sub TEXT NOT NULL REFERENCES users(sub),
 text TEXT NOT NULL, created_at TEXT NOT NULL,
 triage TEXT NOT NULL DEFAULT 'New' CHECK(triage IN ('New','Accepted','Duplicate','Not a defect','Fixed - retest','Closed')),
 ado_id INTEGER, ado_claim_at TEXT, triaged_by TEXT, triaged_at TEXT, admin_note TEXT NOT NULL DEFAULT '',
 redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feedback_run ON feedback(run_id);
CREATE TABLE result_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
 status TEXT, note TEXT, rev INTEGER NOT NULL, changed_at TEXT NOT NULL, changed_by TEXT NOT NULL
);
CREATE INDEX history_result ON result_history(run_id, step_id);

-- Fixture values are evaluated once, then frozen. A reset appends a new generation; it never edits one.
CREATE TABLE fixture_snapshots (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), fixture_key TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('run','tester','shared')),
 owner_email TEXT NOT NULL, run_id TEXT, generation INTEGER NOT NULL,
 instance INTEGER NOT NULL, anchor_date TEXT NOT NULL, tz TEXT NOT NULL, release_id TEXT NOT NULL,
 vals TEXT NOT NULL, captured TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
 scope_key TEXT NOT NULL,
 UNIQUE (campaign_id, fixture_key, scope_key, generation)
);
CREATE INDEX snapshots_owner ON fixture_snapshots(campaign_id, owner_email);

CREATE TABLE handoffs (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), handoff_key TEXT NOT NULL,
 producer_email TEXT NOT NULL, consumer_email TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','acknowledged')),
 ready_at TEXT, ack_at TEXT, record_ref TEXT NOT NULL DEFAULT '',
 UNIQUE (campaign_id, handoff_key, consumer_email)
);
CREATE TABLE handoff_overrides (
 id INTEGER PRIMARY KEY AUTOINCREMENT, handoff_id TEXT NOT NULL REFERENCES handoffs(id),
 actor_email TEXT NOT NULL, reason TEXT NOT NULL, ts TEXT NOT NULL
);

CREATE TABLE documents (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
 r2_key TEXT NOT NULL, audience TEXT NOT NULL DEFAULT '[]', values_note TEXT NOT NULL DEFAULT 'generic',
 attested INTEGER NOT NULL CHECK(attested = 1), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE generated_documents (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, owner_email TEXT NOT NULL, doc_key TEXT NOT NULL,
 release_id TEXT NOT NULL, input_sha TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE (campaign_id, owner_email, doc_key, input_sha)
);

CREATE TABLE audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor_sub TEXT NOT NULL,
 action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT
);
CREATE INDEX audit_target ON audit(target);
