import type { Locator } from "playwright";
import type { ApplyWriteResult } from "@nestor/contracts";
import { evaluatePresent } from "./present-control";
import { controlResultState } from "./control-result-state";

/** Bind replacement to the element, including when browser focus stays elsewhere. */
export async function replaceFieldText(
  locator: Locator,
  value: string,
): Promise<ApplyWriteResult> {
  await evaluatePresent(
    locator,
    (element, text) => {
      const field = element as HTMLElement;
      field.focus({ preventScroll: true });
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        // Use the native setter so controlled inputs receive a real value change,
        // rather than updating React's cached value before the input event.
        if (
          element.type !== "date" &&
          element.type !== "month" &&
          element.type !== "number"
        )
          element.select();
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
          element,
          text,
        );
      } else if (field.isContentEditable) {
        field.textContent = text;
      } else {
        throw new Error("That control is not a text input; observe again.");
      }
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertReplacementText",
          data: text,
        }),
      );
      field.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
  const observedValue = await evaluatePresent(
    locator,
    (element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element.value
        : (element.textContent ?? ""),
    undefined,
  );
  return {
    ok: true,
    observedValue,
    controlState: await controlResultState(locator),
  };
}
