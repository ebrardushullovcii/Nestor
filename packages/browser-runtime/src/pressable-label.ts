/** Self-contained: serialized into ordinary and closed-shadow documents. */
export function pressableLabel(this: Element): string {
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof Element) {
      if (node.matches("script,style,template,noscript")) return "";
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return "";
      if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) return assigned.map(text).join(" ");
      }
      if (node.shadowRoot) return text(node.shadowRoot);
    }
    return Array.from(node.childNodes).map(text).join(" ");
  };
  const root = this.getRootNode() as Document | ShadowRoot;
  const labelled = (this.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => root.querySelector(`#${CSS.escape(id)}`))
    .map((node) => (node ? text(node) : ""))
    .join(" ");
  return (
    this.getAttribute("aria-label") ||
    labelled.trim() ||
    (this instanceof HTMLInputElement
      ? Array.from(this.labels ?? [])
          .map(text)
          .join(" ")
          .trim()
      : "") ||
    (this instanceof HTMLInputElement &&
    ["submit", "button", "image"].includes(this.type)
      ? this.value
      : "") ||
    text(this).trim() ||
    this.getAttribute("title") ||
    this.getAttribute("alt") ||
    ""
  )
    .replace(/\s+/gu, " ")
    .trim();
}
