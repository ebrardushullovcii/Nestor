import type { ApplyWriteResult } from "@nestor/contracts";
import { isVerificationCodeControl } from "@nestor/contracts";
import type { Locator } from "playwright";
import { evaluatePresent } from "./present-control";

export async function controlResultState(
  locator: Locator,
): Promise<NonNullable<ApplyWriteResult["controlState"]>> {
  return evaluatePresent(
    locator,
    (target) => {
      const element =
        target instanceof HTMLLabelElement
          ? (target.control ?? target)
          : target;
      const input = element instanceof HTMLInputElement ? element : null;
      const select = element instanceof HTMLSelectElement ? element : null;
      const checked =
        input && ["checkbox", "radio"].includes(input.type)
          ? input.checked
          : element.hasAttribute("aria-checked")
            ? element.getAttribute("aria-checked") === "true"
            : element.hasAttribute("aria-pressed")
              ? element.getAttribute("aria-pressed") === "true"
              : undefined;
      const secret =
        input?.type === "password" || input?.autocomplete === "one-time-code";
      return {
        present: element.isConnected,
        metadata: {
          autocomplete: input?.autocomplete ?? "",
          name: input?.name ?? "",
          id: element.id,
          label:
            input?.labels?.[0]?.textContent ??
            element.getAttribute("aria-label") ??
            "",
          placeholder: input?.placeholder ?? "",
        },
        ...(!secret &&
        (input ||
          select ||
          element instanceof HTMLTextAreaElement ||
          (element as HTMLElement).isContentEditable ||
          element.getAttribute("role") === "combobox")
          ? {
              value:
                input || select || element instanceof HTMLTextAreaElement
                  ? (element as HTMLInputElement).value
                  : (element.textContent ?? "").trim(),
            }
          : {}),
        ...(checked === undefined ? {} : { checked }),
        ...(element.hasAttribute("aria-selected")
          ? { selected: element.getAttribute("aria-selected") === "true" }
          : {}),
        ...(select
          ? {
              selectedOptions: Array.from(select.selectedOptions).map(
                (option) => option.text,
              ),
            }
          : {}),
      };
    },
    undefined,
  )
    .then(({ metadata, ...state }) => {
      if (isVerificationCodeControl(metadata)) delete state.value;
      return state;
    })
    .catch(() => ({ present: false }));
}
