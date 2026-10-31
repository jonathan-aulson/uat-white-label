# White-label UAT product

A generic User Acceptance Testing workspace on Cloudflare Workers + D1 (+ optional R2). One deployment per client.
Testers sign in through Cloudflare Access, run role-based scenarios, record results and feedback; admins author content,
run campaigns, triage findings and (optionally) create Azure DevOps work items. Content, branding, roster and settings
live in the database, so changing them needs no rebuild.

## Local development
```
npm install
npm run migrate:local
npm run dev        # http://localhost:8787, auth bypass is loopback-only
```
Send the header `x-dev-user: admin@example.com` (a header-injecting browser extension, or Playwright). `admin@example.com` is the bootstrap admin.
`npm test` runs unit/API tests in the Workers runtime; `npm run typecheck` checks TypeScript.
For browser checks, run `npx playwright install chromium` once and then `npm run test:e2e`.
The browser runner starts its own local server on port 8790 and uses separate local storage;
it covers desktop/mobile testing and the admin bug-review dialog without writing to ADO.

## Demo production and continuous deployment

The private repository is `jonathan-aulson/uat-white-label`. Its production URL is
https://uat-demo.jonathan-aulson-80b.workers.dev/ (Cloudflare Access required).

Every push to `main` runs a clean `npm ci`, typecheck, unit/API tests and local browser checks.
Passing checks automatically deploy the existing `uat-demo` Worker. Pull requests run the same
checks but never deploy or receive production credentials. Deployments are serialized; a superseded
main commit is skipped so an older delayed run cannot roll the app back.

GitHub Actions needs repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
The production job runs the locked Wrangler version to apply outstanding D1 migrations, then
deploys using `wrangler.demo.jsonc`. It does not import content, reset data, recreate resources
or change the Access app. The `production` environment has no manual approval gate.
The demo config is intentionally tracked; configs for other clients remain ignored.
Keep migrations additive/backward-compatible: a code deployment can fail after a migration succeeds.

The ADO PAT is **not** a GitHub secret or a checked-in setting. Provision/rotate it directly on
the Worker with `npx wrangler secret put ADO_PAT --config wrangler.demo.jsonc`.
Ordinary code deployments preserve existing Worker secrets. Never commit `.env` or PATs.

## Provisioning a client (manual; nothing is executed for you)
`npm run provision -- --slug=acme --admins=a@x.com --team-domain=https://acme.cloudflareaccess.com` writes `wrangler.acme.jsonc`
and prints the runbook: D1, optional R2, migrations, deploy, Cloudflare Access app, optional `ADO_PAT` secret.
Each deployment has a unique `DEPLOYMENT_ID` that must match its database; otherwise the Worker returns 503.
Never deploy `wrangler.dev.jsonc`.

## Operating
Admin console at `/admin`: Progress, Findings, Content (releases), Campaigns, Roster, Branding, Documents, Settings & ADO, Audit.
- Releases are immutable once published; campaigns pin a release, and existing runs stay on theirs.
- Approved brand colours are preserved: contrast ratios and suggested alternatives are advisory warnings, never a save gate. Invalid hex values/font choices still fail validation. Logos/favicons have metadata stripped without changing their pixel data.
- `scripts/backup.sh <slug>` exports D1 and the redaction ledger. Re-apply redactions after any restore.
- Example workspaces are selectable when creating a release; `examples/sample-steps.csv` shows the CSV import format.

## Reviewing feedback and creating ADO bugs

In **Settings & ADO**, configure the organization, project and optional field/area mappings, then
use **Test ADO connection** (ADO `validateOnly`; no work item is saved). The demo targets Allata /
AI Orchestration Test. The PAT requires read/write work-item permissions for that project.

In **Findings**, choose **Create bug...** to review an editable draft with:
- **Steps to Reproduce:** the pinned release's role-specific steps through the issue, in authored
  order across scenarios, with prerequisites, resolved saved fixture values and recorded statuses.
- **Expected Result:** the failing step's expected behavior.
- **Actual Result:** the tester's finding note.

The ordered script is not a chronological execution log; unrecorded steps are explicitly marked.
General feedback includes recorded steps as context, but requires the admin to describe reproduction
actions and expected behavior. Missing actual results also require completion. Replace all
`ADMIN REQUIRED` prompts, review for sensitive data, confirm the attestation, and click **Create bug**.
The finding then shows **Open bug #...**. Retries reuse correlation tags rather than creating duplicate
items; successful export accepts a new finding. Redacted findings cannot be exported.
Very long scripts fail explicitly rather than silently dropping steps (32,000-character repro limit).
Saved fixture values/captures reflect those currently available, not an immutable event-time snapshot.

## Security model
Cloudflare Access JWT verified in the Worker; roster membership required; admin-only API; same-origin checks, body caps,
strict CSP; ADO calls are host-allowlisted with no redirects; PDFs are structurally validated and require a synthetic-data attestation;
the UI states that only synthetic data may be entered.

## Uploaded PDFs and accessibility

Client brand palettes need not meet contrast targets to be saved. Primary/background below 4.5:1
and accent/background below 3:1 show warnings and optional alternatives, without requiring an
override or silently recolouring the brand. Saving is not a statement of WCAG compliance.

PDFs are stored and downloaded **byte-for-byte unchanged**, preserving ordinary HTTP/HTTPS/email
links, internal navigation, and opening-page destinations. Standard compressed object streams
and ordinary form fields are supported. Link destinations are not fetched or verified, and form
behavior depends on the viewer.

The upload gate parses PDF objects rather than blocking keywords in document text. Scripts,
executable/file launches, embedded attachments, active media, automatic external actions, unsafe
URI schemes, encryption and unparseable files remain blocked. Additional action hooks and action
types outside the supported navigation allowlist are also rejected explicitly. Limits remain
2 MiB / 50 pages, with screening complexity limits of 25,000 objects / 100,000 object visits.
This is structural screening, **not antivirus** or a guarantee about external sites.

## Known limits
PDF validation is structural only (no malware scan); no Office documents; large campaigns can exceed the Workers Free D1 write budget (use Workers Paid);
the content editor is JSON-based (validated, with preview and diff) rather than a form designer.
