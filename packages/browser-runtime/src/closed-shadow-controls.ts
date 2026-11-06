import type { ApplyWriteResult, RawApplyClickable } from "@nestor/contracts";
import type { CDPSession, Frame, Page } from "playwright";
interface DomNode {
  nodeType: number;
  backendNodeId: number;
  shadowRootType?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

interface Target {
  frame: Frame;
  node: number;
  document: number;
}
const targets = new WeakMap<Page, Map<string, Target>>();
let nextRef = 0;

// Serialized into the node's own document. No page values, hidden fields or
// tokens are read: this is the same clickable surface as the ordinary DOM read.
function describe(
  this: Element,
  selector: string,
): Omit<RawApplyClickable, "index" | "ref"> | null {
  if (!this.isConnected || !this.matches(selector)) return null;
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  const labelled = (this.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .map(
      (id) =>
        (this.getRootNode() as Document | ShadowRoot).querySelector(
          `#${CSS.escape(id)}`,
        )?.textContent ?? "",
    )
    .join(" ");
  const input = this as HTMLInputElement;
  const label =
    this.getAttribute("aria-label") ||
    labelled.trim() ||
    Array.from(input.labels ?? [])
      .map((item) => item.textContent)
      .join(" ")
      .trim() ||
    (this instanceof HTMLElement ? this.innerText : this.textContent)?.trim() ||
    this.getAttribute("title") ||
    this.getAttribute("alt") ||
    "";
  return {
    ...(window !== window.top
      ? { frame: { origin: location.origin, pathname: location.pathname } }
      : {}),
    label: label.replace(/\s+/gu, " ").trim(),
    role:
      this.getAttribute("role") ||
      (input.type === "checkbox"
        ? "checkbox"
        : input.type === "radio"
          ? "radio"
          : ""),
    tagName: this.localName,
    visible:
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none",
    disabled:
      this.matches(":disabled") ||
      this.closest("[aria-disabled='true']") !== null,
    topOffset: rect.top + scrollY,
  };
}

async function inNode<T>(
  session: CDPSession,
  node: number,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  const { object } = await session.send("DOM.resolveNode", {
    backendNodeId: node,
  });
  if (!object.objectId) throw new Error("Stale control; observe again.");
  try {
    const result = await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error("Stale control; observe again.");
    return result.result.value as T;
  } finally {
    await session
      .send("Runtime.releaseObject", { objectId: object.objectId })
      .catch(() => undefined);
  }
}

/** CDP can read closed roots without changing attachShadow or the site's DOM. */
export async function readClosedShadowControls(
  page: Page,
  selector: string,
): Promise<RawApplyClickable[]> {
  // Test doubles and non-Chromium runtimes have no CDP surface.
  if (!page.context?.()?.newCDPSession) return [];
  const previous = targets.get(page) ?? new Map<string, Target>();
  const current = new Map(previous);
  const controls: RawApplyClickable[] = [];
  for (const frame of page.frames()) {
    let session: CDPSession;
    try {
      session = await page
        .context()
        .newCDPSession(frame === page.mainFrame() ? page : frame);
    } catch (error) {
      // In-process frames are included by their parent target's DOM tree.
      if (String(error).includes("part of the parent frame's session"))
        continue;
      throw error;
    }
    try {
      const { root } = await session.send("DOM.getDocument", {
        depth: -1,
        pierce: true,
      });
      const candidates: number[] = [];
      const visit = (node: DomNode, closed: boolean) => {
        if (node.shadowRootType === "user-agent") return;
        closed ||= node.shadowRootType === "closed";
        if (closed && node.nodeType === 1) candidates.push(node.backendNodeId);
        for (const child of node.children ?? []) visit(child, closed);
        for (const shadow of node.shadowRoots ?? []) visit(shadow, closed);
        // Child document controls are read in that document, irrespective of
        // whether the iframe's owner happens to be in a closed root.
        if (node.contentDocument) visit(node.contentDocument, false);
      };
      visit(root, false);
      for (const node of candidates) {
        const control = await inNode<Omit<
          RawApplyClickable,
          "index" | "ref"
        > | null>(session, node, describe.toString(), [selector]);
        if (!control) continue;
        const existing = [...previous].find(
          ([, target]) =>
            target.frame === frame &&
            target.node === node &&
            target.document === root.backendNodeId,
        );
        const ref = existing?.[0] ?? `s${nextRef++}`;
        current.set(ref, { frame, node, document: root.backendNodeId });
        controls.push({
          ...control,
          ref,
          index: controls.length,
        });
      }
    } finally {
      await session.detach().catch(() => undefined);
    }
  }
  targets.set(page, current);
  return controls;
}

/** Click through Chromium's input router, including out-of-process frames. */
export async function clickClosedShadowControl(
  page: Page,
  ref: string,
): Promise<ApplyWriteResult> {
  const target = targets.get(page)?.get(ref);
  if (!target || target.frame.isDetached())
    return { ok: false, error: "Stale control; observe again." };
  const session = await page
    .context()
    .newCDPSession(target.frame === page.mainFrame() ? page : target.frame);
  try {
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    if (root.backendNodeId !== target.document)
      return { ok: false, error: "Stale control; observe again." };
    const state = await inNode<{
      connected: boolean;
      disabled: boolean;
      toggle: boolean;
      rtl: boolean;
    }>(
      session,
      target.node,
      `function() { return { connected: this.isConnected && this.ownerDocument.defaultView?.document === this.ownerDocument, disabled: this.matches(':disabled') || !!this.closest('[aria-disabled="true"]'), toggle: this.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]'), rtl: getComputedStyle(this).direction === 'rtl' }; }`,
    );
    if (!state.connected)
      return { ok: false, error: "Stale control; observe again." };
    if (state.disabled) return { ok: false, error: "The control is disabled." };
    await session.send("DOM.scrollIntoViewIfNeeded", {
      backendNodeId: target.node,
    });
    const { quads } = await session.send("DOM.getContentQuads", {
      backendNodeId: target.node,
    });
    const quad = quads[0];
    if (!quad) return { ok: false, error: "The control is not visible." };
    // A checkbox's input can cover its whole label while its square occupies
    // only the inline-start edge. Aim at that square, as a person would.
    const width = Math.hypot(quad[2]! - quad[0]!, quad[3]! - quad[1]!);
    const height = Math.hypot(quad[6]! - quad[0]!, quad[7]! - quad[1]!);
    const inset = state.toggle && width > height ? height / (2 * width) : 0.5;
    const fraction = state.rtl ? 1 - inset : inset;
    const x =
      quad[0]! + (quad[2]! - quad[0]!) * fraction + (quad[6]! - quad[0]!) / 2;
    const y =
      quad[1]! + (quad[3]! - quad[1]!) * fraction + (quad[7]! - quad[1]!) / 2;
    // Use this target's viewport and input router. Main-page coordinates
    // depend on compositor hit-test data that a hidden OOPIF may not publish.
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return { ok: true, observedValue: "clicked" };
  } catch (error) {
    return {
      ok: false,
      error: `The control could not be clicked: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** The same observed checkbox can be addressed by either click or set_checkbox. */
export async function setClosedShadowToggle(
  page: Page,
  ref: string,
  checked: boolean,
): Promise<ApplyWriteResult> {
  const target = targets.get(page)?.get(ref);
  if (!target || target.frame.isDetached())
    return { ok: false, error: "Stale control; observe again." };
  const session = await page
    .context()
    .newCDPSession(target.frame === page.mainFrame() ? page : target.frame);
  try {
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    if (root.backendNodeId !== target.document)
      return { ok: false, error: "Stale control; observe again." };
    const state = await inNode<{ toggle: boolean; checked: boolean }>(
      session,
      target.node,
      `function(){return {toggle:this.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"]'),checked:typeof this.checked==='boolean'?this.checked:this.getAttribute('aria-checked')==='true'}}`,
    );
    if (!state.toggle)
      return { ok: false, error: "That element is not a checkbox or radio." };
    if (state.checked === checked)
      return { ok: true, observedValue: checked ? "checked" : "not checked" };
    return await clickClosedShadowControl(page, ref);
  } catch (error) {
    return {
      ok: false,
      error: `The checkbox could not be set: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}
