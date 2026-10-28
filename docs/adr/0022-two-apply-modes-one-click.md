# ADR 0022: Two apply modes, one or two clicks

Status: superseded by [ADR 0024](0024-job-finder-browser-harness-and-three-apply-modes.md); Needs you questions and saved answers now live in the application store (49cec8a9).

## Context

Applying had become a place of its own: prepare, approve, revoke, batch, auto-prepare, answer steps, retries. The person shortlisting a job wants one thing: the application handled. On 2026-09-14 the product owner set the bar: either Job Finder fills everything in and leaves the browser ready for the person to click Apply, or it applies for them, with one or two clicks in total. ADR 0012 already authorises full submission under a user-scoped authority envelope; ADR 0021 already fills forms with an agent loop. The surface on top of them was the problem.

## Decision

There are exactly two modes, chosen once in Settings by a single switch, "Let Job Finder send applications for me":

- Off (default), "Fill it in, I send it": Job Finder opens the application, fills everything it can, attaches the resume, and stops with the browser open on the finished form. The person reads it and clicks the site's own Apply button. Nothing is sent by Job Finder.
- On, "Apply for me": Job Finder fills everything and sends the application inside the saved authority envelope, then verifies the outcome from the employer's page. The envelope is created and updated by the switch itself, never edited by hand: scope all shortlisted jobs, the facts and declarations the person confirmed in the one-time facts step below.

One control per job, in Shortlisted and in Applications: "Fill it in" or "Apply", plus "Apply to all shortlisted" (or "Fill in all"). That is the one or two clicks.

Questions the form asks are answered from what the person already told us. The first time either mode runs, and again only when a new kind of fact is needed, Job Finder shows one short "Before you apply" step with the common facts a form may ask (work authorisation, sponsorship, notice period, pay expectation, relocation, willingness to attest, whether voluntary self-identification questions may be answered from the profile). Those answers are saved in the profile and reused everywhere. Free-text questions are written by the model from the profile and resume, as ADR 0021 allows. A question that still cannot be answered does not create a task: the run finishes what it can and hands the browser over with one line, "1 question left for you", in both modes.

Every application shows one of five states, one sentence, at most one button: Filling in (progress), Ready to send (Open the browser), Applied (verified), Needs you (Open the browser: sign-in, account, a left-over question), Could not apply (reason; Open the browser or Try again only when a retry can differ).

## Consequences

- Removed from the product surface: separate prepare/approve/revoke controls, batch preparation panels, "Prepare remaining", answer-memory and grouped-answer screens, the Needs you question form, confirm-before-submit as a distinct mode, manual envelope editing.
- Kept underneath: ADR 0012 envelope and preflight, ADR 0021 loop, Needs you for sign-in, account and security walls only.
- The Tasks card shows applications only as the five states above.
