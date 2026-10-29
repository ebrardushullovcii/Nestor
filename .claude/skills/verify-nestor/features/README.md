# Nestor verification map

The maintained list of what a person can do in Nestor, and how to prove each one in an isolated instance. Read this index, then use the feature's file as the recipe. `../SKILL.md` covers launch, the helpers, evidence and cleanup.

## Baseline preconditions

- `$V/build` ran on the code under test and `$V/up` printed `ready` (`V=.claude/skills/verify-nestor/bin`). `$V/doctor` exits 0.
- A fresh instance starts on Profile › Guided setup with an empty workspace. Its replica sites run on the URL `up` printed (`sites.url` in journeys); `/board/`, `/lever/`, `/greenhouse/`, `/workday/`, `/gatekeeper/` and fifteen larger boards are listed in `apps/desktop/test-fixtures/job-sites/README.md`.
- Synthetic resumes: `apps/desktop/test-fixtures/job-finder/resume-import-sample.txt` ("Jamie Rivers", Staff Frontend Engineer, Berlin) and the personas in `resume-import-personas/` (PDF, DOCX, TXT, Markdown).
- Search, fit, resume writing and apply need `up --ai live`. Deterministic AI proves screens and flow only.

## Driving conventions

- Accessible names from `$V/drive see`: sidebar buttons, headings, field labels. Prefer `--role` and `--within` over `--nth`.
- One action, one screenshot of the result; a `db` read for every write.
- English UI. The names below are the `en` strings.

## Proof and skip reporting

- Capture the action and the resulting state: a shot before, a shot after, the steps log, and the row (`db`) or receipt (`submissions.jsonl`) it wrote.
- Record the feature file and entry point with every proof. Do not report an entry point you skipped as verified through another one.
- When a precondition is missing (no AI key, a permission prompt you may not raise), report the recipe as blocked with the reason. Don't weaken the recipe.

## Feature entry contract

Each recipe starts with an H1 and a paragraph on user-visible behavior, then covers: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-nestor`, `Gotchas`.

## Features

The whole journey at once: `journeys/full-check.mjs` runs the features below in a person's order on one live-AI instance (see the Saved journeys table in `../SKILL.md`). Use a single feature's recipe to prove one change.

- [Guided setup and resume import](./guided-setup.md): import a resume through the picker, review Basics and Work history, set job targets and work eligibility, finish setup. Proven 2026-10-17 (`journeys/job-finder-replica.mjs setup`).
- [Job sources](./job-sources.md): add, turn on and off, and edit the sites Job Finder searches; browser permissions and saved-password save/import/autofill. The setup step is proven; Profile › Job sources is not yet.
- [Search and fit](./search-and-fit.md): Find jobs searches the enabled sources; each result carries the model's fit verdict and its reasons. Proven with live AI 2026-10-17 (`search` stage).
- [Shortlist and tailored resume](./shortlist-and-resume.md): shortlist a job, pick a resume level, create the resume, review it. Proven 2026-10-17 (`shortlist`, `resume` stages); Edit resume and the other levels are not yet.
- [Apply and send](./apply-and-send.md): Fill in for me prepares the form for the person to send; Send for me can send through the guards. Applications tracks the work. Proven against the replica `/board/` 2026-10-17 (`apply`, `send` stages); Send for me and the other replica sites are not yet.
- [Sidebar assistant](./sidebar-assistant.md): navigation acknowledgement after the person changes screens while a reply is running; same-screen requests keep the current view. Other assistant actions use their feature recipes.
- [Live Assistant](./live-assistant.md): notices, quick check, a live session with typed questions and popups, post-session review. Proven text-only 2026-10-17 (`journeys/live-assistant-session.mjs`); audio and screenshots are not.
- [Website](./website.md): the public landing page, signup and tour at desktop and phone widths. Proven 2026-10-17 (`journeys/website.mjs`).

Not mapped yet: assistant actions outside navigation and the source/apply recipes, Settings beyond apply mode and browser permissions, workspace search, and Live Assistant settings. Add a file when a change touches one.
