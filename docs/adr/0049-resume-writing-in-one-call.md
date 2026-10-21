# ADR 0049: A resume is written in one model call, checked, and repaired only when flagged

Status: accepted (2026-10-15). Amended by [ADR 0051](0051-the-app-fixes-what-it-can-and-does-not-ask.md): flagged lines are settled during generation instead of waiting for the person, and the writer decides what each resume shows. Amended 2026-10-21: a flagged render no longer goes back to the writer; the check's own fixes settle those lines.

## Context

Resume generation ran as an open agent loop: read the context, read the templates, compose, render, inspect, finish. Every turn resent the whole profile, listing and evidence, and the inspect step sent the complete resume back. A resume took about six model calls, slow models ran out of the ten-minute budget, and a 200-job batch spent the owner's AI allowance far faster than expected. When the AI service refused the listing read (HTTP 402), the writer fell back to the person's original wording and saved it as a ready resume.

## Decision

- The writer gets everything in one payload and sends the complete proposal through `compose_resume_proposal`. That same call renders the resume and runs the checks; a clean check finishes the task.
- A flagged check ends the writer too (2026-10-21). The check already returns a fix for every line it flags, and keeping the resume applies those fixes and checks only the rewritten lines again (ADR 0041, ADR 0051). Asking the writer to repair the same lines cost a full payload and about ninety seconds a call: on the owner's profile one resume took six calls, 221K input tokens and nine and a half minutes, and now takes three calls, 72K input tokens and about three minutes. The writer is asked again only when its proposal could not be rendered at all (invalid shape or language fields).
- The read-context, read-templates and inspect steps are removed. Templates are listed in the payload, and the proposal call can pick one when the person has not locked it.
- A listing read the AI service refuses (funding, authentication, permission) stops the writer with that reason and pauses the batch. No resume is saved in its place.
- A resume written without the listing (original wording, `listing_text_missing` or `listing_text_not_distinguishing`) counts as missing until it is approved, so a batch can write it once the listing can be read.

## Consequences

A resume costs one writer call, the claim check its render triggers, and a short re-check of any lines the check's fixes rewrote. Grounding, claim checks, Aggressive confirmations and the person's review are unchanged. A model that cannot produce a clean draft within three calls stops instead of looping, and its draft arrives with the unresolved lines marked for review. On a slow provider (about 100 seconds a call) a failure used to discard seven minutes of writing.
