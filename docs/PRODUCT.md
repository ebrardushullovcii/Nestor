# Product

Nestor is one local-first desktop app. Job Finder is the product. Live Assistant is parked until the owner approves Job Finder.

This is the owner's scope, in their terms (2026-10-25). Where an older doc or ADR disagrees, this file wins.

## The rule

Someone imports a resume, finds lots of relevant jobs, gets a good resume for each and applies — faster and easier than doing the whole hunt themselves, finding included. Otherwise there's no point. Dead simple: no PhD and flight license needed. It is a paid product, so it also works for someone who wants a few very relevant jobs or light resume changes, not just high volume.

## Job Finder screens

- **Home:** a real dashboard with charts that make sense.
- **Profile:** import once, the AI builds it, the person fixes what's wrong and adds their own job sites (about 900). It holds the resume level preference.
- **Find jobs:** a few simple choices before each search — how to search, how picky, what to keep — replace the Search plans screen. Searches run in the background, the app stays usable, jobs show up as they're found with fit scores and duplicates merged, and a repeat search adds only new ones. Triage is fast: list and detail, keys or clicks, select some or all, shortlist, hide, Undo, and easy ways to move things back.
- **Shortlisted:** the resume starts writing the moment a job is shortlisted, at the Profile level, many at once. The AI fixes its own flagged problems, with no chores for the person. Once approved, Apply works immediately.
- **Resume editor:** editing, preview, PDF/export and approval.
- **Apply:** one setting — either fill everything and leave it for the person's click, or send it for them. Apply one, the selected ones, the page or all, in background tabs, several at once but never unlimited. Only sign-in, CAPTCHA, MFA and questions it really can't answer come to the person, asked once and remembered.
- **Needs you:** the one place for what only the person can do. Form answers live only here.
- **Applications:** a real tracker, with statuses, replies and interviews, built for about 200 applications a week.
- **Settings:** shorter, with one home per setting.
- **Assistant:** the chat on the side of the app stays. Behind it goes a proper MCP for the app, so the chat can do everything the person can, navigation included, and someone could mostly run the app from the chat.

## Resume levels

Original, Light, Tailored, Aggressive, exactly as they are now. Don't reword Aggressive.

## Applying and pacing

- Send for me is the person's authorization. Final submission, account creation, credentials, CAPTCHA and MFA otherwise stay the person's unless they authorize the step (ADR 0012, ADR 0024). Routine application declarations, including background-check consent, are on by default and the person can turn any off (ADR 0027).
- Pacing is automatic, so job sites don't block the person, but never slower than needed. There is no daily-limit setting. The send guards stay.

## Cut

Quick review, Safeguards, the daily limit, the Search plans screen, Companies, Outcomes, the Resume approaches screen and the unused Settings section. Don't build on them or bring them back.

## Screen rules

One clear main action per screen. The same list/detail layout and selection everywhere. Every action shows what happened at once. No dead ends. No one-option dropdowns. The design language stays as it is.

Use AI judgment where rigid rules break, and spend AI only where it's needed. Sweat the small quality-of-life touches, and don't regress anything the person actually uses.

## Speed

Launch under a second. Navigation, scrolling and clicks instant, with no stutter. The work a screen does must not grow with how many jobs there are, and a screen loads only what it shows.

## Later, not now

Subscriptions and syncing across devices. Keep that path open; don't build it.

## Live Assistant (parked)

Interview help in a visible window: the person starts a session, chooses microphone, meeting audio and screenshots separately, and gets answers from a live transcript. Capture and model use stay explicit and user-started (ADR 0003, ADR 0008). See `docs/modules/LIVE_ASSISTANT.md`.
