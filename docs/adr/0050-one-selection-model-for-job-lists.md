# ADR 0050: One selection model for job lists

Status: accepted, revised 2026-11-02. Shared job lists use filter-wide select-all with exclusions and virtualized rows rather than page-only selection and pagers (a87c505b, cec85075). The permanent checkbox column is replaced by a select mode that every working list shares (owner request during the UI hill climb); the earlier "no mode switch" decision is superseded.

## Context

Find jobs showed a bare checkbox beside each row; Shortlisted hid its checkboxes behind a "Choose jobs" mode and let only jobs without a resume be ticked. Neither had a select-all box, a range, or a way to tick a row without opening it, and the two list-and-details screens also used different column splits and pager shapes.

The first shared model put a 40 px checkbox column on every row of every list. Row selection worked, but the column took width from every row for an action used in bursts, the select-all box was an unlabelled 16 px square in the list header, some lists had no visible Select all, and ticking a row swapped the filter and sort for the bulk actions, hiding what the selection was made from.

## Decision

- One implementation in the shared list primitives (`features/job-lists`: `ListPane`, `ListRowFrame`, `ListRowCheck`, `useRowPress`, `list-selection.ts`, `useListKeys`). Find jobs (Found, Shortlisted, Hidden), Shortlisted (To review, Approved), the Applications list, Needs you (items and Saved answers) and Profile › Job sources all use it.
- Rows have no checkbox column. The list header has two fixed-height rows: the list's own tools (filter, sort, fit floor), which never change, and a status row with the count or scope and a labelled **Select** button. An empty list offers no enabled Select.
- Select mode starts with the Select button, a Shift+click (range) or Cmd/Ctrl+click on a row, X or Space on the open row, or Cmd/Ctrl+A. It ends with **Done**, Escape, or once a bulk action runs. In select mode a click on a row ticks it (and makes it the open row, so X and J/K carry on from there).
- In select mode each row's tick box takes the row's leading slot: the row's left padding grows from 16 px to 44 px over 160 ms, once, when the mode starts or ends; ticking never moves anything and rows keep their height. The tick box's whole 44 px strip is its target.
- The status row in select mode, at the same height: a tri-state box, "N selected", "Select all N matching" when every loaded row is ticked and more match, the list's actions (the main one filled, the others outlined), **Clear** (unticks, stays in the mode) and **Done**. Cmd/Ctrl+A works in the same two steps: the rows shown, then every match.
- "All matching" is the list's filter plus excluded ids; ids are never loaded to select them. A list counted past 1,000 reads its exact count once per query, so the list count, "Select all N matching" and "N selected" say the same number, with thousands separators. Bulk buttons carry the exact scope in their accessible name ("Hide 1,245 jobs") and show a pending state.
- Changing the filter, sort or tab unticks everything and keeps select mode on. Nothing about the selection is saved.
- Find jobs, Shortlisted and Applications share one column split (`LIST_DETAIL_COLUMNS_CLASS`).

## Consequences

Rows get their full width back, every working list offers the same Select, Select all N, Clear and Done, and the filter that defines a selection stays visible and usable while selecting. Bulk work starts with one press (Select, a modified click, X or Cmd/Ctrl+A) instead of a permanent column.
