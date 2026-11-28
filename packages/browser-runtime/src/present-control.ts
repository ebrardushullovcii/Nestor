import type { ElementHandle, Locator } from "playwright";

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

type Point = { x: number; y: number };
type ClickTarget =
  | { offset: Point; position: Point; framed: boolean }
  | { error: string; covered?: true };

/** Find a point for the press, or describe the element receiving it. */
function readClickTarget(target: Node, offset?: Point): ClickTarget {
  const node = target as Element;
  if (!node.isConnected)
    return { error: "Stale or missing control; observe again." };
  const noPoint = {
    error: "The control has no visible click point in the viewport.",
  };
  const box = node.getBoundingClientRect();
  // An inline link may span more than one line. Use its first visible
  // rectangle, since the centre of the union can be outside the link.
  const rect = Array.from(node.getClientRects()).find(
    (rect) =>
      Math.max(rect.left, 0) < Math.min(rect.right, innerWidth) &&
      Math.max(rect.top, 0) < Math.min(rect.bottom, innerHeight),
  );
  const point = offset
    ? { x: box.left + offset.x, y: box.top + offset.y }
    : rect && {
        x: (Math.max(rect.left, 0) + Math.min(rect.right, innerWidth)) / 2,
        y: (Math.max(rect.top, 0) + Math.min(rect.bottom, innerHeight)) / 2,
      };
  if (!point) return noPoint;

  // A shadow-root hit alone cannot tell us whether something covers its host.
  const scopes = [node];
  for (
    let root = node.getRootNode();
    root instanceof ShadowRoot;
    root = root.host.getRootNode()
  ) {
    scopes.push(root.host);
  }
  for (const expected of scopes.reverse()) {
    const hit = (
      expected.getRootNode() as Document | ShadowRoot
    ).elementFromPoint(point.x, point.y);
    if (!hit) return noPoint;
    // Light-DOM text slotted into the control is drawn inside it but
    // hit-tests as its shadow host, which the outer pass already checked.
    if (hit !== expected && !expected.contains(hit) && !scopes.includes(hit)) {
      const covering =
        hit.closest("dialog, [role='dialog'], [aria-label], [id]") ?? hit;
      const label = covering.getAttribute("aria-label")?.trim();
      const name = label
        ? `"${label}"`
        : covering.id
          ? `<${covering.localName} id="${covering.id}">`
          : `<${covering.localName}>`;
      return { error: `The click point is covered by ${name}.`, covered: true };
    }
  }
  const relative = { x: point.x - box.left, y: point.y - box.top };
  const style = getComputedStyle(node);
  // Playwright takes a padding-box offset. Preserve the point we hit-tested
  // instead of letting it choose another point or scroll again.
  return {
    offset: relative,
    position: {
      x: relative.x - (Number.parseInt(style.borderLeftWidth, 10) || 0),
      y: relative.y - (Number.parseInt(style.borderTopWidth, 10) || 0),
    },
    framed: window !== window.top,
  };
}

async function inspectClickTarget(
  element: ElementHandle,
): Promise<ClickTarget> {
  const target = await element.evaluate(readClickTarget, undefined);
  if ("error" in target || !target.framed) return target;
  const box = await element.boundingBox();
  if (!box)
    return { error: "The control has no visible click point in the viewport." };
  const pageX = box.x + target.offset.x;
  const pageY = box.y + target.offset.y;
  // Playwright's boxes are relative to the main viewport, even across origins.
  // Check that this point can also reach each iframe in its parent document.
  for (
    let frame = await element.ownerFrame();
    frame?.parentFrame();
    frame = frame.parentFrame()
  ) {
    const host = await frame.frameElement();
    try {
      const hostBox = await host.boundingBox();
      if (!hostBox)
        return {
          error: "The frame has no visible click point in the viewport.",
        };
      const hit = await host.evaluate(readClickTarget, {
        x: pageX - hostBox.x,
        y: pageY - hostBox.y,
      });
      if ("error" in hit) return hit;
    } finally {
      await host.dispose();
    }
  }
  return target;
}

/**
 * Presses the observed element once. If it is off-screen, scroll it into
 * view; if its click point is covered, centre it. Then check again and
 * report any remaining obstruction without waiting for it to clear.
 */
export async function clickPresent(locator: Locator): Promise<void> {
  let element = await presentControl(locator);
  try {
    let target = await inspectClickTarget(element);
    if ("error" in target) {
      // Bring it into view inside its scrolling list as well as the page. A
      // covered control is centred: a sticky header or footer can cover one
      // that is already in the viewport. A list that redraws on scroll gets a
      // moment to draw the row again.
      await element.evaluate(
        async (node, block: ScrollLogicalPosition) => {
          (node as Element).scrollIntoView({
            block,
            inline: block,
            behavior: "instant",
          });
          await new Promise((resolve) => setTimeout(resolve, 120));
        },
        "covered" in target ? "center" : "nearest",
      );
      await element.dispose();
      element = await presentControl(locator);
      target = await inspectClickTarget(element);
    }
    if ("error" in target) throw new Error(target.error);
    await element.click({
      timeout: 0,
      force: true,
      scroll: "none",
      position: target.position,
    });
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
