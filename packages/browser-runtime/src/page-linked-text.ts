import { withBrowserReadLiveness } from "./browser-read-liveness";
import type { Frame, Page } from "playwright";
import { pageClickReferences } from "./page-control-refs";

/** A generic page read: keep a link beside its words and retain HTML item boundaries. */
export async function readPageLinkedText(page: Page): Promise<string> {
  const readFrame = (frame: Page | Frame) =>
    frame.locator("body").evaluate((body, refs) => {
      let item = 0;
      const read = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        if (!(node instanceof Element)) return "";
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden")
          return "";
        if (
          node instanceof HTMLElement &&
          style.display !== "contents" &&
          node.getClientRects().length === 0
        )
          return "";
        if (node.tagName === "BR") return "\n";
        if (node instanceof HTMLAnchorElement) {
          const label =
            node.innerText.trim() ||
            node.getAttribute("aria-label") ||
            node.title;
          return /^https?:/u.test(node.href)
            ? `${label} → ${node.href}`
            : label;
        }
        const index = node.matches("article, li, [role='listitem']")
          ? ++item
          : null;
        const clickable = node.matches(
          "button, [role='button'], [onclick], [tabindex]",
        );
        const attributes =
          clickable || index !== null
            ? Object.fromEntries(
                node
                  .getAttributeNames()
                  .filter(
                    (name) =>
                      name === "id" ||
                      name === "role" ||
                      name === "aria-controls" ||
                      /^data-(?:.*-)?(?:id|urn|url|href|target|key)$/u.test(
                        name,
                      ),
                  )
                  .map((name) => [name, node.getAttribute(name)]),
              )
            : {};
        const ref = refs[node.getAttribute("data-nestor-control-ref") ?? ""];
        const target =
          Object.keys(attributes).length || ref
            ? `\n[Page target ${JSON.stringify({ ...attributes, ...(ref ? { clickRef: ref } : {}) })}]\n`
            : "";
        const text = target + Array.from(node.childNodes, read).join("");
        if (index !== null)
          return `\n[Page item ${index}]\n${text}\n[End page item ${index}]\n`;
        return [
          "block",
          "flex",
          "grid",
          "list-item",
          "table",
          "table-row",
        ].includes(style.display)
          ? `\n${text}\n`
          : text;
      };
      return read(body)
        .replace(/[\t ]+/gu, " ")
        .replace(/\n\s*\n/gu, "\n")
        .trim();
    }, pageClickReferences(page));
  return withBrowserReadLiveness(page, async () => {
    const root = await readFrame(page);
    const children = await Promise.all(
      page
        .frames()
        .filter((frame) => frame !== page.mainFrame())
        .map((frame) =>
          readFrame(frame).catch(() => "[A child frame could not be read.]"),
        ),
    );
    return [root, ...children].join("\n\n");
  });
}
