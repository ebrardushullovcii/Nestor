# ADR 0071: Store evidence once and query startup facts

Status: superseded: the job store replaces legacy relational evidence interning, plan/source versions, migration 26–28 decoders and whole-domain repository reads; the old workspace and migration machinery were removed (145ad266).

## Decision

Forward migrations 26–28 replace repeated resume citations, revision snapshots,
source definitions, plan preferences, memberships, listing bodies and assessments
with relational storage. Each migration makes a consistent SQLite backup before
changing record shapes and verifies counts and canonical round trips. Canonical
repository methods still return complete owned domain objects; exports, imports,
recovery, history, approvals and source facts keep their existing contracts.
Older builds need not open this database. There are no downgrade checks or dual
writes. Complete discovery activity is retained; version 25 remains unused.

The tables and formats each have one purpose:

- `resume_source_texts` stores each exact excerpt once, without truncating evidence.
- `resume_sources` stores original citation identity and source linkage once;
  section, entry and bullet references contain integer citation IDs.
- Revision rows keep a base and exact path changes, because full snapshots repeat
  the same resume; replacing or retaining a base first rebases dependent history.
- Equal `snapshotSections` and `snapshotIdentity` are represented by explicit
  revision-format flags, because they are the same snapshot already stored in
  `snapshotDraft`; independent historical values remain independent.
- `job_sources` stores immutable source versions so independent plans keep their
  original configuration when another plan changes a source.
- `search_preference_sets` and ordered `search_preference_sources` store one
  source-free preference set and its source versions per exact configuration.
- `job_search_plans` references its configuration, while `plan_job_memberships`
  and `plan_sources` store ordered membership without rewriting a large JSON row.
- `job_listing_texts` stores exact current and historical descriptions once,
  with the unchanged shared salary parser's result so each exact body is parsed once.
- `job_fit_assessments` stores exact assessments once, and
  `job_plan_assessments` keeps each plan's own verdict.
- `job_provenance` keeps source facts and references their description, so a
  later current-job edit cannot alter what a source previously said.
- Real saved-job columns hold intake visibility and display employer/location,
  calculated by the same existing policy at a typed write boundary.
- Scalar query rows and indexes exist only to answer bounded screen reads
  without loading evidence; details join evidence by ID when opened.
- Content hashes identify exactly equal records for interning; they do not
  substitute for model judgments or change matching policy.

There are no `_listingFactsFromJob`, `_sharedPlanAssessments` or `_listMeta`
markers to undo on every read. The canonical decoder resolves actual relations
only when a domain operation needs the complete object. Typed saved-job writes
must use the repository writer so relations and query columns commit together.

The startup API returns a profile header, source-free preferences, plan summaries,
settings and counts. It omits resume bodies, source arrays, plan history/digests
and membership arrays. An editor requests its complete object when opened.

## Deleted layers and validation boundary

This supersedes ADR 0053's saved startup view: no extra whole-workspace read on
quit, binary startup view, build digest or saved-view convergence remains.
The clean-close database fingerprint and corruption recovery remain separate.

This supersedes ADR 0054 and ADR 0057's read-time schema validation. App-owned
typed rows are decoded without Zod; validation remains at renderer input, AI,
import/file and migration boundaries. Settings are validated once at file open
because they authorize external actions. Validation marks, their triggers and
background validation passes are removed. Legacy display projections remain
only while domain consumers still require them; moved screens use ADR 0060.

## Consequences

The migration preserves source IDs, exact snippets, resume text and snapshots,
distinct plan assessments, listing history, approvals, application records and
receipts. It does not prune evidence or activity. Source and plan callbacks keep
their complete domain signatures, so existing search commits remain compatible.

First conversion currently exceeds the launch budget and must not be described
as accepted startup performance. Read-query measurements and canonical parity
do not by themselves prove screen parity or a responsive production window.
