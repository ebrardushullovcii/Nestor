# ADR 0035: Selected resume batches

Status: accepted (2026-09-26). The sequential-applying bullet is superseded by [ADR 0036](0036-parallel-application-preparation.md). Shortlisted concurrency is superseded by [ADR 0048](0048-shortlisted-resume-pipeline.md). Superseded on 2026-10-25 by Shortlisted on the job store: resumes live in a `resumes` table beside `jobs` and are written by `packages/job-finder/src/resumes`, up to six at once, as soon as a job is shortlisted; approving one moves its job to the `resume` stage that Apply reads.

## Context

The owner asked to generate resumes for selected jobs and reduce waiting through parallel work. ADR 0026 removed persistent batch curation; its default per-job flow remains useful.

## Decision

- Shortlisted keeps Create N missing resumes and Apply to all N ready jobs. Choose jobs temporarily reveals resume checkboxes and a Create N resumes control. Cancel, starting the batch, or leaving the page clears the selection. Selection is not persisted.
- A batch writes missing first drafts only, up to ten jobs. Existing resumes, original-resume jobs, and jobs already in Applications are excluded.
- At most two resumes are generated concurrently within a batch. Completion and failures are counted as jobs settle. One failure does not stop the others. Stop prevents new jobs from starting and lets active drafts finish. The batch survives sibling route changes; app restart does not resume its queue.
- The controller owns the batch and rejects duplicate starts. Selected batches and their remaining counts stay scoped to the selected jobs.
- Applying remains sequential. The browser runtime currently serializes form work globally, and the application queue assumes one active job. Parallel applications require separate work on per-job progress, tab ownership, cancellation, and submission authority.

## Consequences

This amends ADR 0026's ban on batch curation only for temporary resume selection and replaces the sequential resume batch in ADR 0024. It adds no saved settings, application selection, new approval step, or changes to submission authority. Provider throughput may limit the speedup.
