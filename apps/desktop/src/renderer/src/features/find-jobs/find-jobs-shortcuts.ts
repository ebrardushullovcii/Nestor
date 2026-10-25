/** The Find jobs keys, as the Keyboard shortcuts dialog lists them. */
export function findJobsShortcutHelp(modifier: string) {
  const scope = "Find jobs";
  return [
    ["find-jobs-next", "Next or previous job", [["J"], ["K"], ["↓"], ["↑"]]],
    ["find-jobs-shortlist", "Shortlist", [["S"]]],
    ["find-jobs-hide", "Hide", [["H"]]],
    ["find-jobs-back", "Show again or move back to Find jobs", [["R"]]],
    ["find-jobs-undo", "Undo the last move", [["U"], [modifier, "Z"]]],
    ["find-jobs-tick", "Tick the job (Shift for a range)", [["X"], ["Space"]]],
    ["find-jobs-all", "Select every job in the list", [[modifier, "A"]]],
    ["find-jobs-clear", "Clear the selection", [["Esc"]]],
    ["find-jobs-open", "Open the listing", [["O"], ["Enter"]]],
  ].map(([id, label, combos]) => ({
    id: id as `find-jobs-${string}`,
    rowId: id as string,
    label: label as string,
    scope,
    combos: combos as string[][],
  }));
}
