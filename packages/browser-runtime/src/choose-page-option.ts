import { reportSelfLimitHit } from "@nestor/core";
import type { ApplyWriteResult } from "@nestor/contracts";
import {
  APPLY_LISTBOX_TRIGGER_SELECTOR,
  describeBrowserError,
} from "@nestor/contracts";
import type { Frame, Locator, Page, Request, Response } from "playwright";
import { pressableLabel } from "./pressable-label";
import { collectCustomComboboxStates } from "./custom-combobox-state";
import {
  heldItems,
  pickLookupList,
  withListboxReader,
  type ListboxFacts,
  type ListsBefore,
} from "./listbox-relation";

import {
  clickPresent,
  presentControl,
  evaluatePresent,
} from "./present-control";
import { controlResultState } from "./control-result-state";

import { replaceFieldText } from "./replace-field-text";

import { watchPageSelfLimits } from "./self-limit-page";

/** Silence in the observed list state before reporting that it stopped progressing. */
const IDLE_MS = 5_000;
/** A list unchanged this long, and not loading, has finished drawing. */
const STABLE_MS = 700;
const POLL_MS = 150;
/** Names a list found beside its control, so later reads find the same one. */
const LIST_MARK = "data-nestor-option-list";

/** Spelling only: spacing, case and Unicode forms do not make a different choice. */
export function normalizeOptionLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

// "Select…", "-- Choose one --" or a blank row holds the place of a choice.
const PLACEHOLDER =
  /^[-–—\s.…]*(?:(?:please\s+)?(?:select|choose|pick)\b.*)?$/iu;
// A row a list shows while it fetches is not one of its choices.
const LOADING_ROW = /^(?:loading|searching|fetching|please wait)\b/iu;
const NO_RESULTS =
  /\bno (?:options|results|matches|items)(?: found| available)?\b|\b0 results\b/iu;

const missing = (
  label: string,
  offeredOptions: string[],
): ApplyWriteResult => ({
  ok: false,
  reason: "option_not_offered",
  offeredOptions,
  error: `The list did not offer "${label}".`,
});

/** The list could not prove what it offers; never evidence that a choice is absent. */
const uncertain = (error: string): ApplyWriteResult => ({ ok: false, error });

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reports the list's response to one requested choice, never chooses an
 * alternative. A searchable list can report the choices a settled search
 * offered even when the picker does not expose its entire inventory.
 */
export async function choosePageOption(
  page: Page,
  locator: Locator,
  label: string,
): Promise<ApplyWriteResult> {
  watchPageSelfLimits(page);
  const requests = watchControlRequests(page, locator);
  const progressAt = requests.progressAt;
  let latest: ListState = {
    visible: false,
    loading: false,
    noResults: false,
    options: [],
  };
  const seen = new Map<string, string>();
  let complete = false;
  const report: ListReport = (state, finished = false) => {
    latest = state;
    complete = finished;
    for (const option of state.options)
      seen.set(normalizeOptionLabel(option), option);
  };
  try {
    await requests.bound;
    const native = await evaluatePresent(
      locator,
      (element) => element.tagName === "SELECT",
      undefined,
    );
    const before = native ? {} : await openListsBefore(locator);
    const result = await (native
      ? chooseNativeOption(locator, label, progressAt, report)
      : chooseCustomOption(page, locator, label, progressAt, report, before));
    if (!native) {
      // A list this call opened and did not choose from is closed again, so
      // it does not lie over the next field.
      if (!result.ok) await closeList(locator);
      const scope = (await controlFrame(locator)) ?? page;
      const list = await boundList(scope, locator, before);
      const state = list ? await readList(list) : null;
      const expanded = await attribute(locator, "aria-expanded");
      if (state)
        report(
          {
            ...state,
            visible: expanded === "false" ? false : state.visible,
            loading:
              state.loading ||
              (await attribute(locator, "aria-busy")) === "true",
          },
          complete,
        );
      else
        latest = {
          ...latest,
          visible: expanded === "true",
          loading: (await attribute(locator, "aria-busy")) === "true",
        };
    }
    return {
      ...result,
      controlState: await controlResultState(locator),
      optionList: {
        open: latest.visible,
        busy: latest.loading,
        options: [...seen.values()],
        complete,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: describeBrowserError(
        error,
        "The picker could not select that option.",
      ),
      controlState: await controlResultState(locator),
      optionList: {
        open: latest.visible,
        busy: latest.loading,
        options: [...seen.values()],
        complete,
      },
    };
  } finally {
    requests.stop();
  }
}

/**
 * The choices a list offers, for a question handed to the person. Opens the
 * list the way select does, reads it to its end without choosing, and closes
 * it again. Null when the list cannot be read.
 */
export async function readPageOptions(
  page: Page,
  locator: Locator,
): Promise<string[] | null> {
  const native = await evaluatePresent(
    locator,
    (element) =>
      element instanceof HTMLSelectElement
        ? Array.from(element.options)
            .filter((option) => !option.disabled && option.value !== "")
            .map((option) => option.text.replace(/\s+/gu, " ").trim())
        : null,
    undefined,
  );
  if (native) return native.filter((text) => !PLACEHOLDER.test(text));
  const requests = watchControlRequests(page, locator);
  try {
    await requests.bound;
    const scope = (await controlFrame(locator)) ?? page;
    const before = await openListsBefore(locator);
    await openCustomList(scope, locator, before);
    // No row can match this, so the list is read to its end.
    const nothing = "\u0000";
    const shown = await settle(
      scope,
      locator,
      before,
      nothing,
      IDLE_MS,
      false,
      nothing,
      requests.progressAt,
    );
    if (shown.kind !== "settled") return null;
    const read = await readWholeList(shown.list, nothing);
    return read.options.length ? read.options : null;
  } finally {
    requests.stop();
    await closeList(locator);
  }
}

/**
 * Leaves the picker the way a person leaves one they gave up on: focus moves
 * away, which closes its list and drops unfinished search text.
 */
async function closeList(locator: Locator): Promise<void> {
  await evaluatePresent(
    locator,
    (element) => {
      const active = (element.getRootNode() as Document | ShadowRoot)
        .activeElement;
      (element as HTMLElement).blur();
      if (active instanceof HTMLElement && active !== element) active.blur();
    },
    undefined,
  ).catch(() => undefined);
}

/** What one control's own document is fetching. */
export interface ControlRequests {
  /** When that document's connection last moved; now while a request is open. */
  progressAt: () => number;
  /** Resolves once requests are attributed to the control's frame. */
  bound: Promise<void>;
  stop: () => void;
}

/**
 * Watches the requests the control's own document makes. Only that document
 * fetches its choices. Another frame's traffic, such as a challenge widget
 * that keeps polling, is not the list loading and would otherwise keep it
 * "busy" without end. Start it before the keys go in so the lookup they
 * trigger is seen.
 */
export function watchControlRequests(
  page: Page,
  locator: Locator,
): ControlRequests {
  let lastNetworkProgress = Date.now();
  const pending = new Set<Request>();
  let frame: Frame | null = null;
  const fromControl = (request: Request) => {
    if (!frame) return true;
    try {
      return request.frame() === frame;
    } catch {
      return false;
    }
  };
  const requestStarted = (request: Request) => {
    if (!fromControl(request)) return;
    pending.add(request);
    lastNetworkProgress = Date.now();
  };
  const networkProgress = (request: Request) => {
    if (!pending.delete(request) && !fromControl(request)) return;
    lastNetworkProgress = Date.now();
  };
  const response = (answer: Response) => {
    if (fromControl(answer.request())) lastNetworkProgress = Date.now();
  };
  page.on?.("request", requestStarted);
  page.on?.("response", response);
  page.on?.("requestfinished", networkProgress);
  page.on?.("requestfailed", networkProgress);
  const bound = controlFrame(locator)
    .catch(() => null)
    .then((owner) => {
      frame = owner;
      for (const request of pending)
        if (!fromControl(request)) pending.delete(request);
    });
  return {
    progressAt: () => (pending.size ? Date.now() : lastNetworkProgress),
    bound,
    stop: () => {
      page.off?.("request", requestStarted);
      page.off?.("response", response);
      page.off?.("requestfinished", networkProgress);
      page.off?.("requestfailed", networkProgress);
    },
  };
}

/**
 * After text goes into a field, waits for the field's own lookup to answer:
 * the requests from its document are done and its list has stopped changing
 * (the same idle and stability clocks the picker uses). Returns what the
 * list then offers, or nothing when the field names no list.
 */
export async function settleFieldLookup(
  page: Page,
  locator: Locator,
  requests: ControlRequests,
  before: ListsBefore,
): Promise<ApplyWriteResult["optionList"]> {
  await requests.bound;
  const scope = (await controlFrame(locator).catch(() => null)) ?? page;
  let lastKey: string | null = null;
  let stableSince = Date.now();
  for (;;) {
    const list = await boundList(scope, locator, before).catch(() => null);
    const state = list ? await readList(list) : null;
    const expanded = await attribute(locator, "aria-expanded").catch(
      () => null,
    );
    const busy =
      (state?.loading ?? false) ||
      (await attribute(locator, "aria-busy").catch(() => null)) === "true";
    const key = JSON.stringify({ state, busy, expanded });
    if (key !== lastKey) {
      lastKey = key;
      stableSince = Date.now();
    }
    const quiet = Date.now() - Math.max(stableSince, requests.progressAt());
    if ((!busy && quiet >= STABLE_MS) || quiet >= IDLE_MS) {
      if (busy)
        reportSelfLimitHit({
          limit: "field_lookup_idle",
          kind: "idle",
          value: IDLE_MS,
          where: "browser-runtime/settleFieldLookup",
        });
      if (!state) return undefined;
      const open = expanded === "false" ? false : state.visible;
      return {
        open,
        busy,
        options: open ? state.options : [],
        complete: open && !busy,
      };
    }
    await pause(POLL_MS);
  }
}

type ListReport = (state: ListState, complete?: boolean) => void;

interface NativeState {
  disabled: boolean;
  busy: boolean;
  options: Array<{ text: string; value: string; disabled: boolean }>;
}

async function chooseNativeOption(
  locator: Locator,
  label: string,
  networkProgress: () => number,
  report: ListReport,
): Promise<ApplyWriteResult> {
  const wanted = normalizeOptionLabel(label);
  let lastKey = "";
  let stableSince = Date.now();
  for (;;) {
    const state = await evaluatePresent(
      locator,
      (element): NativeState => {
        const select = element as HTMLSelectElement;
        return {
          disabled: select.disabled,
          busy: select.getAttribute("aria-busy") === "true",
          options: Array.from(select.options).map((option) => ({
            text: option.text,
            value: option.value,
            disabled: option.disabled,
          })),
        };
      },
      undefined,
    );
    report(
      {
        visible: false,
        loading: state.busy,
        noResults: false,
        options: state.options
          .filter(
            (option) =>
              !option.disabled &&
              option.value !== "" &&
              !PLACEHOLDER.test(option.text),
          )
          .map((option) => option.text),
      },
      !state.busy && !state.disabled,
    );
    const index = state.options.findIndex(
      (option) =>
        !option.disabled && normalizeOptionLabel(option.text) === wanted,
    );
    if (index >= 0 && !state.disabled) {
      const select = await presentControl(locator);
      try {
        await select.selectOption({ index }, { force: true });
      } finally {
        await select.dispose();
      }
      const chosen = await evaluatePresent(
        locator,
        (element) =>
          (element as HTMLSelectElement).selectedOptions[0]?.text ?? "",
        undefined,
      );
      const held = chosen.replace(/\s+/gu, " ").trim();
      return normalizeOptionLabel(chosen) === wanted
        ? { ok: true, observedValue: held }
        : uncertain(
            held
              ? `After "${label}" was chosen the list holds "${held}", so "${label}" is not what it holds.`
              : `The list did not keep "${label}" selected.`,
          );
    }
    const real = state.options
      .filter(
        (option) =>
          !option.disabled &&
          option.value !== "" &&
          !PLACEHOLDER.test(option.text),
      )
      .map((option) => option.text.replace(/\s+/gu, " ").trim());
    const key = JSON.stringify(state);
    if (key !== lastKey) {
      lastKey = key;
      stableSince = Date.now();
    }
    // A dependent list fills in after another answer; an empty or
    // placeholder-only list has not offered anything yet.
    if (
      !state.disabled &&
      !state.busy &&
      real.length > 0 &&
      Date.now() - stableSince >= STABLE_MS
    )
      return missing(label, real);
    if (Date.now() - Math.max(stableSince, networkProgress()) >= IDLE_MS) {
      reportSelfLimitHit({
        limit: "native_option_idle",
        kind: "idle",
        value: IDLE_MS,
        where: "browser-runtime/chooseNativeOption",
      });
      return uncertain(
        "The list had no choices to read yet, so whether it offers that option is unknown.",
      );
    }
    await pause(POLL_MS);
  }
}

interface ListState {
  visible: boolean;
  loading: boolean;
  noResults: boolean;
  options: string[];
}

/** Enumerate actual DOM rows, including open shadow roots. */
function optionNodes(
  element: Element,
  visitRoot?: (root: Element | ShadowRoot) => void,
): Element[] {
  const nodes = new Set<Element>([element]);
  const roots: Array<Element | ShadowRoot> = [element];
  if (element.shadowRoot) roots.push(element.shadowRoot);
  for (const root of roots) {
    visitRoot?.(root);
    for (const node of root.querySelectorAll("*")) {
      nodes.add(node);
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  }
  return [...nodes];
}

/** Serialize only our fixed DOM readers, never page or model JavaScript. */
function withOptionReaders<Arg, Result>(
  read: (
    element: Element,
    arg: Arg,
    nodes: typeof optionNodes,
    label: typeof pressableLabel,
  ) => Result,
): (element: Element, arg: Arg) => Result {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const compile = new Function(
    `return (element,arg)=>(${read.toString()})(element,arg,${optionNodes.toString()},${pressableLabel.toString()})`,
  ) as () => (element: Element, arg: Arg) => Result;
  return compile();
}

async function readList(list: Locator): Promise<ListState | null> {
  if ((await list.count()) !== 1) return null;
  const read = await list
    .evaluate(
      withOptionReaders((element, loadingSource: string, nodes, label) => {
        const loadingRow = new RegExp(loadingSource, "iu");
        const html = element as HTMLElement;
        // A search hides the rows it filters out; only drawn rows are offered.
        const drawn = (node: Element) =>
          node.getClientRects().length > 0 &&
          !["hidden", "collapse"].includes(getComputedStyle(node).visibility) &&
          getComputedStyle(node).opacity !== "0";
        const descendants = nodes(element);
        const rows = descendants
          .filter((node) => node.matches("[role='option']"))
          .filter(drawn)
          .map((option) => ({
            text: label.call(option),
            disabled:
              option.closest("[aria-disabled='true'], [disabled]") !== null,
          }));
        return {
          visible: drawn(html) || rows.length > 0,
          // Skeleton rows, a spinner or a "Loading…" row: still fetching.
          loading:
            element.getAttribute("aria-busy") === "true" ||
            descendants.some(
              (node) =>
                node.matches("[aria-busy='true'], [role='progressbar']") &&
                drawn(node),
            ) ||
            rows.some(({ text }) => loadingRow.test(text)),
          options: rows,
          // An empty list says so in its menu, which may wrap the listbox.
          menuText: (html.closest<HTMLElement>("[class*='menu' i]") ?? html)
            .innerText,
        };
      }),
      LOADING_ROW.source,
    )
    .catch(() => null);
  if (!read) return null;
  const options = read.options
    .filter(({ text, disabled }) => !disabled && !PLACEHOLDER.test(text))
    .map(({ text }) => text);
  return {
    visible: read.visible,
    // A menu whose only content is its "Loading..." notice is still fetching.
    loading:
      read.loading ||
      (read.options.length === 0 && LOADING_ROW.test(read.menuText.trim())),
    options,
    noResults: options.length === 0 && NO_RESULTS.test(read.menuText),
  };
}

/**
 * Reads a list to its end, scrolling the ones that draw only what is in view,
 * and stops early at the wanted choice.
 */
export async function readWholeList(
  list: Locator,
  wanted: string,
): Promise<{ options: string[]; complete: boolean; found: string | null }> {
  return evaluatePresent(
    list,
    withOptionReaders(
      async (
        element,
        input: {
          wanted: string;
          loadingSource: string;
          placeholderSource: string;
        },
        nodes,
        label,
      ) => {
        const normalize = (value: string) =>
          value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
        const loadingRow = new RegExp(input.loadingSource, "iu");
        const placeholder = new RegExp(input.placeholderSource, "iu");
        const wait = (ms: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, ms));
        const scrollable = (node: Element | null): node is HTMLElement =>
          node instanceof HTMLElement &&
          node.scrollHeight > node.clientHeight + 4 &&
          /auto|scroll/u.test(getComputedStyle(node).overflowY);
        // Scrolling a fully mounted list does not change its names. Reuse its
        // DOM inventory and composed labels until a mutation changes them,
        // rather than resolving every row's styles once per scroll position.
        let changed = true;
        let revision = 0;
        let descendants: Element[] = [];
        let rows: Element[] = [];
        let labels = new WeakMap<Element, string>();
        const observers = new Map<Node, MutationObserver>();
        const watch = (root: Node) => {
          if (observers.has(root)) return;
          const observer = new MutationObserver(() => {
            changed = true;
          });
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          observers.set(root, observer);
        };
        // Linked labels, ancestor state and stylesheet text can live outside
        // the list. Shadow roots need their own observer.
        watch(element.ownerDocument);
        watch(element.getRootNode());
        const refresh = () => {
          for (const observer of observers.values())
            if (observer.takeRecords().length) changed = true;
          // Attaching a shadow root itself emits no mutation record.
          if (
            !changed &&
            descendants.some(
              (node) => node.shadowRoot && !observers.has(node.shadowRoot),
            )
          )
            changed = true;
          if (!changed) return;
          descendants = nodes(element, watch);
          rows = descendants.filter((node) => node.matches("[role='option']"));
          labels = new WeakMap<Element, string>();
          revision++;
          changed = false;
        };
        const rowLabel = (option: Element) => {
          let text = labels.get(option);
          if (text === undefined) {
            text = label.call(option);
            labels.set(option, text);
          }
          return text;
        };
        try {
          refresh();
          const scroller =
            descendants.find(scrollable) ??
            [
              element.parentElement,
              element.parentElement?.parentElement ?? null,
            ].find(scrollable) ??
            null;
          const seen = new Map<string, string>();
          const choices = new Map<string, string>();
          let collectedRevision = -1;
          let lastFound: string | null = null;
          const collect = (): string | null => {
            refresh();
            if (collectedRevision === revision) return lastFound;
            collectedRevision = revision;
            let found: string | null = null;
            for (const option of rows) {
              if (option.getClientRects().length === 0) continue;
              const text = rowLabel(option);
              if (!text || loadingRow.test(text)) continue;
              const key = normalize(text);
              if (!seen.has(key)) seen.set(key, text);
              if (
                placeholder.test(text) ||
                option.closest("[aria-disabled='true'], [disabled]") !== null
              )
                continue;
              if (!choices.has(key)) choices.set(key, text);
              if (key === input.wanted) found ??= text;
            }
            lastFound = found;
            return found;
          };
          // A list that draws only some of its rows says how many it has
          // (aria-setsize) or where a row sits (aria-posinset).
          const windowed = () =>
            rows.some(
              (option) =>
                Number(option.getAttribute("aria-setsize") ?? 0) > seen.size ||
                Number(option.getAttribute("aria-posinset") ?? 0) > seen.size,
            );
          const done = (complete: boolean, found: string | null) => ({
            options: [...choices.values()],
            complete: found !== null || (complete && !windowed()),
            found,
          });
          let found = collect();
          if (found !== null || !scroller) return done(true, found);
          scroller.scrollTop = 0;
          // Background Chromium coalesces native scroll events until a frame.
          // Notify the virtual list at each position before advancing, so its
          // render callback sees every window rather than only the last one.
          scroller.dispatchEvent(new Event("scroll"));
          await wait(120);
          while (true) {
            found = collect();
            if (found !== null) return done(true, found);
            const atEnd =
              scroller.scrollTop + scroller.clientHeight >=
              scroller.scrollHeight - 2;
            if (atEnd) {
              // A list that loads more at its end gets a moment to do so.
              const height = scroller.scrollHeight;
              const size = seen.size;
              for (let waited = 0; waited < 1_000; waited += 200) {
                await wait(200);
                found = collect();
                if (found !== null) return done(true, found);
                if (scroller.scrollHeight > height || seen.size > size) break;
              }
              if (scroller.scrollHeight <= height && seen.size <= size) {
                const loading = rows.some((option) =>
                  loadingRow.test(rowLabel(option)),
                );
                return done(!loading, null);
              }
            }
            const beforeScroll = scroller.scrollTop;
            scroller.scrollTop += Math.max(scroller.clientHeight * 0.8, 40);
            scroller.dispatchEvent(new Event("scroll"));
            await wait(120);
            if (scroller.scrollTop === beforeScroll) {
              // The requested scroll did not move. Return the observed options
              // as incomplete so the model can choose another interaction.
              return done(false, collect());
            }
          }
        } finally {
          for (const observer of observers.values()) observer.disconnect();
        }
      },
    ),
    {
      wanted,
      loadingSource: LOADING_ROW.source,
      placeholderSource: PLACEHOLDER.source,
    },
  );
}

async function controlFrame(locator: Locator): Promise<Frame | null> {
  const handle = await presentControl(locator);
  const frame = (await handle?.ownerFrame()) ?? null;
  await handle?.dispose();
  return frame;
}

/** One attribute of the observed control, never a wait for it to reappear. */
function attribute(locator: Locator, name: string): Promise<string | null> {
  return evaluatePresent(
    locator,
    (element, attribute) => element.getAttribute(attribute),
    name,
  );
}

/** Every list drawn on the page, as it relates to this control. */
async function listFacts(locator: Locator): Promise<ListboxFacts[]> {
  return evaluatePresent(
    locator,
    withListboxReader((element, mark: string, facts) => facts(element, mark)),
    LIST_MARK,
  ).catch(() => []);
}

/**
 * What each open list shows just before an action, so the list the action
 * opened or changed can be told from lists that were already there. Take it
 * before the click or the keys.
 */
export async function openListsBefore(locator: Locator): Promise<ListsBefore> {
  return Object.fromEntries(
    (await listFacts(locator)).map((list) => [list.mark, list.signature]),
  );
}

/**
 * The list this control names as its own (aria-controls or aria-owns, else
 * the list its active option sits in). A control that names none answers in
 * the list that floated open or changed since `before`, or the one open right
 * beside it (`pickLookupList`). A list of what the field already holds, or a
 * list belonging to another field, is never its lookup list.
 */
async function boundList(
  scope: Frame | Page,
  locator: Locator,
  before: ListsBefore | null,
): Promise<Locator | null> {
  const ids = (
    (await attribute(locator, "aria-controls")) ??
    (await attribute(locator, "aria-owns")) ??
    ""
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (ids.length === 1)
    return scope.locator(`[id="${ids[0]!.replace(/["\\]/gu, "\\$&")}"]`);
  const mark = pickLookupList(await listFacts(locator), before);
  return mark ? scope.locator(`[${LIST_MARK}="${mark}"]`) : null;
}

async function openCustomList(
  scope: Frame | Page,
  locator: Locator,
  before: ListsBefore,
): Promise<void> {
  const isOpen = async () => {
    const expanded = await attribute(locator, "aria-expanded");
    if (expanded === "true" || expanded === "false") return expanded === "true";
    const list = await boundList(scope, locator, before);
    return list !== null && (await readList(list))?.visible === true;
  };

  // A click could close an already-open picker. On some comboboxes it only
  // focuses the input, so use the keyboard to open the popup if still closed.
  if (await isOpen()) return;
  await clickPresent(locator);
  if (await isOpen()) return;
  const element = await presentControl(locator);
  try {
    const combobox = await element.evaluate(
      (node) => node instanceof Element && node.matches("[role='combobox']"),
    );
    if (combobox) await element.press("ArrowDown", { timeout: 0 });
  } finally {
    await element.dispose();
  }
}

/** Matches an accessible name as the label spells it, give or take spacing and case. */
function exactName(text: string): RegExp {
  const escaped = text
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    // Quotes inside a role-name regexp must not open a selector string.
    .replace(/'/gu, "\\x27")
    .replace(/"/gu, "\\x22")
    .replace(/\s+/gu, "\\s+");
  return new RegExp(`^\\s*${escaped}\\s*$`, "iu");
}

/**
 * Presses the row by what it says, not where it sits: a list that redraws as
 * it scrolls puts a different choice at the same position. The press goes to
 * the row itself in one step. A pointer aimed at its position can land on
 * another row when the page moves in between, as a menu that scrolls the
 * page open does on the frame the pointer's own move draws.
 */
async function pressRow(list: Locator, text: string): Promise<void> {
  await evaluatePresent(
    list.getByRole("option", { name: exactName(text) }).first(),
    (node) => {
      const row = node as HTMLElement;
      const box = row.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      // What a person's pointer would touch inside the row, such as its link.
      const hit = (row.getRootNode() as Document | ShadowRoot).elementFromPoint(
        x,
        y,
      );
      const target = hit && row.contains(hit) ? hit : row;
      const mouse = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
      };
      const pointer = {
        ...mouse,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      };
      target.dispatchEvent(new PointerEvent("pointerover", pointer));
      target.dispatchEvent(new MouseEvent("mouseover", mouse));
      target.dispatchEvent(new PointerEvent("pointermove", pointer));
      target.dispatchEvent(new MouseEvent("mousemove", mouse));
      target.dispatchEvent(
        new PointerEvent("pointerdown", { ...pointer, buttons: 1 }),
      );
      target.dispatchEvent(
        new MouseEvent("mousedown", { ...mouse, buttons: 1 }),
      );
      target.dispatchEvent(new PointerEvent("pointerup", pointer));
      target.dispatchEvent(new MouseEvent("mouseup", mouse));
      target.dispatchEvent(new MouseEvent("click", { ...mouse, detail: 1 }));
    },
    undefined,
  );
}

/** What the control shows as chosen: its value, chips, or the list's marked row. */
async function shownChoices(
  list: Locator,
  locator: Locator,
  text: string,
): Promise<string[]> {
  const composite = (
    await locator.evaluateAll(collectCustomComboboxStates, [0])
  )[0]?.[1];
  const own = await evaluatePresent(
    locator,
    (element, triggerSelector) => {
      const root = element.closest(
        "[class*='__control'], [class*='-control'], .select-shell, [class*='select-shell']",
      );
      const chips = root
        ? [
            ...root.querySelectorAll<HTMLElement>(
              "[class*='multi-value__label'], [class*='multiValue'] [class*='label' i]",
            ),
          ].map((chip) => chip.innerText)
        : [];
      const value =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
          ? element.value
          : ((element as HTMLElement).innerText ?? element.textContent ?? "");
      return {
        values: [...chips, element.getAttribute("aria-valuetext") ?? "", value],
        listboxTrigger: element.matches(triggerSelector),
      };
    },
    APPLY_LISTBOX_TRIGGER_SELECTOR,
  );
  // A list that stays open marks what it holds.
  const marked = await list
    .getByRole("option", { name: exactName(text), selected: true })
    .count()
    .catch(() => 0);
  // A prompt that keeps its choices as items beside the search box.
  const held = own.listboxTrigger
    ? []
    : (heldItems(await listFacts(locator)) ?? []);
  return [
    ...new Set(
      [
        composite?.selectedOptionLabel ?? "",
        ...own.values,
        ...held,
        marked ? text : "",
      ]
        .map((value) => value.replace(/\s+/gu, " ").trim())
        .filter(Boolean),
    ),
  ];
}

/** Search queries only, never guesses at alternative answers. */
function shorterSearches(label: string): string[] {
  const words = label.trim().split(/\s+/u);
  const first = words[0] ?? "";
  return [
    ...new Set([
      words.slice(0, 2).join(" "),
      first,
      Array.from(first).slice(0, 3).join(""),
    ]),
  ].filter((query) => query && query.length < label.trim().length);
}

/**
 * Presses the row and reports what the control then holds. The result is a
 * success only when that is the row the model asked for; anything else is
 * returned as what the picker shows, so the model sees the actual answer.
 */
async function selectRow(
  list: Locator,
  locator: Locator,
  text: string,
): Promise<ApplyWriteResult> {
  await pressRow(list, text);
  const wanted = normalizeOptionLabel(text);
  // A picker may commit its choice a moment after the press; read until what
  // it shows stops changing.
  const pressedAt = Date.now();
  let shown: string[] = [];
  let lastKey = "";
  let stableSince = Date.now();
  for (;;) {
    shown = await shownChoices(list, locator, text);
    const match = shown.find((value) => normalizeOptionLabel(value) === wanted);
    if (match) return { ok: true, observedValue: match };
    const key = JSON.stringify(shown);
    if (key !== lastKey) {
      lastKey = key;
      stableSince = Date.now();
    }
    if (
      Date.now() - stableSince >= STABLE_MS ||
      Date.now() - pressedAt >= IDLE_MS
    )
      break;
    await pause(POLL_MS);
  }
  return {
    ok: false,
    error: shown.length
      ? `After "${text}" was pressed the picker shows ${shown.map((value) => `"${value}"`).join(", ")}, so "${text}" is not what it holds.`
      : `"${text}" was pressed, but the picker shows no choice.`,
  };
}

/**
 * Waits for the list to show the choice or finish drawing without it. After a
 * search, rows that do not answer it may be the previous results still on
 * screen, so they count as settled after the list and its connection stop
 * changing. A search that leaves the list open and empty is "empty".
 */
async function settle(
  scope: Frame | Page,
  locator: Locator,
  before: ListsBefore,
  wanted: string,
  idleMs: number,
  searched: boolean,
  query = wanted,
  networkProgress: () => number = () => 0,
  report: ListReport = () => undefined,
): Promise<
  | { kind: "found"; list: Locator; text: string }
  | { kind: "settled"; list: Locator; state: ListState }
  | { kind: "empty" }
  | { kind: "unbound" }
  | { kind: "unsettled" }
> {
  let lastKey = "";
  let stableSince = Date.now();
  let bound = false;
  for (;;) {
    const list = await boundList(scope, locator, before);
    const state = list ? await readList(list) : null;
    if (list && state) {
      bound = true;
      report({
        ...state,
        loading:
          state.loading || (await attribute(locator, "aria-busy")) === "true",
      });
      const text = state.options.find(
        (option) => normalizeOptionLabel(option) === wanted,
      );
      if (text && state.visible) return { kind: "found", list, text };
      const busy =
        state.loading || (await attribute(locator, "aria-busy")) === "true";
      const key = JSON.stringify({ state, busy });
      if (key !== lastKey) {
        lastKey = key;
        stableSince = Date.now();
      }
      const answersSearch =
        !searched ||
        state.noResults ||
        state.options.some((text) => {
          const option = normalizeOptionLabel(text);
          return option.includes(query) || query.includes(option);
        });
      if (
        state.visible &&
        !busy &&
        (state.options.length > 0 || state.noResults) &&
        Date.now() - stableSince >= STABLE_MS &&
        (answersSearch ||
          Date.now() - Math.max(stableSince, networkProgress()) >= idleMs)
      ) {
        report(state, true);
        return { kind: "settled", list, state };
      }
      if (
        searched &&
        state.visible &&
        !busy &&
        state.options.length === 0 &&
        Date.now() - stableSince >= STABLE_MS &&
        Date.now() - Math.max(stableSince, networkProgress()) >= idleMs
      )
        return { kind: "empty" };
    }
    if (!state && lastKey !== "null") {
      lastKey = "null";
      stableSince = Date.now();
    }
    if (Date.now() - Math.max(stableSince, networkProgress()) >= idleMs) {
      reportSelfLimitHit({
        limit: "custom_option_idle",
        kind: "idle",
        value: idleMs,
        where: "browser-runtime/settle",
      });
      return bound ? { kind: "unsettled" } : { kind: "unbound" };
    }
    await pause(POLL_MS);
  }
}

async function chooseCustomOption(
  page: Page,
  locator: Locator,
  label: string,
  networkProgress: () => number,
  report: ListReport,
  before: ListsBefore,
): Promise<ApplyWriteResult> {
  const selected = (
    await locator.evaluateAll(collectCustomComboboxStates, [0])
  )[0]?.[1]?.selectedOptionLabel;
  if (
    selected &&
    normalizeOptionLabel(selected) === normalizeOptionLabel(label)
  )
    return { ok: true, observedValue: selected };
  const searchable = await evaluatePresent(
    locator,
    (element) =>
      element.matches("input, textarea, [contenteditable='true']") &&
      !element.matches(":disabled, [readonly], [aria-readonly='true']"),
    undefined,
  );
  return chooseFromList(
    page,
    locator,
    label,
    searchable,
    networkProgress,
    report,
    before,
  );
}

async function chooseFromList(
  page: Page,
  locator: Locator,
  label: string,
  searchable: boolean,
  networkProgress: () => number,
  report: ListReport,
  before: ListsBefore,
): Promise<ApplyWriteResult> {
  const wanted = normalizeOptionLabel(label);
  // Open it, type enough of the answer for the list to narrow to it, then
  // take the choice that says it. Typing first is what makes a list of two
  // hundred countries usable at all.
  const scope = (await controlFrame(locator)) ?? page;
  await openCustomList(scope, locator, before);
  if (searchable) {
    // Replacing identical search text otherwise produces no React change.
    // Clear this element first, without dismissing its list or parent modal.
    const typed = await evaluatePresent(
      locator,
      (element) =>
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
          ? element.value
          : (element.textContent ?? ""),
      undefined,
    );
    if (typed === label) await replaceFieldText(locator, "");
    await replaceFieldText(locator, label);
  }
  const first = await settle(
    scope,
    locator,
    before,
    wanted,
    IDLE_MS,
    searchable,
    wanted,
    networkProgress,
    report,
  );
  if (first.kind === "found") return selectRow(first.list, locator, first.text);
  if (first.kind === "unbound") {
    // No list says it belongs to this control. A list elsewhere on the page
    // may still hold the choice, but its rows are not evidence of absence.
    try {
      return await selectRow(scope.locator("body"), locator, label.trim());
    } catch {
      return uncertain(
        "The picker did not identify its option list, so its choices could not be confirmed.",
      );
    }
  }
  const offered = new Map<string, string>();
  const collect = (options: readonly string[]) => {
    for (const option of options)
      if (!offered.has(normalizeOptionLabel(option)))
        offered.set(normalizeOptionLabel(option), option);
  };
  if (first.kind === "settled") {
    const read = await readWholeList(first.list, wanted);
    report(
      {
        visible: true,
        loading: false,
        noResults: false,
        options: read.options,
      },
      read.complete && read.found === null,
    );
    if (read.found) return selectRow(first.list, locator, read.found);
    collect(read.options);
    if (!read.complete && !searchable) {
      return uncertain(
        "The option list was too long to read to its end, so its choices could not be confirmed.",
      );
    }
    if (!searchable) {
      return read.options.length > 0
        ? missing(label, read.options)
        : uncertain("The list had no selectable choices to confirm.");
    }
  } else if (first.kind === "unsettled" || !searchable) {
    return uncertain(
      "The option list did not finish loading, so its choices could not be confirmed.",
    );
  }
  // Preserve the existing full-list order when clearing exposes all choices.
  // Remote-search pickers may instead close or require a nonempty query.
  await replaceFieldText(locator, "").catch(() => undefined);
  const listed = await settle(
    scope,
    locator,
    before,
    wanted,
    3_000,
    false,
    wanted,
    networkProgress,
    report,
  );
  if (listed.kind === "found")
    return selectRow(listed.list, locator, listed.text);
  const whole =
    listed.kind === "settled" ? await readWholeList(listed.list, wanted) : null;
  if (whole?.found && listed.kind === "settled")
    return selectRow(listed.list, locator, whole.found);
  if (whole?.complete && whole.options.length > 0) {
    return missing(label, whole.options);
  }
  // A spelling variant can be visible after the full query. When that query
  // offers nothing, broaden it with a few literal prefixes of the answer.
  // Only the model may decide whether a returned row means the same thing.
  if (offered.size === 0) {
    for (const query of shorterSearches(label)) {
      await replaceFieldText(locator, query);
      const searched = await settle(
        scope,
        locator,
        before,
        wanted,
        IDLE_MS,
        true,
        normalizeOptionLabel(query),
        networkProgress,
        report,
      );
      if (searched.kind === "found")
        return selectRow(searched.list, locator, searched.text);
      if (searched.kind === "settled") {
        const read = await readWholeList(searched.list, wanted);
        if (read.found) return selectRow(searched.list, locator, read.found);
        collect(read.options);
      }
    }
  }
  return offered.size > 0
    ? missing(label, [...offered.values()])
    : uncertain(
        "The list offered no selectable choices after searching, so its choices could not be confirmed.",
      );
}
