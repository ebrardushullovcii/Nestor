# ADR 0044: Page-level conditions are items on the header status line

Status: accepted (2026-10-05); amends ADR 0042

## Context

ADR 0042 kept a tinted box for anything the person must act on. Job Finder screens then stacked several of them above their lists: Applications showed the latest automatic run and a bulk retry as full-width boxes, Tracker repeated two of them, and Find jobs said "paused" twice. With list panels repeating the page title and pagers on two lines, the owner and testers often saw only two or three rows of data at 1440 by 843.

## Decision

- **A condition that affects a page but is owned by another screen is a toned item on the header status line, not a box.** That covers paused activity, a search-setup blocker, setup in progress, the latest automatic run, and a bulk follow-up for the page's own list.
- **The page header is one row**: the title, a one-line description of 90 characters or fewer, and at most two small actions. The status line sits under it only when there is something to report; there is no "all clear" text and no reserved height.
- **Each item is a dot, plain text and at most one action.** Red is critical, amber is a warning, blue is information, and run summaries have no dot. A link goes to the screen that owns the detail; a button is only for a page-level action done right there, and the line holds at most one button. Items that do not fit collapse into "+N more", which lists every item. Any item can be hidden for the visit, and a condition that still holds comes back on the next visit.
- **A tinted box remains only for a decision needed right here before the content can be used**, placed next to that content, and for a failure that needs a retry on a specific control (ADR 0042). A search failure with a retry sits in the Results column it concerns.
- **List panels follow the same rule one level down**: one toolbar row that never repeats the page title or a count already shown, bulk actions in that row only while rows are ticked, and a one-line pager.
- **A route action message carries a tone** (success, failure or progress). A success on Applications and Find jobs becomes a toast; a failure, a message in progress and a message without a tone stay inline.

## Consequences

At 1440 by 843, Applications shows 4 rows instead of 2, Tracker 6 instead of 4, and Find jobs 4 instead of 3. Conditions from other screens no longer push content down, and their full explanation stays on the screen that owns them. Other screens' action messages stay inline until their writes carry a tone.
