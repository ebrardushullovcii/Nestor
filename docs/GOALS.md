# Goals

Use this for durable product direction. Current state lives in the code and git history. The scope in [PRODUCT.md](PRODUCT.md) wins where this file disagrees.

## End State

Build one local-first Electron desktop app for job search, resume preparation,
user-controlled application automation, and interview prep/live support.

## Job Finder North Star

Job Finder is the current product priority. Its purpose is to let a person move
from an accurate profile to a large, useful job pipeline and completed
applications under their chosen authority without needing to understand the
product's internal concepts. If doing it by hand is faster, the app has failed.

The primary journey is:

1. Set up and verify the profile and original resume.
2. Find hundreds or thousands of relevant, current jobs across repeated searches.
3. Judge results quickly and shortlist the jobs worth pursuing.
4. Get a strong, job-specific resume written for each shortlisted job, then edit,
   export, and approve the exact artifact.
5. Execute applications according to the user's selected automation mode,
   including final submission when autonomous authority is explicitly enabled.
6. Ask for help only when work falls outside that authority, then track progress.

Profile -> Find jobs -> Shortlisted -> resume -> Apply -> Applications must feel
like one continuous journey. The next useful action should be obvious without
reading long explanations or learning terms such as strategy, lineage, or
runtime. Home, Needs you and Settings support this journey; they must not
compete with it.

Acceptance binds to these user outcomes, not the current implementation. The
discovery engine, browser control, resume editor, agent loops, and supporting
libraries should be replaced when a measured alternative is materially simpler,
more reliable, more truthful, or more effective.

Implementation constraint: users pick and enable sources; discovery,
source-debug, and apply preparation must improve generically through shared
browser policy, typed evidence, and learned target instructions—not per-board
route builders, triage overrides, or rescue branches in shared orchestration.
See [ARCHITECTURE.md](ARCHITECTURE.md) and [ADR 0007](adr/0007-source-generic-browser-workflows.md).

### Product Outcomes

- A first-time user can import a resume, correct the resulting profile, configure
  at least one source, find jobs, shortlist one, approve its resume, prepare the
  application, and reach Applications without hints.
- A returning user can keep thousands of jobs across repeated searches without
  losing decisions, selection, filters, approved artifacts, application records,
  or responsiveness.
- Discovery prioritizes relevant, current, inspectable results rather than raw
  volume. It preserves in-flight work, explains conservative mismatches, and
  recovers truthfully from source or network failures. Inactive or stale is not
  the same as proven closed; visible Posted/Updated dates agree with sorting; each
  job keeps safe source provenance. Repeated runs deduplicate prior results; when
  the configured sources are exhausted, the product says so instead of relisting
  old jobs.
- Fit is evidence-backed guidance, never an "ATS score" or interview probability.
- High-volume work is efficient: bulk actions do not eject the user from the
  page, per-job failures do not discard successful work, and progress survives
  navigation and restart.
- Tailored resumes are materially better for the exact vacancy while remaining
  truthful. Strong/aggressive generation may substantially rewrite, combine,
  reorder, and elaborate supported evidence, but it never invents employers,
  dates, credentials, seniority, historical titles, named technology, absent
  skills/keywords, leadership, ownership, education equivalence, transferred
  accomplishments, or numbers, apart from the bounded relaxations ADR 0018 gives
  Aggressive. Every draft stays editable, versioned, and exportable. A model never
  certifies its own output. Exclude salary expectations and privacy-risk defaults
  such as photo, date of birth, marital status, government IDs, and salary
  history unless the user opts in.
- Applying has one user setting: fill everything and leave it for the person's
  click, or send it for them. Sending acts only inside an explicit, inspectable,
  revocable authority envelope. CAPTCHA and anti-bot challenges are never
  bypassed; unavailable credentials or MFA, unknown eligibility facts, unseen
  material attestations, ambiguous controls, and actions outside the saved policy
  pause for the user instead of being guessed. Every external write and submit
  attempt keeps exact lineage and a truthful receipt; internal flags never prove
  a site outcome. See ADR 0012.
- Local persistence, backup, reset, and corruption recovery stay honest:
  a database-only backup never claims to restore documents or browser state,
  reset names its irreversible commit point, and corruption recovery validates a
  restore or fails closed instead of silently starting fresh.
- Applications stays useful at about 200 applications a week: inactive records
  can be closed or archived without erasing their receipts, history, or
  artifacts, while active work stays easy to find.

### Experience Bar

- Prefer simple, natural defaults over extra setup, cards, filters, status
  badges, and explanatory copy.
- Remove obsolete, duplicate, or unused destinations and controls instead of
  keeping them for compatibility.
- Use one user-facing name per concept and one clear primary action per state.
- Keep useful information above the fold; avoid oversized cards, duplicated
  summaries, excessive padding, and nested scroll confusion.
- Every empty, blocked, failed, stale, or interrupted state explains the truth in
  plain language and offers the nearest safe recovery action.
- Navigation never silently discards edits. Unsaved-change protection offers
  Save, Discard, and Stay in product language.
- Layouts stay stable at supported desktop sizes, keyboard-only use, and native
  Electron 125% zoom. WCAG 2.2 AA is the baseline.
- Each setting has one home and one save scope.
- Power-user speed (search, keyboard navigation, bulk actions) must not make the
  default journey harder for a novice.

### Product-First Verification

- Real use of a freshly built Electron app is the primary UX evidence. Automated
  tests are regression guardrails; they do not prove that a screen is clear,
  simple, or useful.
- Dogfood the journey with visible UI actions and realistic synthetic data.
  Never claim a visual or workflow fix without replaying the affected state in
  the app.
- A tester who cannot name the next useful action without internal vocabulary
  or outside hints has found a journey defect, even if the control works.
- Do not repeatedly run full suites, builds, or broad matrices while iterating.
  Prefer live use and one narrow regression per confirmed defect.
- Private-resume wording, live-source relevance, authenticated employer behavior,
  and personal accessibility always need user-controlled review.

## Product Shape

- `Job Finder`: profile, resume import, discovery, resumes, applications, and
  apply flows governed by the user's selected authority mode.
- `Live Assistant` (parked): target-context setup, transcript-aware live cues,
  visible popups, retention, and post-session review.
- Shared platform: local profile, documents, application history, browser
  runtime, AI provider roles, desktop shell, and settings.

## Durable Priorities

- Local-first persistence is the source of truth.
- Workflows are UI-first with agent acceleration; the Assistant can do anything
  the user can.
- Browser-driven job workflows are a first-class product surface.
- Typed contracts and package boundaries matter more than convenient imports.
- External writes and submissions occur only inside an explicit, inspectable,
  revocable user authority envelope.
- Interview capture and overlays stay explicit, visible, adapter-owned, and auditable.
- Quality and truth outrank raw speed: an honest blocker beats a fast
  unverifiable claim.
