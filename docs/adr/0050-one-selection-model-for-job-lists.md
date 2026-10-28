# ADR 0050: One selection model for job lists

Status: partly superseded: shared job lists use filter-wide select-all with exclusions and virtualized rows rather than page-only selection and pagers (a87c505b, cec85075). Shared checkbox, range and keyboard selection remain accepted.

## Context

Find jobs showed a bare checkbox beside each row; Shortlisted hid its checkboxes behind a "Choose jobs" mode and let only jobs without a resume be ticked. Neither had a select-all box, a range, or a way to tick a row without opening it, and the two list-and-details screens also used different column splits and pager shapes.

## Decision

- Find jobs and Shortlisted share one model (`components/list-selection.tsx`): a checkbox column on every row whose whole strip is the click target, and a page checkbox above the rows that is ticked, partly ticked (a dash) or empty.
- Shift+click ticks a range from the last row ticked; Ctrl/Cmd+click ticks a row without opening it; Ctrl/Cmd+A ticks the page and Escape clears while the list has focus.
- Any shortlisted job can be ticked. Each action names how many of the ticked jobs it applies to ("Create 3 resumes" for 5 ticked when 2 already have one), and "Remove from shortlist" acts on all of them in one request.
- Ticks stay across pages and filters; they are dropped for another plan, for jobs that leave the list, and after an action runs. Nothing about the selection is saved.
- Find jobs, Shortlisted and Applications share one column split (`LIST_DETAIL_COLUMNS_CLASS`) and the pager shows the same icon buttons at every width.

## Consequences

Selection works the same on both lists, and bulk work no longer starts with a mode switch. Rows that cannot be acted on (a job already in Shortlisted, in Find jobs) keep a disabled checkbox so the column reads as one grid.
