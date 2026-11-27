/**
 * How each list drawn on a page relates to one field. A field's lookup list
 * is the one it names, or the one that floats open beside it; a list sitting
 * in the page flow inside the field's own box is what the field holds (the
 * chosen-item pills of a Workday prompt), and one inside another field's box
 * belongs to that field. Reaching for "the nearest listbox" read Workday's
 * pills, and another field's pill, as the options a search offered.
 */

export type ListboxRelation =
  /** The field names it: aria-controls, aria-owns or aria-activedescendant. */
  | "owned"
  /** It floats over the page: positioned, a popover or an open dialog. */
  | "popup"
  /** In the page flow inside this field's own box: what the field holds. */
  | "own"
  /** In the page flow inside another field's box. */
  | "other";

export interface ListboxFacts {
  /** The value of the mark attribute this read put on the list. */
  mark: string;
  relation: ListboxRelation;
  /** Its rows and text, so a later read can tell whether it changed. */
  signature: string;
  /** Depth of the box it shares with the field; deeper is nearer. */
  depth: number;
  /** Drawn just above or below the field, overlapping it sideways. */
  adjacent: boolean;
  /** The visible text of each drawn row. */
  items: string[];
}

import { APPLY_LISTBOX_TRIGGER_SELECTOR } from "@nestor/contracts";

type ListboxReader = (control: Element, mark: string) => ListboxFacts[];

/** Self-contained: serialized into the page. */
function readListboxFacts(
  control: Element,
  mark: string,
  listboxTriggerSelector: string,
): ListboxFacts[] {
  const parentOf = (node: Element): Element | null => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const chain = new Set<Element>();
  for (let at: Element | null = control; at; at = parentOf(at)) chain.add(at);
  const shown = (node: Element) =>
    node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== "hidden";
  const roots: Array<Document | ShadowRoot> = [document];
  const own = control.getRootNode();
  if (own instanceof ShadowRoot) roots.push(own);
  for (let index = 0; index < roots.length; index++)
    for (const node of roots[index]!.querySelectorAll("*"))
      if (node.shadowRoot && !roots.includes(node.shadowRoot))
        roots.push(node.shadowRoot);
  const lists = [
    ...new Set(
      roots.flatMap((root) => [...root.querySelectorAll("[role='listbox']")]),
    ),
  ].filter(
    (list) => list !== control && !list.contains(control) && shown(list),
  );
  const named = new Set(
    [
      ...(control.getAttribute("aria-controls") ?? "").split(/\s+/u),
      ...(control.getAttribute("aria-owns") ?? "").split(/\s+/u),
    ].filter(Boolean),
  );
  const activeId = control.getAttribute("aria-activedescendant");
  const opensList = control.matches(listboxTriggerSelector);
  const active = activeId
    ? ((own as Document | ShadowRoot).getElementById?.(activeId) ??
      document.getElementById(activeId))
    : null;
  // Fields a person types into or picks from; a list's own rows may hold
  // checkboxes, and only listbox buttons are fields.
  const field = `input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='image']):not([type='checkbox']):not([type='radio']):not([type='file']), select, textarea, [role='combobox'], [role='textbox'], [role='spinbutton'], [contenteditable='true'], ${listboxTriggerSelector}`;
  const box = control.getBoundingClientRect();
  return lists.map((list) => {
    if (!list.getAttribute(mark))
      list.setAttribute(mark, Math.random().toString(36).slice(2));
    const rows = [...list.querySelectorAll("[role='option']")].filter(shown);
    const items = rows
      .map(
        (row) =>
          (row as HTMLElement).innerText?.replace(/\s+/gu, " ").trim() ||
          row.getAttribute("aria-label")?.trim() ||
          "",
      )
      .filter(Boolean);
    let floating = false;
    let at: Element | null = list;
    for (; at && !chain.has(at); at = parentOf(at)) {
      const position = getComputedStyle(at).position;
      if (position === "fixed" || position === "absolute") floating = true;
      if (at instanceof HTMLDialogElement && at.open) floating = true;
      try {
        if (at.matches(":popover-open")) floating = true;
      } catch {
        // A browser without popovers has none open.
      }
    }
    let depth = 0;
    for (let up = at; up; up = parentOf(up)) depth++;
    let relation: ListboxRelation = floating ? "popup" : "other";
    if (
      (list.id && named.has(list.id)) ||
      (opensList &&
        control.id &&
        (list.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/u)
          .includes(control.id)) ||
      (active !== null && list.contains(active))
    )
      relation = "owned";
    else if (!floating)
      for (let up = parentOf(list); up; up = parentOf(up)) {
        if (chain.has(up)) {
          // A listbox button exposes choices, whereas an input may sit
          // beside a separate, always-visible list of its selected items.
          relation = opensList ? "popup" : "own";
          break;
        }
        if (
          [...up.querySelectorAll(field)].some((node) => !list.contains(node))
        )
          break;
      }
    const rect = list.getBoundingClientRect();
    const gap = Math.max(rect.top - box.bottom, box.top - rect.bottom, 0);
    const across =
      Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
    return {
      mark: list.getAttribute(mark)!,
      relation,
      signature: `${rows.length}|${(list.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 4_000)}`,
      depth,
      adjacent: gap <= 64 && across > 0,
      items,
    };
  });
}

/** Each list's signature before an action, by its mark. */
export type ListsBefore = Readonly<Record<string, string>>;

const listboxReader = `(element,mark)=>(
  ${readListboxFacts.toString()}
)(element,mark,${JSON.stringify(APPLY_LISTBOX_TRIGGER_SELECTOR)})`;

/**
 * The list a field's lookup answers in. A list the field names comes first.
 * Otherwise a floating list that opened or changed since the action began,
 * else one already open right beside the field. A list in the field's own
 * box counts only when it appeared or changed since then: before that it is
 * what the field holds. Another field's list never counts. When two remain,
 * the one beside the field, then the nearer one in the page, is the field's;
 * a tie names none.
 */
export function pickLookupList(
  lists: readonly ListboxFacts[],
  before: ListsBefore | null,
): string | null {
  const owned = lists.find((list) => list.relation === "owned");
  if (owned) return owned.mark;
  const changed = (list: ListboxFacts) =>
    before !== null && before[list.mark] !== list.signature;
  const popups = lists.filter((list) => list.relation === "popup");
  const fresh = before === null ? popups : popups.filter(changed);
  let pool = fresh.length ? fresh : popups.filter((list) => list.adjacent);
  if (!pool.length)
    pool = lists.filter((list) => list.relation === "own" && changed(list));
  if (pool.length > 1 && pool.some((list) => list.adjacent))
    pool = pool.filter((list) => list.adjacent);
  if (pool.length > 1) {
    const deepest = Math.max(...pool.map((list) => list.depth));
    pool = pool.filter((list) => list.depth === deepest);
  }
  return pool.length === 1 ? pool[0]!.mark : null;
}

/** What the field holds in the list inside its own box, when it has one. */
export function heldItems(lists: readonly ListboxFacts[]): string[] | null {
  const held = lists.filter((list) => list.relation === "own");
  return held.length ? held.flatMap((list) => list.items) : null;
}

/** Serialize only this fixed reader, never page or model JavaScript. */
export function withListboxReader<Arg, Result>(
  read: (element: Element, arg: Arg, facts: ListboxReader) => Result,
): (element: Element, arg: Arg) => Result {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const compile = new Function(
    `return (element,arg)=>(${read.toString()})(element,arg,${listboxReader})`,
  ) as () => (element: Element, arg: Arg) => Result;
  return compile();
}

/** The same reader for every field of a page read at once. */
export function withListboxesReader<Arg, Result>(
  read: (elements: Element[], arg: Arg, facts: ListboxReader) => Result,
): (elements: Element[], arg: Arg) => Result {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const compile = new Function(
    `return (elements,arg)=>(${read.toString()})(elements,arg,${listboxReader})`,
  ) as () => (elements: Element[], arg: Arg) => Result;
  return compile();
}
