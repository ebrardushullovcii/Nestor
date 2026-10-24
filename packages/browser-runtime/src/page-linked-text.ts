import type { Frame, Page } from "playwright";

/** A generic page read: keep a link beside its words and retain HTML item boundaries. */
export async function readPageLinkedText(page: Page): Promise<string> {
  const readFrame = (frame: Page | Frame) =>
    frame.locator("body").evaluate((body) => {
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
        const text = Array.from(node.childNodes, read).join("");
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
    });
  const root = await readFrame(page);
  const children = await Promise.all(
    page
      .frames()
      .filter((frame) => frame !== page.mainFrame())
      .slice(0, 16)
      .map((frame) =>
        readFrame(frame).catch(() => "[A child frame could not be read.]"),
      ),
  );
  return [root, ...children].join("\n\n");
}
