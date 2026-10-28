# ADR 0043: Bulk work queues the whole selection; Undo stays long enough to use

Status: partly superseded: resume-generation batches are replaced by Shortlisted on the job store (2581847a, 588a399e), and Apply queues selected rows without ten-job runs (0b053477). Whole-selection accounting and longer action toasts remain accepted.

## Context

ADR 0035 capped a selected resume batch at ten jobs, and Shortlisted, Applications and retries started at most ten jobs per click without saying so. Testers in the third usability round queued 33 missing resumes, retried 14 failed applications and applied to 53 ready jobs; each had to press start again and again, and the screens said "all" while only ten ran. ADR 0042 also gave every toast six seconds, which was too short to reach the Undo of a bulk Tracker change.

## Decision

- A selected resume batch queues every missing first draft in the selection. At most two resumes are written at once and Stop works as before (ADR 0035 otherwise unchanged).
- Where a bulk action still starts a limited group (applications and retries keep their limits), the control says so before starting: the total, how many start now and how many remain.
- A toast that carries an action such as Undo stays about twenty seconds, and still holds while hovered or focused. Toasts without an action keep ADR 0042's six seconds.

## Consequences

Long resume queues need no repeated starts; throughput is still bounded by two concurrent writers and the provider. Bulk counts on screen match what will run.
