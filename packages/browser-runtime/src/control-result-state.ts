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
      // What a rich-text editor holds, one line per paragraph or line break,
      // so the model reads the paragraphs it wrote.
      const editorText = (root: Element): string => {
        let text = "";
        const walk = (node: Node): void => {
          for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 3) {
              const data = (child as Text).data;
              // Source indentation between blocks is not text.
              if (!/^\s*\n\s*$/u.test(data))
                text += data.replace(/[\t\n\r]+/gu, " ");
            } else if (child.nodeName === "BR") {
              text += "\n";
            } else if (child.nodeType === 1) {
              const display = getComputedStyle(child as Element).display;
              if (display === "none") continue;
              const block = !display.startsWith("inline");
              if (block && text && !text.endsWith("\n")) text += "\n";
              walk(child);
              if (block && text && !text.endsWith("\n")) text += "\n";
            }
          }
        };
        walk(root);
        return text
          .replace(/\u00a0/gu, " ")
          .replace(/[ \t]+$/gmu, "")
          .trim();
      };
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
                  : (element as HTMLElement).isContentEditable
                    ? editorText(element)
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
