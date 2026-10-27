# ADR 0027: Applications that finish, continue, and apply in bulk with one press

Status: accepted (2026-09-20); amended (2026-10-01, 2026-10-27).

## Context

Every test of the Applications page failed at a different step, and the product owner's summary was that it "just does not work". Three defects sat under most of the failures:

- The first declaration checkbox on a form ("I certify my answers are true", the privacy notice, the site's terms) stopped the run at once, with the rest of the form untouched. The executor paused on any declaration kind not in the saved permission's list, and nothing in the product ever wrote that list: the only Settings section that could was not rendered. ADR 0022 had already decided that a question the run cannot answer does not stop it; the code did the opposite.
- Continuing after "Needs you" reopened the job's link in a fresh tab, so whatever the person had ticked in the browser was gone, and the continued run was pinned to fill-in-only whatever mode they had chosen. It met the same box, paused on the same fingerprint, and the step read "still blocking". The person ticked the box, pressed the button, and nothing moved.
- "Apply to all" on Shortlisted staged a batch and sent the person to Applications to press "Start preparing N jobs" a second time, under copy that promised Job Finder "never presses the final submit button" even when they had chosen Send for me. ADR 0022 and ADR 0026 had already made Apply to all one press.

The Applications rows also used an older vocabulary ("Needs recovery", "Waiting on consent", "Filled in", "Preparing") while the five-state presentation ADR 0022 asked for was written and never wired in.

## Decision

- A declaration the person has not allowed never stops the run. The box is left unticked, the model is told to carry on, and the question goes back with the finished form as "1 question left for you". A "Yes" the person saved earlier for that exact question counts as their approval and the box is ticked from it.
- Settings, under the one AI behavior panel (ADR 0025), lists the six declaration kinds a form can ask for. The routine three are on by default: the answers are true, the privacy notice, the site's terms. Every applicant must accept them to apply at all, and the answers they certify come from the person's own profile. Background-check consent, self-identification and marketing contact stay off until the person turns them on, because those say something about the person rather than about the form. This is the "willingness to attest" fact ADR 0022 described, kept as a setting rather than a first-run step.
- A continued run starts on the page it stopped on, in the tab already open there, and works inside the same permission as the first run: the saved mode, the allowed origins, the declarations. When that permission covers sending, the continued run sends. A continued run that sends is verified, not "still blocked".
- Apply to all is one press. Starting a batch approves it in the same call; the batch runs in the mode chosen in Settings, and every sentence about it says so instead of promising that nothing is sent.
- Applications rows read one of the five states (Filling in, Ready to send, Applied, Needs you, Could not apply) from the newest run result. A run that handed back questions is Needs you, not Could not apply. When two or more applications could not be applied and a fresh run could differ, one control tries them all again.
- Application documents the run creates for a form (cover letter, motivation letter, supporting statement) can be PDF, Word or plain text, whichever the form accepts.
- A form worked to the end with nothing left for the person is recorded as `ready`, not `paused`. Only a run that handed back a question, or met a wall, is waiting on the person; a form that is filled in and left for them to send is Ready to send and is not counted under Waiting on you or Needs you. Needs you lists it in its own "Ready for you to send" group (see the 2026-10-27 update).
- A run the model or browser dropped (a provider that went silent, a page read that threw) is a `failed` attempt with Try again, never Needs you. Needs you is reserved for a run that handed back a question the person can answer.
- Hidden file inputs stay in the observation. Lever, Greenhouse and Workday hide the resume input behind a styled "Attach" button; attaching works on the hidden input, and without it the run could never attach a resume.
- A page a site shows while it checks the browser by itself ("Just a moment", "Performing security verification") is a fact handed to the model with the advice to wait, up to about two minutes, before reporting it; a wait may last thirty seconds. Only a box to tick or a puzzle to solve is the person's.
- The browser's "needs you" banner clamps the run's sentence to what its schema allows. A long report from the agent used to make the state read throw and fail the apply call that had just finished the form.
- The one-press Apply sends. Only the batch loop used to reach the send step, so "Send for me" from a job's own Apply button filled the form and stopped. The review card the send is built from clamps its text to its schema for the same reason as the banner.
- The switch's permission is one growing grant per person (ADR 0024), and an envelope a submission has already used cannot be edited in place. Starting an application under a new mode or for a new job therefore revokes the used envelope and creates the next one with the combined scope; a refused write is said plainly instead of running as fill-in without a word.
- A profile with no saved answers can still be approved: an empty answer snapshot says "nothing on file". Missing work-authorisation or sponsorship answers do not gate sending; the run hands such a question back at the form.
- The prepare-only guard that preparation leaves on the page is opened for exactly one authorised press of the send control, after preflight, and closed again. Without that window the send clicked a button whose request the guard aborted, and could only ever report an uncertain outcome.
- Under "Ask before sending", the person's press on Send is the confirmation the mode asks for: the submission path issues the execution grant bound to that attempt's preflight from that press, good for a few minutes. Nothing else can issue it.
- A finished-form record carries the mode it ran under, so an application prepared under "Ask before sending" offers its Send control; a sent application's attempt state is submitted.
- Five local replica job sites under `apps/desktop/test-fixtures/job-sites` (a plain board, Lever-, Greenhouse- and Workday-style forms, and a site with a cookie overlay, verification interstitial, new-tab form and autosave) are the proving ground for send paths. Test runs never submit to a real employer (`docs/TESTING.md`).

## Consequences

- Removed from the person's path: the second click on a staged batch, the mid-form stop on a declaration, the reopened listing after a browser step.
- The saved authority envelope (ADR 0012) still bounds sending, origins and declarations. The declarations setting only adds to the envelope's own list; it never widens submission.
- Runs that meet a declaration the person has not allowed finish the form and end as Needs you with that question, in both modes, exactly as ADR 0022 described.

Rejected alternatives: pre-approving every declaration kind by default (background-check consent and self-identification are material attestations about the person, ADR 0012); a first-run "Before you apply" step (one more screen before the first application, for a choice that fits the existing panel).

## Related Decisions

- ADR 0012, ADR 0022, ADR 0023, ADR 0024, ADR 0025, ADR 0026

## Update (2026-10-01)

Background-check consent now joins the routine declarations that are on by default: the answers are true, the privacy notice and the site's terms. The agent may tick declarations the person agrees to, and the person can turn any off in Settings. Self-identification and marketing contact stay off by default. These permissions avoid leaving routine declarations for the person on every application; they do not grant final submission authority (ADR 0012, ADR 0024).

## Update (2026-10-27)

Needs you lists filled forms waiting for the person's Send in their own group, "Ready for you to send", below what is blocked. The owner approved this after testers saw "You're all caught up" while a form waited for Send. The group is not counted in Needs you, Home or the navigation badge, because nothing is blocked. Each row opens the filled form to review and send. When nothing is blocked and a form is waiting, the empty list says so and offers "Review and send".
