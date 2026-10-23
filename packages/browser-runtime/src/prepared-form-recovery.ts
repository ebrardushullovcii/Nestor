import type { BrowserContext, Page } from "playwright";
import { createHash } from "node:crypto";
import {
  PreparedFormSnapshotSchema,
  type PreparedFormAttachment,
  type PreparedFormSnapshot,
} from "@nestor/contracts";
export type { PreparedFormSnapshot } from "@nestor/contracts";

/**
 * Every file in the snapshot must resolve to exactly one resume or asset
 * record with the same name and bytes, or a restart could not refill it.
 */
export function describePreparedFormAttachments(
  snapshot: PreparedFormSnapshot,
  available: readonly PreparedFormAttachment[],
): PreparedFormAttachment[] | null {
  const descriptors: PreparedFormAttachment[] = [];
  for (const file of snapshot.fields.flatMap((field) => field.files)) {
    const matches = available.filter(
      (candidate) =>
        candidate.name === file.name && candidate.sha256 === file.sha256,
    );
    if (matches.length !== 1) return null;
    if (!descriptors.some((candidate) => candidate.name === file.name))
      descriptors.push(matches[0]!);
  }
  return descriptors;
}

const FIELDS =
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),textarea,select";

export interface RecoveryFile {
  name: string;
  load(): Promise<Uint8Array>;
}

export async function capturePreparedForm(
  page: Page,
): Promise<PreparedFormSnapshot | null> {
  if (page.isClosed() || page.frames().length !== 1) return null;
  const captured = await page.evaluate(async (selector) => {
    const url = new URL(location.href);
    if (url.username || url.password || url.search || url.hash) return null;
    // Custom widgets, frame state and credentials need the original page.
    if (
      document.querySelector(
        "input[type=password],input[autocomplete=one-time-code],input[autocomplete=username],[contenteditable=true],[role=combobox]:not(select),[role=listbox]:not(select),[role=switch]:not(input),[role=checkbox]:not(input),[role=radio]:not(input),input[autocomplete=current-password],input[autocomplete=new-password]",
      )
    )
      return null;
    if (
      /captcha|not a robot|verify (?:that )?you are human/iu.test(
        document.body?.innerText ?? "",
      )
    )
      return null;
    const controls = [
      ...document.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(selector),
    ];
    if (!controls.length || controls.length > 200) return null;
    if (
      controls.some((control) =>
        /password|passwd|captcha|csrf|token|secret|session|otp|credential/iu.test(
          `${control.name} ${control.id} ${control.autocomplete}`,
        ),
      )
    )
      return null;
    const digest = async (bytes: ArrayBuffer) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    if (
      controls.some(
        (control) =>
          control instanceof HTMLInputElement &&
          ![
            "text",
            "email",
            "tel",
            "url",
            "number",
            "date",
            "datetime-local",
            "month",
            "week",
            "time",
            "search",
            "checkbox",
            "radio",
            "file",
          ].includes(control.type),
      )
    )
      return null;
    const shape = controls.map((control) => ({
      tag: control.tagName,
      id: control.id,
      name: control.name,
      type: control.type,
      label: control.labels
        ? [...control.labels]
            .map((label) => label.textContent?.trim())
            .join("|")
        : "",
      options:
        control instanceof HTMLSelectElement
          ? [...control.options].map((option) => [option.value, option.text])
          : [],
      disabled: control.disabled,
      readOnly: "readOnly" in control && control.readOnly,
    }));
    return {
      url: location.href,
      structure: JSON.stringify({
        shape,
        // Never replay hidden state. Changed tokens or wizard answers keep
        // the original page instead of passing an incomplete reconstruction.
        hidden: [
          ...document.querySelectorAll<HTMLInputElement>("input[type=hidden]"),
        ].map((input) => [input.name, input.value]),
        title: document.title,
        steps: [
          ...document.querySelectorAll("h1,h2,button,input[type=submit]"),
        ].map(
          (element) =>
            element.textContent?.trim() || element.getAttribute("value"),
        ),
      }),
      fields: await Promise.all(
        controls.map(async (control) => ({
          type: control.type,
          value: control.type === "file" ? "" : control.value,
          checked: control instanceof HTMLInputElement && control.checked,
          selected:
            control instanceof HTMLSelectElement
              ? [...control.selectedOptions].map((option) => option.value)
              : [],
          files:
            control instanceof HTMLInputElement
              ? await Promise.all(
                  [...(control.files ?? [])].map(async (file) => ({
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    sha256: await digest(await file.arrayBuffer()),
                  })),
                )
              : [],
          disabled: control.disabled,
          readOnly: "readOnly" in control && control.readOnly,
        })),
      ),
    };
  }, FIELDS);
  if (!captured) return null;
  // Structure includes hidden values only while hashing in main. Persist only
  // its digest: never a CSRF token, hidden answer, cookie or session value.
  return PreparedFormSnapshotSchema.parse({
    ...captured,
    structure: createHash("sha256").update(captured.structure).digest("hex"),
  });
}

/** No model calls, clicks, navigation between steps, or submission. */
export async function restorePreparedForm(input: {
  context: BrowserContext;
  snapshot: PreparedFormSnapshot;
  files: readonly RecoveryFile[];
  guard(page: Page): Promise<unknown>;
  onProgress?(phase: "refilling" | "verifying"): void;
  onFailure?(
    reason: "form_changed" | "attachment_unavailable" | "reopen_failed",
  ): void;
}): Promise<Page | null> {
  const creation = input.context.newPage();
  let page: Page | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    page = await Promise.race([
      creation,
      new Promise<Page>((_resolve, reject) => {
        deadline = setTimeout(() => {
          void creation
            .then((latePage) => latePage.close({ runBeforeUnload: false }))
            .catch(() => undefined);
          reject(new Error("Form refill timed out"));
        }, 20_000);
      }),
    ]);
    await input.guard(page);
    await page.goto(input.snapshot.url, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    const fresh = await capturePreparedForm(page);
    if (
      !fresh ||
      fresh.url !== input.snapshot.url ||
      fresh.structure !== input.snapshot.structure
    )
      throw new Error("Form changed");
    const controls = page.locator(FIELDS);
    input.onProgress?.("refilling");
    for (const [index, field] of input.snapshot.fields.entries()) {
      const control = controls.nth(index);
      if (field.disabled || field.readOnly) continue;
      if (field.type === "file") {
        const payloads = [];
        for (const savedFile of field.files) {
          const name = savedFile.name;
          const matches = input.files.filter((file) => file.name === name);
          if (matches.length !== 1) throw new Error("Attachment unavailable");
          const file = matches[0]!;
          const bytes = await file.load();
          if (
            bytes.byteLength !== savedFile.size ||
            createHash("sha256").update(bytes).digest("hex") !==
              savedFile.sha256
          )
            throw new Error("Attachment changed");
          payloads.push({
            name,
            mimeType: savedFile.type,
            buffer: Buffer.from(bytes),
          });
        }
        if (payloads.length)
          await control.setInputFiles(payloads, { timeout: 3_000 });
      } else if (field.type === "checkbox" || field.type === "radio") {
        // Restore only changed native checked state; never click a control.
        await control.evaluate((element, checked) => {
          const input = element as HTMLInputElement;
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "checked",
          )?.set?.call(input, checked);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, field.checked);
      } else if (field.type.startsWith("select")) {
        await control.selectOption(field.selected, { timeout: 3_000 });
      } else {
        await control.fill(field.value, { timeout: 3_000 });
      }
    }
    input.onProgress?.("verifying");
    const restored = await capturePreparedForm(page);
    if (JSON.stringify(restored) !== JSON.stringify(input.snapshot))
      throw new Error("Answers did not restore exactly");
    return page;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    input.onFailure?.(
      /Attachment/u.test(message)
        ? "attachment_unavailable"
        : ["Form changed", "Answers did not restore exactly"].includes(message)
          ? "form_changed"
          : "reopen_failed",
    );
    await page?.close({ runBeforeUnload: false }).catch(() => undefined);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
