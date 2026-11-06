import { withNavigationLiveness } from "./browser-navigation";
import type { ApplyUploadFile } from "@nestor/contracts";
import type { FileChooser, Locator, Page } from "playwright";

/** One attachment gesture. The caller owns ordering, retries and authorization. */
export async function attachFile(
  page: Page,
  input: Locator,
  file: ApplyUploadFile,
): Promise<void> {
  const accept = await input.getAttribute("accept");
  const accepted = (accept ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (
    accepted.length &&
    !accepted.some(
      (type) =>
        type === "*/*" ||
        (type.startsWith(".")
          ? file.name.toLowerCase().endsWith(type)
          : type.endsWith("/*")
            ? file.mimeType.toLowerCase().startsWith(type.slice(0, -1))
            : type === file.mimeType.toLowerCase()),
    )
  ) {
    throw new Error(
      `This file input accepts ${accepted.join(", ")}; ${file.name} (${file.mimeType}) was not selected.`,
    );
  }
  const payload = {
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.bytes),
  };
  if (!file.method || file.method === "input") {
    await input.setInputFiles(payload, { timeout: 0 });
    return;
  }
  // Bind to this input's own field, including a frame or open shadow root.
  // Never wander into another field or use a form's submit button as a chooser.
  const target = await input.evaluateHandle((element, method) => {
    const visible = (node: Element) =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== "hidden";
    const root = element.getRootNode() as Document | ShadowRoot;
    let box: Element | null = null;
    for (
      let node = element.parentElement, depth = 0;
      node && depth < 6;
      node = node.parentElement, depth += 1
    ) {
      if (
        node.matches("form, body") ||
        Array.from(node.querySelectorAll("input,select,textarea")).some(
          (other) =>
            other !== element &&
            !(other instanceof HTMLInputElement && other.type === "hidden"),
        )
      )
        break;
      box = node;
      if (method === "chooser") {
        if (
          node instanceof HTMLLabelElement &&
          node.control === element &&
          visible(node)
        )
          return node;
        const button = Array.from(
          node.querySelectorAll('button, [role="button"], label'),
        )
          .sort(
            (left, right) =>
              Number(left instanceof HTMLLabelElement) -
              Number(right instanceof HTMLLabelElement),
          )
          .find(
            (candidate) =>
              visible(candidate) &&
              !/\b(?:remove|delete|clear|cancel)\b|^[\s×✕✖x]*$/iu.test(
                `${candidate.getAttribute("aria-label") ?? ""} ${candidate.textContent ?? ""}`,
              ) &&
              !(
                candidate instanceof HTMLButtonElement &&
                !candidate.hasAttribute("type") &&
                !candidate.form &&
                !/\b(?:choose|select|browse|attach|upload|drop|file|resume|cv)\b/iu.test(
                  candidate.textContent ?? "",
                )
              ) &&
              !(
                candidate instanceof HTMLButtonElement &&
                candidate.type === "submit" &&
                candidate.form
              ) &&
              !(
                candidate instanceof HTMLButtonElement &&
                candidate.type === "reset"
              ) &&
              (!(candidate instanceof HTMLLabelElement) ||
                candidate.control === element),
          );
        if (button) return button;
      } else if (
        visible(node) &&
        (node.hasAttribute("ondrop") ||
          node.matches('[role="button"], [data-drop], [data-dropzone]'))
      )
        return node;
    }
    if (method === "chooser" && element.id)
      return (
        Array.from(root.querySelectorAll("label")).find(
          (node) => node.htmlFor === element.id && visible(node),
        ) ?? null
      );
    if (method !== "drop" || !box) return null;
    // Drop where a person would: on whatever shows at the middle of the
    // field's box, so the event bubbles through the zone's own listener
    // wherever in the box it is attached. Else the input's nearest shown
    // ancestor.
    box.scrollIntoView({ block: "center" });
    const rect = box.getBoundingClientRect();
    const hit = root.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (hit && box.contains(hit)) return hit;
    for (
      let node = element.parentElement;
      node && node !== box.parentElement;
      node = node.parentElement
    )
      if (visible(node)) return node;
    return box;
  }, file.method);
  try {
    const element = target.asElement();
    if (!element)
      throw new Error("This field has no reachable attachment target.");
    if (file.method === "chooser") {
      // Register before clicking and detach even when the page goes silent.
      // The idle clock follows real connection activity, with no total deadline.
      let receive!: (chooser: FileChooser) => void;
      const choosing = new Promise<FileChooser>((resolve) => {
        receive = resolve;
      });
      page.on("filechooser", receive);
      try {
        await withNavigationLiveness(page, async () => {
          await element.click({ timeout: 0 });
          const chooser = await choosing;
          if (
            !(await chooser
              .element()
              .evaluate(
                (node, original) => node === original,
                await input.elementHandle(),
              ))
          )
            throw new Error("The field did not open its own file chooser.");
          await chooser.setFiles(payload, { timeout: 0 });
        });
      } finally {
        page.off("filechooser", receive);
      }
      return;
    }
    await element.evaluate(
      (zone, data) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(data.bytes)], data.name, {
            type: data.mimeType,
          }),
        );
        for (const type of ["dragenter", "dragover", "drop"])
          zone.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          );
      },
      {
        name: file.name,
        mimeType: file.mimeType,
        bytes: Array.from(file.bytes),
      },
    );
  } finally {
    await target.dispose();
  }
}
