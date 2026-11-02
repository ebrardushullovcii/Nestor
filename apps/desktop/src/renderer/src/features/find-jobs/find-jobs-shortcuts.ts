/** The Find jobs keys, as the Keyboard shortcuts dialog lists them. */
export function findJobsShortcutHelp(modifier: string) {
  // The list keys work on every list (Find jobs, Shortlisted, Applications,
  // Needs you); moving a job between stages is Find jobs' own.
  const everyList = "Every list";
  const findJobs = "Find jobs";
  return [
    [
      "find-jobs-next",
      "Next or previous item",
      [["J"], ["K"], ["↓"], ["↑"]],
      everyList,
    ],
    ["find-jobs-open", "Open the listing", [["O"], ["Enter"]], everyList],
    [
      "find-jobs-tick",
      "Select the item and start select mode (Shift for a range)",
      [["X"], ["Space"]],
      everyList,
    ],
    [
      "find-jobs-all",
      "Select the items shown; again for every matching item",
      [[modifier, "A"]],
      everyList,
    ],
    ["find-jobs-clear", "Leave select mode", [["Esc"]], everyList],
    [
      "find-jobs-undo",
      "Undo the last move",
      [["U"], [modifier, "Z"]],
      everyList,
    ],
    ["find-jobs-shortlist", "Shortlist", [["S"]], findJobs],
    ["find-jobs-hide", "Hide", [["H"]], findJobs],
    [
      "find-jobs-back",
      "Show again or move back to Find jobs",
      [["R"]],
      findJobs,
    ],
  ].map(([id, label, combos, scope]) => ({
    group: "Lists" as const,
    id: id as `find-jobs-${string}`,
    rowId: id as string,
    label: label as string,
    scope: scope as string,
    combos: combos as string[][],
  }));
}
