import type { ApplyFormObservation } from "./types";
/** Identity of a page-local handle, independent of its value or new controls. */
export function refIdentity(
  page: ApplyFormObservation,
  ref: string,
): string | null {
  const control = page.controls.find((entry) => entry.ref === ref);
  if (control)
    return JSON.stringify({
      url: page.url,
      nativeIdentity: control.nativeIdentity,
      scopeKey: control.scopeKey,
      rowScopeKey: control.rowScopeKey,
      frame: control.frame,
      kind: control.kind,
      label: control.label,
      group: control.groupLabel,
      choiceGroupKey: control.choiceGroupKey,
    });
  const entry = [...page.actions, ...page.clickables, ...page.links].find(
    (entry) => entry.ref === ref,
  );
  return entry
    ? JSON.stringify({
        url: page.url,
        label: entry.label,
        kind: "kind" in entry ? entry.kind : undefined,
        href: "href" in entry ? entry.href : undefined,
      })
    : null;
}
