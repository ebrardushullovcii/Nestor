import type { ApplyWriteResult } from "@nestor/contracts";
import type { Frame, Locator, Page } from "playwright";

/** How long a list may take to load or settle before it counts as uncertain. */
const SETTLE_MS = 5_000;
/** A list unchanged this long, and not loading, has finished drawing. */
const STABLE_MS = 700;
const POLL_MS = 150;

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
 * alternative. "Not offered" is returned only from a list that finished
 * loading and was read to its end; anything less is uncertain.
 */
export async function choosePageOption(
  page: Page,
  locator: Locator,
  label: string,
): Promise<ApplyWriteResult> {
  const native = await locator.evaluate(
    (element) => element.tagName === "SELECT",
  );
  return native
    ? chooseNativeOption(locator, label)
    : chooseCustomOption(page, locator, label);
}

interface NativeState {
  disabled: boolean;
  busy: boolean;
  options: Array<{ text: string; value: string; disabled: boolean }>;
}

async function chooseNativeOption(
  locator: Locator,
  label: string,
): Promise<ApplyWriteResult> {
  const wanted = normalizeOptionLabel(label);
  const deadline = Date.now() + SETTLE_MS;
  let lastKey = "";
  let stableSince = Date.now();
  for (;;) {
    const state = await locator.evaluate((element): NativeState => {
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
    });
    const index = state.options.findIndex(
      (option) =>
        !option.disabled && normalizeOptionLabel(option.text) === wanted,
    );
    if (index >= 0 && !state.disabled) {
      await locator.selectOption({ index }, { timeout: 5_000 });
      const chosen = await locator.evaluate(
        (element) =>
          (element as HTMLSelectElement).selectedOptions[0]?.text ?? "",
      );
      return normalizeOptionLabel(chosen) === wanted
        ? { ok: true, observedValue: chosen.replace(/\s+/gu, " ").trim() }
        : uncertain(`The list did not keep "${label}" selected.`);
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
    if (Date.now() >= deadline)
      return uncertain(
        "The list had no choices to read yet, so whether it offers that option is unknown.",
      );
    await pause(POLL_MS);
  }
}

interface ListState {
  visible: boolean;
  loading: boolean;
  noResults: boolean;
  options: string[];
}

async function readList(list: Locator): Promise<ListState | null> {
  if ((await list.count()) !== 1) return null;
  const read = await list
    .evaluate((element, loadingSource) => {
      const loadingRow = new RegExp(loadingSource, "iu");
      const html = element as HTMLElement;
      // A search hides the rows it filters out; only drawn rows are offered.
      const drawn = (node: Element) => node.getClientRects().length > 0;
      const rows = Array.from(
        element.querySelectorAll<HTMLElement>("[role='option']"),
      )
        .filter(drawn)
        .map((option) => ({
          text: (option.getAttribute("aria-label") ?? option.innerText ?? "")
            .replace(/\s+/gu, " ")
            .trim(),
          disabled:
            option.closest("[aria-disabled='true'], [disabled]") !== null,
        }));
      return {
        visible: drawn(html) && getComputedStyle(html).visibility !== "hidden",
        // Skeleton rows, a spinner or a "Loading…" row: still fetching.
        loading:
          element.getAttribute("aria-busy") === "true" ||
          Array.from(
            element.querySelectorAll(
              "[aria-busy='true'], [role='progressbar'], [class*='skeleton' i], [class*='spinner' i], [class*='loading' i]",
            ),
          ).some(drawn) ||
          rows.some(({ text }) => text === "" || loadingRow.test(text)),
        options: rows,
        // An empty list says so in its menu, which may wrap the listbox.
        menuText: (html.closest<HTMLElement>("[class*='menu' i]") ?? html)
          .innerText,
      };
    }, LOADING_ROW.source)
    .catch(() => null);
  if (!read) return null;
  const options = read.options
    .filter(({ text, disabled }) => !disabled && !PLACEHOLDER.test(text))
    .map(({ text }) => text);
  return {
    visible: read.visible,
    loading: read.loading,
    options,
    noResults: options.length === 0 && NO_RESULTS.test(read.menuText),
  };
}

/**
 * Reads a list to its end, scrolling the ones that draw only what is in view,
 * and stops early at the wanted choice.
 */
async function readWholeList(
  list: Locator,
  wanted: string,
): Promise<{ options: string[]; complete: boolean; found: string | null }> {
  return list.evaluate(
    async (element, input) => {
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
      const scroller =
        [element, ...Array.from(element.querySelectorAll("*"))].find(
          scrollable,
        ) ??
        [
          element.parentElement,
          element.parentElement?.parentElement ?? null,
        ].find(scrollable) ??
        null;
      const seen = new Map<string, string>();
      const choices = new Map<string, string>();
      const collect = (): string | null => {
        let found: string | null = null;
        for (const option of element.querySelectorAll<HTMLElement>(
          "[role='option']",
        )) {
          if (option.getClientRects().length === 0) continue;
          const text = (option.getAttribute("aria-label") ?? option.innerText)
            .replace(/\s+/gu, " ")
            .trim();
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
        return found;
      };
      // A list that draws only some of its rows says how many it has
      // (aria-setsize) or where a row sits (aria-posinset).
      const windowed = () =>
        Array.from(
          element.querySelectorAll<HTMLElement>("[role='option']"),
        ).some(
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
      await wait(120);
      for (let step = 0; step < input.maxSteps; step += 1) {
        found = collect();
        if (found !== null) return done(true, found);
        if (seen.size >= input.maxOptions) return done(false, null);
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
            const loading = Array.from(
              element.querySelectorAll<HTMLElement>("[role='option']"),
            ).some((option) => loadingRow.test(option.innerText.trim()));
            return done(!loading, null);
          }
        }
        scroller.scrollTop += Math.max(scroller.clientHeight * 0.8, 40);
        await wait(120);
      }
      return done(false, null);
    },
    {
      wanted,
      loadingSource: LOADING_ROW.source,
      placeholderSource: PLACEHOLDER.source,
      maxSteps: 80,
      maxOptions: 1_500,
    },
  );
}

async function controlFrame(locator: Locator): Promise<Frame | null> {
  const handle = await locator.elementHandle();
  const frame = (await handle?.ownerFrame()) ?? null;
  await handle?.dispose();
  return frame;
}

/** The list this control names as its own, or the only list open beside it. */
async function boundList(
  scope: Frame | Page,
  locator: Locator,
): Promise<Locator | null> {
  const ids = (
    (await locator.getAttribute("aria-controls")) ??
    (await locator.getAttribute("aria-owns")) ??
    ""
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (ids.length === 1)
    return scope.locator(`[id="${ids[0]!.replace(/["\\]/gu, "\\$&")}"]`);
  const open = scope.locator("[role='listbox']:visible");
  return (await open.count()) === 1 ? open : null;
}

/** Matches an accessible name as the label spells it, give or take spacing and case. */
function exactName(text: string): RegExp {
  const escaped = text
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\s+/gu, "\\s+");
  return new RegExp(`^\\s*${escaped}\\s*$`, "iu");
}

/**
 * Clicks the row by what it says, not where it sits: a list that redraws as
 * it scrolls puts a different choice at the same position.
 */
async function clickRow(list: Locator, text: string): Promise<string> {
  await list
    .getByRole("option", { name: exactName(text) })
    .first()
    .click({ timeout: 5_000 });
  return text;
}

/**
 * Waits for the list to show the choice or finish drawing without it. After a
 * search, rows that do not answer it may be the previous results still on
 * screen, so they count as settled only once the whole budget has passed; a
 * search that leaves the list open and empty for that long is "empty".
 */
async function settle(
  scope: Frame | Page,
  locator: Locator,
  wanted: string,
  budgetMs: number,
  searched: boolean,
): Promise<
  | { kind: "found"; list: Locator; text: string }
  | { kind: "settled"; list: Locator; state: ListState }
  | { kind: "empty" }
  | { kind: "unbound" }
  | { kind: "unsettled" }
> {
  const deadline = Date.now() + budgetMs;
  let lastKey = "";
  let stableSince = Date.now();
  let bound = false;
  for (;;) {
    const list = await boundList(scope, locator);
    const state = list ? await readList(list) : null;
    if (list && state) {
      bound = true;
      const text = state.options.find(
        (option) => normalizeOptionLabel(option) === wanted,
      );
      if (text && state.visible) return { kind: "found", list, text };
      const busy =
        state.loading || (await locator.getAttribute("aria-busy")) === "true";
      const key = JSON.stringify(state);
      if (key !== lastKey) {
        lastKey = key;
        stableSince = Date.now();
      }
      const answersSearch =
        !searched ||
        state.noResults ||
        state.options.some((text) => {
          const option = normalizeOptionLabel(text);
          return option.includes(wanted) || wanted.includes(option);
        });
      if (
        state.visible &&
        !busy &&
        (state.options.length > 0 || state.noResults) &&
        Date.now() - stableSince >= STABLE_MS &&
        (answersSearch || Date.now() >= deadline)
      )
        return { kind: "settled", list, state };
      if (
        searched &&
        state.visible &&
        !busy &&
        state.options.length === 0 &&
        Date.now() - stableSince >= STABLE_MS &&
        Date.now() >= deadline
      )
        return { kind: "empty" };
    }
    if (Date.now() >= deadline)
      return bound ? { kind: "unsettled" } : { kind: "unbound" };
    await pause(POLL_MS);
  }
}

async function chooseCustomOption(
  page: Page,
  locator: Locator,
  label: string,
): Promise<ApplyWriteResult> {
  const searchable = await locator.isEditable().catch(() => false);
  const leave = async () => {
    // A typed search left in the box reads as an answer it is not.
    if (searchable)
      await locator.fill("", { timeout: 2_000 }).catch(() => undefined);
    await locator.press("Escape").catch(() => undefined);
  };
  try {
    return await chooseFromList(page, locator, label, searchable, leave);
  } catch (error) {
    await leave();
    throw error;
  }
}

async function chooseFromList(
  page: Page,
  locator: Locator,
  label: string,
  searchable: boolean,
  leave: () => Promise<void>,
): Promise<ApplyWriteResult> {
  const wanted = normalizeOptionLabel(label);
  // Open it, type enough of the answer for the list to narrow to it, then
  // take the choice that says it. Typing first is what makes a list of two
  // hundred countries usable at all.
  await locator.click({ timeout: 5_000 });
  // A box that already shows a choice (the person's, or an earlier run's)
  // searches nothing when the same text is put in it again: the page sees no
  // change. Empty it first, so the search runs and the choice is made again.
  if (
    searchable &&
    (await locator.inputValue({ timeout: 1_000 }).catch(() => "")).trim()
  )
    await locator.fill("", { timeout: 2_000 }).catch(() => undefined);
  // A list that is not a text box still jumps to what is typed at it.
  if (searchable)
    await locator.fill(label, { timeout: 2_000 }).catch(async () => {
      await locator.type(label, { timeout: 2_000 });
    });
  else await locator.type(label, { timeout: 2_000 });
  const scope = (await controlFrame(locator)) ?? page;
  const first = await settle(scope, locator, wanted, SETTLE_MS, searchable);
  if (first.kind === "found")
    return { ok: true, observedValue: await clickRow(first.list, first.text) };
  if (first.kind === "unbound") {
    // No list says it belongs to this control. A list elsewhere on the page
    // may still hold the choice, but its rows are not evidence of absence.
    try {
      await scope
        .getByRole("option", { name: exactName(label) })
        .first()
        .click({ timeout: 2_000 });
      return { ok: true, observedValue: label.trim() };
    } catch {
      await leave();
      return uncertain(
        "The picker did not identify its option list, so its choices could not be confirmed.",
      );
    }
  }
  if (first.kind === "settled") {
    const read = await readWholeList(first.list, wanted);
    if (read.found)
      return {
        ok: true,
        observedValue: await clickRow(first.list, read.found),
      };
    if (!read.complete) {
      await leave();
      return uncertain(
        "The option list was too long to read to its end, so its choices could not be confirmed.",
      );
    }
    if (!searchable) {
      await leave();
      return read.options.length > 0
        ? missing(label, read.options)
        : uncertain("The list had no selectable choices to confirm.");
    }
  } else if (first.kind === "unsettled" || !searchable) {
    await leave();
    return uncertain(
      "The option list did not finish loading, so its choices could not be confirmed.",
    );
  }
  // What a search left shows the choice is absent, not what the form offers;
  // a search that found nothing shows only that. Clear it and read the list
  // the form actually has, to its end.
  await locator.fill("", { timeout: 2_000 }).catch(() => undefined);
  const listed = await settle(scope, locator, wanted, 3_000, false);
  if (listed.kind === "found")
    return {
      ok: true,
      observedValue: await clickRow(listed.list, listed.text),
    };
  const whole =
    listed.kind === "settled" ? await readWholeList(listed.list, wanted) : null;
  if (whole?.found && listed.kind === "settled")
    return {
      ok: true,
      observedValue: await clickRow(listed.list, whole.found),
    };
  await leave();
  // The rows a search left are not what the form offers: without the whole
  // list nothing proves the choice absent.
  if (!whole?.complete || whole.options.length === 0)
    return uncertain(
      "The full option list could not be read after the search, so its choices could not be confirmed.",
    );
  return missing(label, whole.options);
}
