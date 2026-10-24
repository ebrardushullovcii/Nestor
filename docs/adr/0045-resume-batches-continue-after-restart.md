# ADR 0045: Resume batches can be continued after a restart

Status: accepted (2026-10-05). Shortlisted concurrency is superseded by [ADR 0048](0048-shortlisted-resume-pipeline.md). Resumes started by shortlisting carry on after a restart by themselves ([ADR 0076](0076-write-resumes-when-a-job-is-shortlisted.md)).

## Context

ADR 0035 let a resume batch survive route changes but not an app restart: an unfinished queue was simply lost, and the person had to select the jobs again. Testers in the third usability round queued long batches, from the screen and through the assistant, and lost them when the app closed. The batch also gave no idea how long the rest would take.

## Decision

- A resume batch saves its queue, its completed jobs and, for batches the assistant started, the requested rewrite level and language.
- After a restart nothing resumes on its own: Shortlisted offers Continue batch, which writes the unfinished jobs with the same choices. Stop and the two-at-once limit work as before.
- After two resumes in a batch finish, progress shows about how many minutes are left, from their measured durations.

## Consequences

This amends ADR 0035's "app restart does not resume its queue". Saved batches are workspace data like drafts; Reset everything removes them. Work never starts without the person pressing Continue batch.
