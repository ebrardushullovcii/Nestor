# ADR 0076: Write a resume when a job is shortlisted

Status: superseded: shortlisting queues job-store resume rows for up to six adaptive writers, replacing intelligence.resumeOnShortlistJobIds and the old batch pipeline (588a399e, 28b98333).

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
