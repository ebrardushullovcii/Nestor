import type { Frame, Locator } from "playwright";

/** Self-contained DOM reader. Unlike innerText, hidden roots never fall back to source text. */
export function visiblePageText(
  root: Node,
  options: { linked?: boolean; refs?: Record<string, string> } = {},
): string {
  const linked = options.linked ?? false;
  const refs = options.refs ?? {};
  let item = 0;
  const read = (node: Node): string => {
    if (node instanceof Text) {
      if (!node.data.trim()) return node.data;
      const range = document.createRange();
      range.selectNodeContents(node);
      return Array.from(range.getClientRects()).some(
        (rect) => rect.width > 0 && rect.height > 0,
      )
        ? node.data
        : "";
    }
    if (!(node instanceof Element || node instanceof ShadowRoot)) return "";
    if (node instanceof Element) {
      if (node.matches("script, style, noscript, template")) return "";
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.contentVisibility === "hidden" ||
        Number(style.opacity || "1") === 0
      )
        return "";
      // Visibility can be overridden by descendants. Recurse, but do not read
      // a hidden element's own text. Display/opacity hide the entire subtree.
      const hidden = ["hidden", "collapse"].includes(style.visibility);
      if (node.tagName === "BR") return hidden ? "" : "\n";
      const index =
        linked && node.matches("article, li, [role='listitem']")
          ? ++item
          : null;
      const children =
        node instanceof HTMLSlotElement
          ? node.assignedNodes({ flatten: true })
          : [];
      const attributes =
        linked &&
        (index !== null ||
          node.matches("button, [role='button'], [onclick], [tabindex]"))
          ? Object.fromEntries(
              node
                .getAttributeNames()
                .filter(
                  (name) =>
                    name === "id" ||
                    name === "role" ||
                    name === "aria-controls" ||
                    /^data-(?:.*-)?(?:id|urn|url|href|target|key)$/u.test(name),
                )
                .map((name) => [name, node.getAttribute(name)]),
            )
          : {};
      const ref = linked
        ? refs[node.getAttribute("data-nestor-control-ref") ?? ""]
        : undefined;
      const target =
        Object.keys(attributes).length || ref
          ? `\n[Page target ${JSON.stringify({ ...attributes, ...(ref ? { clickRef: ref } : {}) })}]\n`
          : "";
      const text =
        target +
        Array.from(
          children.length
            ? children
            : (node.shadowRoot?.childNodes ?? node.childNodes),
          (child) => (hidden && child instanceof Text ? "" : read(child)),
        ).join("");
      if (linked && node instanceof HTMLAnchorElement && !hidden) {
        const label =
          text.trim() || node.getAttribute("aria-label") || node.title;
        return /^https?:/u.test(node.href) ? `${label} → ${node.href}` : label;
      }
      if (index !== null)
        return `\n[Page item ${index}]\n${text}\n[End page item ${index}]\n`;
      return ["inline", "inline-block", "contents"].includes(style.display)
        ? text
        : `\n${text}\n`;
    }
    return Array.from(node.childNodes, read).join("");
  };
  // A selected element may have a hidden ancestor, including a shadow host.
  for (
    let node: Element | null =
      root instanceof Element
        ? root
        : root instanceof ShadowRoot
          ? root.host
          : null;
    node;
    node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null
  ) {
    const style = getComputedStyle(node);
    if (
      node.matches("script, style, noscript, template") ||
      style.display === "none" ||
      style.contentVisibility === "hidden" ||
      Number(style.opacity || "1") === 0
    )
      return "";
  }
  return read(root)
    .replace(/[\t ]+/gu, " ")
    .replace(/\n\s*\n/gu, "\n")
    .trim();
}

export function readVisibleText(
  locator: Locator,
  linked = false,
  refs: Record<string, string> = {},
): Promise<string> {
  return locator.evaluate(visiblePageText, { linked, refs });
}

/** A child document is visible only when every embedding frame is drawn. */
export async function isVisibleFrame(frame: Frame): Promise<boolean> {
  for (
    let current: Frame | null = frame;
    current?.parentFrame();
    current = current.parentFrame()
  ) {
    // Lightweight page doubles do not expose the frame element.
    if (typeof current.frameElement !== "function") continue;
    const element = await current.frameElement();
    try {
      if (
        !(await element.evaluate(
          (node) =>
            node instanceof Element &&
            node.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
            }) &&
            node.getClientRects().length > 0,
        ))
      )
        return false;
    } finally {
      await element.dispose();
    }
  }
  return true;
}
