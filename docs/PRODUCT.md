# Product

Nestor is one local-first desktop app. Job Finder is the product. Live Assistant is parked.

The owner agreed this scope screen by screen on 2026-10-25. Where an older doc or ADR disagrees, this file wins.

## The rule

Dead simple, fast and easy: no PhD and no flight license. If finding and applying to jobs yourself is faster, the app has no point.

## Job Finder screens

- **Home:** a dashboard with charts that make sense: new good jobs, resumes ready, applications waiting on the person, and what was sent.
- **Profile:** the person's details, resume and files, mostly as they are today. It holds the resume level preference.
- **Find jobs:** before each search the person makes a few simple choices: how to search, how picky to be, and what to keep. These replace Search plans.
- **Shortlisted:** the resume starts writing as soon as a job is shortlisted, at the Profile level. There is no level picking here. Apply works the first time.
- **Resume editor:** edit, preview, PDF and approve. Checks run on their own and the AI fixes what they flag.
- **Applications:** a real tracker, built for about 200 applications a week.
- **Needs you:** the one place for what only the person can do. Form answers live here and nowhere else.
- **Settings:** short, with one home for each setting.
- **Assistant:** an MCP server for the app. It can do everything the user can, including navigation.

## Resume levels

Original, Light, Tailored and Aggressive, exactly as they work today. Aggressive is not reworded (ADR 0018).

## Applying

- Three modes: Prepare for me (`prepare_only`), Ask before sending (`confirm_before_submit`) and Send for me (`autonomous_submit`). Only the last two send, and only inside the saved authority envelope (ADR 0012, ADR 0024).
- Final submission, account creation, credentials, CAPTCHA and MFA stay the person's unless they authorize the step. Routine declarations, including background-check consent, are on by default and the person can turn any off (ADR 0027).
- Pacing is automatic, so sites don't block the person, but never so careful that it slows them down.

## Cut

Quick review, Safeguards, the daily limit, the Search plans screen, Companies, Outcomes (for now) and the Resume approaches screen. Don't build on them or bring them back.

## Screen rules

- One component per job: one tab style, one list row, one badge, one dialog.
- Nothing shifts: panels, selection, hover, loading and toasts never move unrelated content. Floating surfaces overlay, and a skeleton is laid out like the loaded screen.
- Everything in reach: down to 1024x720 the primary action is visible without scrolling. Popovers flip above their trigger when there is no room below, shift inside the window, take their height from the space available and scroll inside.
- One fact, one voice: a number shown on two screens uses the same noun and the same population. No raw errors or internal words reach the person.
- Honest loading: every wait shows elapsed and expected time or real progress, never a made-up percentage.
- Legible in both themes: text at least 4.5:1, boundaries and states at least 3:1; disabled looks disabled.

## Live Assistant (parked)

Interview help in a visible window: the person starts a session, chooses microphone, meeting audio and screenshots separately, and gets answers from a live transcript. Capture and model use stay explicit and user-started (ADR 0003, ADR 0008). See `docs/modules/LIVE_ASSISTANT.md`.
