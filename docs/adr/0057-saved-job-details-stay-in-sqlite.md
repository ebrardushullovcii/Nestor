# ADR 0057: Saved-job detail evidence stays in SQLite

Status: partly superseded: ADR 0071 removes read-time validation and saved startup views; job-store jobs/job_details replace SavedJobListFacts, lazy compatibility projections and SQLite TEMP evidence versions (db925711, 145ad266). Large listing details still stay in SQLite and are read by id.

Amended by [ADR 0071](0071-store-evidence-once-and-query-startup-facts.md): startup views and validation marks are removed; typed app-owned rows are trusted on read. Canonical storage is normalized without changing repository contracts.

Amends ADR 0053's same-build restriction and ADR 0054's eager saved-job validation.

## Decision

Main retains the explicit `SavedJobListFacts` contract for saved-job list readers.
Descriptions, structured listing text, source intelligence and provenance listing
facts stay in SQLite. A compatibility view exposes real, validated detail getters
to existing read-only domain consumers. There are no blank substitute bodies.
The existing renderer summary/detail IPC contracts remain unchanged.

Each immutable projection version keeps its canonical JSON in a connection-local
SQLite TEMP table. This lets a search or an older workspace view read exactly the
version it captured even after a local write, reset or another connection's write.
Projection versions with identical lazy getter inputs share one evidence row.
The key covers every detail field and ordered source listing fact, distinguishes
absent values from null, and uses immutable listing content keys rather than
reusable integer IDs. An external commit changes the key's generation. A changed
timestamp, verdict or fingerprint alone does not copy evidence. Each view still
owns its current list facts; the shared row serves only unchanged lazy getters.
Only sixteen parsed full versions and sixteen scalar descriptions are cached.
Identity reads validate only the requested description field; full detail reads
validate the complete saved job. List SQL removes detail evidence before any JSON
crosses into main, and copies the full version within SQLite. Equal verdict and
compensation values retain the sharing used by the full projection reader.
A GC anchor shared by detail getters
retires a TEMP version after every row and derived display view releases it. The
next projection update removes retired versions; closing SQLite removes all TEMP
data. This adds no persistent schema migration or export field.

Display-only copies preserve property descriptors so adding plan or activity facts
does not materialize every body. Canonical reads, transaction callbacks, writes,
exports and recovery continue to use complete validated owned values. Callers
that spread or serialize a compatibility view intentionally materialize its full
evidence and must not retain an entire inventory that way.

List facts and verdicts are validated before publication. Full saved-job schema
validation runs in bounded background slices after a cold projection read; opened
details are fully validated before use. Validation marks retain ADR 0054's build
digest and transaction rules. Alias memo keys retain a description digest rather
than a second copy of its body.

## Consequences

The JS heap no longer owns every saved listing body. SQLite TEMP storage and
detail reads add local I/O. Held historical projections can keep historical TEMP
rows until GC releases their getters; they cannot observe newer detail evidence.
Individual unusually large rows can still exceed a background slice's time
budget; no synchronous schema can interrupt one row halfway through validation.

## Startup amendments

A clean-close view may be used across main builds when its database fingerprint
and saved-view format match. A renderer contract change that makes an old view
incompatible must bump that format. The view remains single-use; crash, WAL,
outside-edit and reset protections from ADR 0053 remain unchanged. The full main
build digest still controls validation marks independently from the view format.

Unmarked full saved-job rows validate in five-row background slices with an event
loop turn between slices, after the window acknowledges its first full view.
Canonical triage-cache warming starts after that acknowledgement too. A clean
saved view reaches the window before canonical service startup begins. A failed
renderer releases background work after a bounded wait. Reads and marks retain
ADR 0054's transaction rules.
A validation failure fails subsequent projection reads; opened full details
validate immediately. Without a digest, reads still validate complete rows.
Resume drafts retain the existing marked display-collection reader.
