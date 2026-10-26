import type { ApplyWriteResult } from "@nestor/contracts";
import type { Locator, Page } from "playwright";

const missing = (
  label: string,
  offeredOptions: string[],
): ApplyWriteResult => ({
  ok: false,
  reason: "option_not_offered",
  offeredOptions,
  error: `The list did not offer "${label}".`,
});

/** Reports the list's response to one requested choice, never chooses an alternative. */
export async function choosePageOption(
  page: Page,
  locator: Locator,
  label: string,
): Promise<ApplyWriteResult> {
  const native = await locator.evaluate(
    (element) => element.tagName === "SELECT",
  );
  if (native) {
    const offered = await locator
      .locator("option:not(:disabled)")
      .allTextContents();
    if (!offered.includes(label)) return missing(label, offered);
    await locator.selectOption({ label }, { timeout: 5_000 });
    return { ok: true, observedValue: label };
  }
  await locator.click({ timeout: 5_000 });
  if (await locator.isEditable()) await locator.fill(label, { timeout: 2_000 });
  const ids = (
    (await locator.getAttribute("aria-controls")) ??
    (await locator.getAttribute("aria-owns")) ??
    ""
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  let list: Locator;
  if (ids.length === 1) {
    const escaped = await page.evaluate((id) => CSS.escape(id), ids[0]!);
    list = page.locator(`#${escaped}`);
  } else {
    list = page.locator('[role="listbox"]:visible');
    // Without a bound or unique list, another picker's choices are not evidence.
    if ((await list.count()) !== 1)
      return {
        ok: false,
        error: "The picker did not identify its option list.",
      };
  }
  const option = list.getByRole("option", { name: label, exact: true });
  try {
    await option.first().waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    const visible = await list.isVisible();
    const busy =
      (await list.getAttribute("aria-busy")) === "true" ||
      (await locator.getAttribute("aria-busy")) === "true";
    const offered = visible
      ? await list.getByRole("option").allTextContents()
      : [];
    const text = visible ? await list.innerText() : "";
    if (
      !busy &&
      (offered.length > 0 ||
        /\bno (?:options|results|matches)(?: found| available)?\b/iu.test(text))
    )
      return missing(label, offered);
    return {
      ok: false,
      error:
        "The option list did not finish loading, so its choices could not be confirmed.",
      offeredOptions: offered,
    };
  }
  await option.first().click({ timeout: 5_000 });
  return { ok: true, observedValue: label };
}
