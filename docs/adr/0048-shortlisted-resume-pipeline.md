# ADR 0048: Shortlisted resume generation pipeline

Status: superseded: Shortlisted uses job-store resume rows and up to six adaptive writers, without the 50-writer/two-processor batch pipeline (2581847a, 588a399e).

## Context

The owner asked to generate a 200-job Shortlisted selection with up to 50 AI
writers, starting more writing while completed drafts are processed. Increasing
the old two-job queue alone would also multiply PDF windows, retained draft
bodies and full-workspace IPC responses.

## Decision

- Shortlisted queues the whole selection. At most 50 generation agents write
  concurrently. Final validation, rendering and persistence have two local
  processing slots; all PDF paths also share a two-window limit.
- Admission is limited to 100 jobs, including writers and drafts waiting for
  processing. This bounds retained context and draft bodies when writing is
  faster than processing. Capacity is replenished as individual jobs finish.
- Each job returns a typed completion receipt. Workspace notifications use the
  existing coalesced delta refresh rather than returning a complete workspace
  for every finished resume. Selected asset reads are indexed by job ID.
- Stop prevents waiting jobs from starting AI work. Already admitted writers
  finish and save. Checkpoints retain the whole selection, completed identities
  and choices. Restart still requires Continue batch; it never starts work
  automatically. The assistant's separate batch dispatcher retains its limit.
- Progress distinguishes writing, processing and waiting. Shortlisted estimates
  remaining time from observed completion throughput instead of assuming two
  writers. PDF admission wait does not consume the writer's model budget;
  rendering and validation still consume time.
- Resume model input includes candidate facts, the current listing and resume
  evidence. Discovery history and the source catalog are excluded. Required
  resume facts are preserved within the context limit or rejected explicitly,
  rather than silently truncated.

## Consequences

This supersedes the two-writer Shortlisted limits in ADRs 0035, 0043 and 0045.
Provider capacity can still constrain throughput. Failures remain per job and
never approve a resume or submit an application. Increasing concurrency does
not change model selection, grounding rules or the person's review authority.
