# ADR 0076: Write a resume when a job is shortlisted

Status: accepted (2026-10-24). Amends [ADR 0045](0045-resume-batches-continue-after-restart.md) for these resumes; keeps [ADR 0048](0048-shortlisted-resume-pipeline.md)'s limits. Superseded on 2026-10-25 by Shortlisted on the job store: resumes live in a `resumes` table beside `jobs` and are written by `packages/job-finder/src/resumes`, up to six at once, as soon as a job is shortlisted; approving one moves its job to the `resume` stage that Apply reads.

## Context

A resume takes two to three minutes of AI time. The person shortlisted a job
and later opened it to find "Needs a resume", then waited again after
pressing Create. The owner asked for resumes to start the moment a job is
shortlisted, so one is ready when the job is opened.

## Decision

- Every shortlist (button, keys, bulk, menus, the Assistant) ends in one
  service path. When Settings › Resumes › "Write resumes when I shortlist"
  is on (the default) and AI is configured, the jobs it shortlisted that
  still need a resume, at a level other than Original, are recorded in
  `intelligence.resumeOnShortlistJobIds` and written through the same
  generation as "Create N missing resumes": same level, admission, writer
  and processing limits. There is no second writer.
- The record is the person's request. A job leaves it when its resume is
  written, when generation fails (the job shows its failure as today) or
  when the person withdraws it: moving it back to Find jobs, Undo of the
  shortlist, or hiding it. A job being written when withdrawn is cancelled
  before anything is saved; a hidden job is never saved back into
  Shortlisted.
- Pause holds the record; nothing starts while the workspace is paused, and
  Continue starts it. Unlike a resume batch (ADR 0045), the record carries
  on by itself after a restart: shortlisting was the request.
- Off, or without AI, shortlisting behaves as before ("Needs a resume").
- Shortlisted shows these jobs as being written ("Writing resume") and does
  not offer to write them a second time.

## Consequences

Shortlisting spends AI time without a second press; the switch lets a
person keep that choice. Large bulk shortlists queue behind the existing
limits rather than starting at once.
