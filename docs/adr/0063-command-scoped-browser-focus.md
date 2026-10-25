# ADR 0063: Hidden browser tabs paint only for commands that need frames

Status: accepted (2026-10-24).

## Context

An automation claim disabled background throttling, and each page command kept
that override and focus emulation for five seconds afterward. Electron applies
disabled background throttling to every WebContents in the host window. Ten
background sources could therefore paint together while the model was thinking.
Simply removing focus breaks Playwright's hidden-page stability checks, which
wait for animation frames before clicks. Native DOM reads need no frames.

## Decision

Keep native background throttling enabled in each view's creation preferences.
Do not reassert it with runtime setters: on Electron 44, repeated `true` setters
while adding tabs restarted hidden animation frames despite hidden visibility
and the preference still reporting `true`. Removing the redundant setters kept
ten hidden tabs at zero frames in the same native probe. Wake the exact page
for a command without focus. Input and screenshots receive focus immediately;
a script still pending after two frame intervals receives temporary focus so
animation-frame-based waits can complete. Release focus when that command ends,
including errors and overlapping native reads. This adds one bounded timer to a
pending script; it avoids rendering for ordinary completed text reads.

Keep the ten-second field-autosave settling window separate from focus. It delays
freezing retained forms but never paints them. Native read-only probes neither
extend nor cancel it. Existing ownership, handoff, person-tab exclusions,
finished-tab cleanup and verified prepared-form reconstruction stay in place
(ADRs 0017, 0034 and 0055).
Close the unclaimed connection placeholder when the first useful tab replaces it;
it no longer needs a renderer or a working slot.
Only a displayed finished tab stays for watching; a selected tab behind a hidden
panel closes when its work releases it, under the same ownership exclusions.

A requested screenshot waits for a fresh frame on its own page, then captures
without disabling throttling on the host window. It adds no periodic capture,
polling, model decision, or application authority. Playwright's protocol domains
remain enabled while it owns a page because it uses their events for navigation,
frames, interception and guards; closing the page releases them.

## Consequences

Ordinary hidden reads do not run page animations. A command that needs animation
frames can take two additional frame intervals to begin. Native browser checks
must cover hidden clicks, uploads, waits, screenshots, takeover and recovery;
resource measurements must use the native host without global Playwright focus
or background-throttling overrides.
