import type { Locator } from "playwright";

/** Resolve once, without Playwright waiting for a vanished observed node to reappear. */
export async function presentControl(locator: Locator) {
  const elements = await locator.elementHandles();
  if (elements.length !== 1) {
    await Promise.all(elements.map((element) => element.dispose()));
    throw new Error("Stale or missing control; observe again.");
  }
  const element = elements[0]!;
  if (!(await element.evaluate((node) => node.isConnected))) {
    await element.dispose();
    throw new Error("Stale or missing control; observe again.");
  }
  return element;
}

/** Fixed DOM readers use the observed element, never a selector auto-wait. */
export async function evaluatePresent<Arg, Result>(
  locator: Locator,
  read: (element: Element, arg: Arg) => Result | Promise<Result>,
  arg: Arg,
): Promise<Result> {
  const element = await presentControl(locator);
  try {
    const evaluate = element.evaluate.bind(element) as (
      read: (element: Element, arg: Arg) => Result | Promise<Result>,
      arg: Arg,
    ) => Promise<Result>;
    return await evaluate(read, arg);
  } finally {
    await element.dispose();
  }
}

/** Whether a click at the element's centre reaches it, in its own document or shadow root. */
function reachable(target: Node): boolean {
  const node = target as Element;
  const box = node.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
  const hit = (node.getRootNode() as Document | ShadowRoot).elementFromPoint(
    x,
    y,
  );
  return hit !== null && (hit === node || node.contains(hit));
}

/**
 * Presses the observed element once. An element a person can reach gets a
 * click at its centre; one that is covered, hidden or off-screen gets a click
 * aimed straight at its position (or an immediate error). Playwright's own
 * actionability retries are skipped: with no timeout they never end on a
 * page that does not repaint or keeps something drawn over the element.
 */
export async function clickPresent(locator: Locator): Promise<void> {
  const first = await presentControl(locator);
  try {
    if (!(await first.evaluate(reachable))) {
      // Bring it into view inside its own scrolling list as well as the page.
      // A list that redraws on scroll gets a moment to draw the row again.
      await first.evaluate(async (node) => {
        (node as Element).scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
    }
  } finally {
    await first.dispose();
  }
  const element = await presentControl(locator);
  try {
    await element.click({ timeout: 0, force: true });
  } finally {
    await element.dispose();
  }
}

interface ToggleFacts {
  checked: boolean | null;
  disabled: boolean;
  reachable: boolean;
  label: string;
}

function readToggle(node: Element): ToggleFacts {
  const input =
    node instanceof HTMLInputElement &&
    (node.type === "checkbox" || node.type === "radio")
      ? node
      : null;
  const box = node.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const hit =
    box.width && box.height && x >= 0 && y >= 0
      ? (node.getRootNode() as Document | ShadowRoot).elementFromPoint(x, y)
      : null;
  let shown = true;
  for (
    let at: Element | null = node;
    at;
    at =
      at.parentElement ??
      (at.getRootNode() instanceof ShadowRoot
        ? (at.getRootNode() as ShadowRoot).host
        : null)
  ) {
    const style = getComputedStyle(at);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0"
    )
      shown = false;
  }
  const label = (
    input?.labels?.[0]?.textContent ??
    node.getAttribute("aria-label") ??
    node.closest("label")?.textContent ??
    node.textContent ??
    ""
  )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
  // A row that draws its box inside itself, or says it is chosen, as a
  // prompt's options do (aria-selected).
  const inner =
    input || node.hasAttribute("aria-checked")
      ? []
      : Array.from(
          node.querySelectorAll(
            "input[type='checkbox'], input[type='radio'], [role='checkbox'][aria-checked], [role='radio'][aria-checked], [role='switch'][aria-checked]",
          ),
        );
  const drawnBox = inner.length === 1 ? inner[0]! : null;
  return {
    checked: input
      ? input.checked
      : node.hasAttribute("aria-checked")
        ? node.getAttribute("aria-checked") === "true"
        : drawnBox
          ? drawnBox instanceof HTMLInputElement
            ? drawnBox.checked
            : drawnBox.getAttribute("aria-checked") === "true"
          : node.hasAttribute("aria-selected")
            ? node.getAttribute("aria-selected") === "true"
            : null,
    disabled:
      (input?.disabled ?? false) ||
      node.getAttribute("aria-disabled") === "true",
    reachable: shown && hit !== null && (hit === node || node.contains(hit)),
    label,
  };
}

/**
 * Sets a checkbox, radio or switch once and reports what it became. One a
 * person can reach gets a click; a hidden or covered one is activated the way
 * its own label activates it. Nothing waits for it to become clickable: a box
 * that does not change says so at once, with its label, so the model can
 * press the label or try another way.
 */
export async function setPresentToggle(
  locator: Locator,
  checked: boolean,
): Promise<void> {
  const read = () => evaluatePresent(locator, readToggle, undefined);
  let before = await read();
  if (before.checked === checked) return;
  if (before.disabled) throw new Error("The control is disabled.");
  if (!before.reachable) {
    // Off screen or under a sticky bar: bring it, and what sits beside it,
    // to the middle of the view, as a person scrolling to it would.
    await evaluatePresent(
      locator,
      (node) =>
        node.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "instant",
        }),
      undefined,
    );
    before = await read();
  }
  const activate = () =>
    evaluatePresent(
      locator,
      (node) => {
        (node as HTMLElement).click();
      },
      undefined,
    );
  if (before.reachable) await clickPresent(locator);
  else await activate();
  let after = await read();
  // A click the site did not take on its drawn box: the element's own
  // activation is what its label does.
  if (after.checked !== checked && before.reachable) {
    await activate();
    after = await read();
  }
  if (after.checked === checked || after.checked === null) return;
  const name = before.label ? ` "${before.label}"` : "";
  throw new Error(
    `The box${name} stayed ${after.checked ? "checked" : "unchecked"} after it was pressed${before.reachable ? "" : "; the box itself is hidden or covered on the page"}.`,
  );
}
