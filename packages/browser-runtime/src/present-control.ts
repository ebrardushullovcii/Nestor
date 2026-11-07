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
 * Presses the observed element once. An element a person can reach gets an
 * ordinary click; one that is covered, hidden or off-screen gets a click aimed
 * straight at its position (or an immediate error), never an endless wait for
 * it to become clickable.
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
    const clickable = await element.evaluate(reachable);
    await element.click({ timeout: 0, force: !clickable });
  } finally {
    await element.dispose();
  }
}
