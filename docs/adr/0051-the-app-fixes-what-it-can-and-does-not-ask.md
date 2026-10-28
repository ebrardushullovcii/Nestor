# ADR 0051: The app fixes what it can and does not ask the person to manage its rules

Status: partly superseded for Aggressive resumes: local number checks replace model claim verdicts (588a399e), and local rules add listing skills, remove generic or repeated prose and prioritize metric bullets (fef8af09). Automatic settlement, non-blocking stretches and the person's review remain accepted.

## Context

The owner started ten resumes and read the screen as "all failed". The ten had been written and saved, but nine rendered at three or four pages, and three pages or more was an approval-blocking error. The writer could not fix it: the step that turns its proposal into the resume put back every saved achievement and listed every saved skill, so no resume could be shorter than the whole profile. Each resume still spent two extra AI calls being told to shorten itself. On top of that, approval waited on the person to keep each Aggressive stretch line by line, to decide every line the AI had not checked, to confirm each role the writer left off before applying, and a single source asking for a sign-in disabled Search for all sources.

The owner's rule: the checks are for the system, not chores for the person. If the app or the AI can fix something, it fixes it. If nothing can be done, the person is not bothered; at most a small notice they can dismiss for good, or a mention from the Assistant. The app should be simple and smooth.

## Decision

- The resume writer sees every saved role, achievement, project and skill and decides what this job needs. It can give a relevant role up to six bullets, leave older or unrelated roles and projects off (`"hidden": true`), and choose the additional skills. Whatever it leaves off stays on the draft, hidden, for the person to show again; nothing is deleted.
- Length is the writer's to fix. It knows the page target and about how many words fit there, and gives each bullet a priority; a clean draft over the target has its lowest-priority bullets left off (each shown role keeps one) without another call, and after that the draft stands. Page length is a quiet note, never a blocker. (Amended 2026-10-21: the second "leave things off" call cost a full writer call per over-long resume.)
- A generated line the fact check calls unsupported, and that it offers no fix for, is settled during generation: it goes back to the person's saved wording, or is left off when there is none. A stretch outside Aggressive is settled the same way. If a rewrite still fails its one re-check, it also returns to saved wording or is left off, without another model call (amended 2026-10-23).
- Only a generated line the evidence contradicts can hold approval back, and generation settles those. A stretch was accepted by choosing Aggressive; a line the AI has not checked yet, and the person's own wording, never block. The "Lines to confirm" list is gone; the claims panel shows stretches and unchecked lines in neutral tones.
- Roles the writer left off never hold approval or an application back. Resume Studio lists them under "Left off this resume" with an "Add back" button, and asks for no decision.
- A browser blocked on one site never disables Search; the run reopens the browser and skips what it cannot reach. Only an offline build cannot search.
- The resume identity note (imported name or email differs from the profile) is a plain line on Profile, dismissed with one click, and no longer appears on Shortlisted.

## Consequences

- A clean resume costs one writer call, an over-long one too (its shortening is local renders). The writer's notes about running out of tries are gone.
- Claim confirmations and the approve-as-accurate command remain for the rare unbacked generated line that reaches the person, for example after accepting an Assistant proposal the check flagged.
- The person stays the one who sends: final submission, credentials, CAPTCHA and MFA are unchanged (ADR 0012, ADR 0024, ADR 0039).
- New warnings, badges, confirmations and gates must pass the same test: can the system fix it? Then fix it. Otherwise drop it or make it a dismissible notice.

## Related Decisions

- ADR 0018, ADR 0026, ADR 0041, ADR 0049
