import type { Frame, Locator } from "playwright";

/** Self-contained DOM reader. Unlike innerText, hidden roots never fall back to source text. */
export function visiblePageText(
  root: Node,
  options: { linked?: boolean; refs?: Record<string, string> } = {},
): string {
  const linked = options.linked ?? false;
  const refs = options.refs ?? {};
  let item = 0;
  // Pages replace globals: Prototype.js (WeWorkRemotely bundles 1.7.3) sets
  // Array.from to a copy that ignores its map function, which turned every
  // read into "[object HTMLDivElement]...". Read children with a plain loop.
  const readAll = (
    nodes: ArrayLike<Node>,
    each: (node: Node) => string,
  ): string => {
    let text = "";
    for (let index = 0; index < nodes.length; index += 1)
      text += each(nodes[index]!);
    return text;
  };
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
        readAll(
          children.length
            ? children
            : (node.shadowRoot?.childNodes ?? node.childNodes),
          (child) => (hidden && child instanceof Text ? "" : read(child)),
        );
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
    return readAll(node.childNodes, read);
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
    node =
      node.parentElement ??
      (node.getRootNode() instanceof ShadowRoot
        ? (node.getRootNode() as ShadowRoot).host
        : null)
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
    // An ad or tracker frame can detach while the page is read. A frame that
    // is gone is not drawn; the rest of the page still reads.
    const gone = (error: unknown) => {
      if (isDetachedFrameError(current, error)) return false;
      throw error;
    };
    if (current.isDetached?.()) return false;
    let element: Awaited<ReturnType<Frame["frameElement"]>>;
    try {
      element = await current.frameElement();
    } catch (error) {
      return gone(error);
    }
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
    } catch (error) {
      return gone(error);
    } finally {
      await element.dispose().catch(() => undefined);
    }
  }
  return true;
}

/** A frame removed from its page while it was being read. */
export function isDetachedFrameError(
  frame: Pick<Frame, "isDetached"> | null,
  error: unknown,
): boolean {
  return (
    Boolean(frame?.isDetached?.()) ||
    /Frame (?:has been|was) detached/iu.test(
      error instanceof Error ? error.message : String(error),
    )
  );
}
