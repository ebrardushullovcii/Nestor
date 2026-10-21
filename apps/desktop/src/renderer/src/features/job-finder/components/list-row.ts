/**
 * The one list-row treatment shared by every Job Finder collection list.
 *
 * Find jobs, Shortlisted and Applications used to look like three different
 * products: Find jobs drew flat rows ruled by a divider inside one bordered
 * panel, Shortlisted drew every job as its own rounded bordered card with a
 * status badge floating above the title, and Applications drew a third
 * variant again. A user reading the two screens side by side asked why there
 * are "so many different types of lists like this".
 *
 * There is now exactly one answer, and these constants are it:
 *
 *  - rows are flat and flush inside the single bordered panel. The shared
 *    `SelectableRow` primitive ships a card box (rounded, fully bordered);
 *    `jobFinderListRowClassName` turns that off and leaves one bottom rule as
 *    the divider between rows, so no row carries a border or rounding of its
 *    own;
 *  - every row uses the same padding and the same three-slot type scale:
 *    title line, meta line, status line;
 *  - the status badge sits in ONE slot - trailing on the title line - in all
 *    three lists, never floating over the row above the title;
 *  - selection stays entirely the primitive's business: a background tint plus
 *    an inset accent bar. Nothing here varies with selection, which is the
 *    no-layout-shift invariant `SelectableRow` enforces at runtime and
 *    `discovery-results-panel.selection-metrics.test.tsx` pins.
 *
 * List-specific content still differs - the fit verdict on Find jobs, resume
 * readiness on Shortlisted, the next step on Applications - but it is rendered
 * into these same slots.
 */

/**
 * The row box. Every list passes this to `SelectableRow`; nothing else may
 * add a border or a corner radius to a row.
 */
const jobFinderListRowClassName = [
  "grid gap-1.5",
  // Flat and flush: no card border, no rounding, one bottom rule as the
  // divider between rows.
  "rounded-none border-x-0 border-t-0 border-b border-b-(--surface-panel-border)",
  // Tight enough that a 1032px window shows eight or more rows, not five.
  "px-4 py-3",
  // Keeps the focus ring above the neighbouring row's divider.
  "focus-visible:z-10",
].join(" ");

/**
 * Find jobs is the only list with a user-chosen density switch. Compact tightens
 * the same box; it never restores a border or a radius.
 */
const jobFinderListRowCompactClassName = "gap-2 p-3";

/**
 * The region the rows sit in: no list markers, no gutter and — the part that
 * matters — no gap, so consecutive rows meet at their shared divider instead
 * of floating apart as separate cards. Each list adds its own sizing and
 * scroll behaviour on top.
 */
const jobFinderListRegionClassName = "m-0 grid list-none content-start p-0";

/** Title line: the title on the left, the status badge slot trailing. */
const jobFinderListRowTitleLineClassName =
  "flex min-w-0 items-start justify-between gap-3";

/**
 * The one badge slot, trailing on the title line.
 *
 * `shrink-0` here was a bug with teeth: it pins the slot at max-content, so
 * `flex-wrap` can never engage, and the sibling title — which carries
 * `min-w-0` — absorbs the entire overflow. A Find jobs row can carry three to
 * five badges (recommendation, Provisional, listing activity, application
 * status, a posting-date badge), which is enough to crush the title to nothing
 * and push the row into a horizontal scrollbar. The badges used to live in a
 * full-width wrapping row below the title, which is exactly why they could
 * never do this.
 *
 * `min-w-0` lets the slot shrink, `max-w-[55%]` guarantees the title at least
 * 45% of the line, and `flex-wrap` can now actually run: extra badges stack
 * onto further lines inside the slot instead of eating the title.
 */
// `shrink-0`: the slot keeps its content width and the title wraps instead,
// so a badge is never truncated to "NEEDS APPR…" beside a long title.
const jobFinderListRowBadgeSlotClassName =
  "flex min-w-0 max-w-[55%] shrink-0 flex-wrap items-center justify-end gap-1.5";

/**
 * The one inner line rhythm: title -> meta -> status. All three lists stack
 * their content lines in this, so the vertical rhythm inside a row is a
 * property of the treatment rather than of which list you happen to be on.
 * The row's own `gap` separates blocks; this separates lines.
 */
const jobFinderListRowLinesClassName = "grid min-w-0 gap-1.5";

/** The row title itself. */
const jobFinderListRowTitleClassName =
  "min-w-0 break-words text-(length:--text-heading-3) text-(--text-headline)";

/** The meta line under the title: employer, location, source. */
const jobFinderListRowMetaClassName =
  "min-w-0 break-words text-(length:--text-small) text-foreground-soft";

/** The status line under the meta line: fit verdict, readiness, next step. */
const jobFinderListRowStatusClassName =
  "min-w-0 break-words text-(length:--text-small) leading-5";

export {
  jobFinderListRegionClassName,
  jobFinderListRowBadgeSlotClassName,
  jobFinderListRowClassName,
  jobFinderListRowCompactClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowMetaClassName,
  jobFinderListRowStatusClassName,
  jobFinderListRowTitleClassName,
  jobFinderListRowTitleLineClassName,
};
