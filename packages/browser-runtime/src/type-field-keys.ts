import type { Locator } from "playwright";
import type { ApplyWriteResult } from "@nestor/contracts";
import { presentControl } from "./present-control";
import { controlResultState } from "./control-result-state";

/** Browser input emits keydown, keypress, input and keyup, in character order. */
export async function typeFieldKeys(
  locator: Locator,
  text: string,
): Promise<ApplyWriteResult> {
  const element = await presentControl(locator);
  try {
    await element.type(text, { timeout: 0 });
  } finally {
    await element.dispose();
  }
  const controlState = await controlResultState(locator);
  return { ok: true, observedValue: controlState.value ?? "", controlState };
}
