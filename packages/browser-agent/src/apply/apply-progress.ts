import { createHash } from "node:crypto";
import { parseToolArguments } from "@nestor/agent-runtime";
import type { ApplyFormObservation } from "./types";

/** Counts repeated actions against an unchanged form, never total work. */
export function createApplyProgressGuard(limit = 120) {
  const attempts = new Map<string, number>();
  let stuck = false;
  const state = (page: ApplyFormObservation | null) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          page
            ? {
                url: page.url,
                step: page.step,
                loading: page.loading,
                blocker: page.blocker,
                controls: page.controls.map((control) => [
                  control.kind,
                  control.label,
                  control.groupLabel,
                  control.required,
                  control.visible,
                  control.disabled,
                  control.value,
                  control.checked,
                  control.selectedOptionLabel,
                  control.options,
                ]),
                actions: page.actions.map((action) => [
                  action.label,
                  action.kind,
                  action.disabled,
                ]),
                errors: page.validationErrors,
                summaries: page.summaryRows,
                uploads: page.uploads,
              }
            : null,
        ),
      )
      .digest("hex");
  return {
    get stuck() {
      return stuck;
    },
    start(name: string, arguments_: string, page: ApplyFormObservation | null) {
      const before = state(page);
      const args = parseToolArguments(arguments_);
      const ref = typeof args.ref === "string" ? args.ref : null;
      const observed =
        ref &&
        page &&
        [
          ...page.controls,
          ...page.actions,
          ...page.links,
          ...page.clickables,
        ].some((entry) => entry.ref === ref);
      const action = JSON.stringify([
        name,
        ref ? (observed ? ref : "unobserved target") : null,
        args.url,
        args.direction,
        args.key,
        args.method,
        args.option,
        args.text,
        args.checked,
        args.fields,
      ]);
      return (after: ApplyFormObservation | null): boolean => {
        if (state(after) !== before) {
          attempts.clear();
          stuck = false;
          return true;
        }
        // Waiting for the site and reading it again do not consume attempts.
        if (name === "wait" || name === "observe" || name === "read_text")
          return false;
        const key = before + action;
        const count = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, count);
        if (count >= limit) stuck = true;
        return false;
      };
    },
  };
}
