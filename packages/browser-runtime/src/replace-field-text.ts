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
        // Replace what the editor holds the way typing does: each step first
        // goes to the editor as a cancelable beforeinput, and when the editor
        // leaves it to the browser, the browser's own editing command applies
        // it. Line breaks become the editor's paragraphs. (Setting textContent
        // showed an email's greeting, paragraphs and signature as one block.)
        const document = field.ownerDocument;
        const selection = document.getSelection();
        const range = document.createRange();
        range.selectNodeContents(field);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const edit = (
          inputType: "insertText" | "insertParagraph" | "deleteContent",
          data: string | null = null,
        ) => {
          const current = selection?.rangeCount
            ? selection.getRangeAt(0)
            : null;
          const proceed = field.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              composed: true,
              inputType,
              data,
              targetRanges: current ? [new StaticRange(current)] : [],
            }),
          );
          if (proceed)
            document.execCommand(
              inputType === "deleteContent" ? "delete" : inputType,
              false,
              data ?? undefined,
            );
        };
        if (text.length === 0) edit("deleteContent");
        text.split(/\r\n?|\n/u).forEach((line, index) => {
          if (index > 0) edit("insertParagraph");
          if (line.length > 0) edit("insertText", line);
        });
        return;
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
  const controlState = await controlResultState(locator);
  const observedValue = await evaluatePresent(
    locator,
    (element) =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element.value
        : null,
    undefined,
  );
  return {
    ok: true,
    // An editor reads back as the lines it now holds, breaks kept.
    observedValue: observedValue ?? controlState.value ?? "",
    controlState,
  };
}
