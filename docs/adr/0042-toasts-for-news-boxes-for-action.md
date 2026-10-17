# ADR 0042: Toasts for news, tinted boxes only when the person must act

Status: accepted (2026-10-04)

## Context

About ninety tinted boxes (amber, blue and green panels) sat across 42 renderer files, and the app had no transient notice. Every outcome, status and explanation became a box above the content: Find jobs could show "Search started", a blue "1 of 31 matches ready… asking the assistant" box and a green "Search finished" box that unfolded into the agent's notes and raw browser errors, all at once above the results. The owner and four testers in the third usability round called the screens cluttered, and with every message boxed, the few that needed action did not stand out.

## Decision

- **A tinted box means the person must act or something is at risk**: a hold, a failure with a retry, a choice between overwriting and discarding, an uncertain send, a required sign-in. Red is failed or blocked, amber needs a decision, blue is only for a process the person is waiting on, and green is never a standing box.
- **Something that just happened and needs nothing is a toast**: a finished or stopped search, a background merge that kept the person's edits, setup becoming ready. Toasts appear at the bottom left of the content, stay six seconds (longer while hovered or focused), offer at most one action and can be dismissed. Only a change seen on this visit is announced; arriving at a screen does not replay old news.
- **A failure that needs action never lives only in a toast.** It stays inline next to the control it concerns.
- **Live status belongs to the control that owns it.** A running search shows one plain line under the Results header (source and progress), not a box; the agent's own notes stay in Activity.
- **Explanations and optional hints are plain text**: no tint, no border. An "all clear" is a plain line or nothing.
- **One problem gets one box.** A second box restating the same problem is removed.
- **Bottom left, not a right corner.** Nestor's screens keep their main actions on the right: page actions and Search now at the top, the detail panels' action rows and the save footers at the bottom, and the Assistant docks there. The bottom left holds list rows and footer status text, so a toast there covers nothing the person is about to press.

Native `<select>` dropdowns draw the same single chevron as the custom Select, inset from the edge, in the same change: one shared style instead of the platform arrow.

## Consequences

Find jobs shows results, not notices, after a search. Outcome text stays complete in Home, Search history and Activity, which are where the full accounting belongs. Screens that still report action results through the route's action message are unchanged; that message carries no success or failure tone yet, so moving it to toasts would put failures in toasts.
