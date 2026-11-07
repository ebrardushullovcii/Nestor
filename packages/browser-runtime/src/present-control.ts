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
