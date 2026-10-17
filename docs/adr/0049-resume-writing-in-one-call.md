# ADR 0049: A resume is written in one model call, checked, and repaired only when flagged

Status: accepted (2026-10-15). Amended by [ADR 0051](0051-the-app-fixes-what-it-can-and-does-not-ask.md): flagged lines are settled during generation instead of waiting for the person, and the writer decides what each resume shows.

## Context

Resume generation ran as an open agent loop: read the context, read the templates, compose, render, inspect, finish. Every turn resent the whole profile, listing and evidence, and the inspect step sent the complete resume back. A resume took about six model calls, slow models ran out of the ten-minute budget, and a 200-job batch spent the owner's AI allowance far faster than expected. When the AI service refused the listing read (HTTP 402), the writer fell back to the person's original wording and saved it as a ready resume.

## Decision

- The writer gets everything in one payload and sends the complete proposal through `compose_resume_proposal`. That same call renders the resume and runs the checks; a clean check finishes the task.
- A flagged check returns only the lines to repair. The model gets at most two repair calls (three calls in total); the second flagged render tells it to drop the flagged lines. A run that ends while revising keeps its last clean draft, as before. A run that never rendered clean keeps its last draft instead of failing: the draft's own validation marks the lines the writer could not support, and approval waits until the person decides each one, the same gate Aggressive stretches use.
- The read-context, read-templates and inspect steps are removed. Templates are listed in the payload, and the proposal call can pick one when the person has not locked it.
- A listing read the AI service refuses (funding, authentication, permission) stops the writer with that reason and pauses the batch. No resume is saved in its place.
- A resume written without the listing (original wording, `listing_text_missing` or `listing_text_not_distinguishing`) counts as missing until it is approved, so a batch can write it once the listing can be read.

## Consequences

A clean resume costs one writer call plus the claim check its render triggers. Grounding, claim checks, Aggressive confirmations and the person's review are unchanged. A model that cannot produce a clean draft within three calls stops instead of looping, and its draft arrives with the unresolved lines marked for review. On a slow provider (about 100 seconds a call) a failure used to discard seven minutes of writing.
