# Settings, workspace search and keyboard shortcuts

The screens that are not a list: Settings, the workspace search dialog (⌘K / Ctrl+K) and the keyboard shortcuts reference (?). Deterministic AI is enough for all three.

## Sub-features

- `settings-layout`: Settings › one bordered card per section (AI behavior, Resume look, Applying, App & device, Diagnostics, Delete everything); inside, plain groups under one hairline and rows with the label and help on the left, the control on the right (`[data-settings-row]`). The sticky band "Settings sections" marks the section whose heading has slid under it (`aria-current="location"`); at the end of the page the last section is current.
- `settings-save`: choices and switches save at once (with Undo where it matters); typed instructions wait for their section's "Save …" button, which the bottom bar `[data-settings-unsaved-bar]` also offers. The page header says so.
- `settings-template`: Resume look › "Default resume template" is a grid of thumbnail cards `[data-resume-template-grid]`; each card is a button named "Use <template>" or "Selected template: <template>" with `aria-pressed` and `data-resume-template-select`; the chosen one has the accent ring and a check. The large preview beside it is "Current selection".
- `workspace-search`: header "Search your workspace" (⌘K). Two letters search; results are grouped (Go to, Jobs, Applications) with a count per group; the first result is highlighted (`data-highlighted="true"`, `aria-activedescendant`) and Enter opens it; ↑/↓ move. No match shows "No results for “…”" with a hint (`[data-job-finder-global-search-empty]`). "Close search" (Esc) sits in the dialog's corner. An approved job with an application under way shows that application's state in its subtitle ("Needs you", "Ready to send", "Applying"), not "Approved".
- `shell-counts`: sidebar destinations keep their plain names ("Find jobs", "Shortlisted", "Applications"); the count and what it counts are the row's `aria-description` and tooltip ("12,345 found", "2 to review", "1 sent"). The rail shows exact figures to 9,999, then "12.3k". Header tools reserve no room for a count: a count (Activity running, Needs you) is a small pill pinned to the tool's top-right corner, so every tool keeps its natural width and the gaps between tools are equal. Activity is a button with `aria-expanded` (it was a `<summary>`).
- `shortcuts`: "Keyboard shortcuts" (sidebar footer, or ?) groups the keys under Everywhere, Lists, Resume and Browser (`[data-job-finder-shortcut-group]`), with ⌘/⌥ on macOS and Ctrl/Alt elsewhere.

## Driving it with verify-nestor

- Settings: `$V/drive click Settings --role button --within Workspace`; scroll a section into view with `eval` on `#settings-application-defaults` and check the band's current link with `$V/drive see`.
- Search: `$V/drive click "Search your workspace" --role button`, type with `page.keyboard.type("engineer")` in a journey, shoot, then `press Escape`.
- Shortcuts: `$V/drive press ?` from a screen with no text field focused.

## Gotchas

- Template thumbnails render only once the Resume look section comes near the screen; wait a second after scrolling before a shot.
