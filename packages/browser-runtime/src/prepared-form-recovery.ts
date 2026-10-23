import type { BrowserContext, Page } from "playwright";

const FIELDS =
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),textarea,select";

export interface RecoveryFile {
  name: string;
  load(): Promise<Uint8Array>;
}

/** Ephemeral main-process state; never logged or sent through IPC. */
export interface PreparedFormSnapshot {
  url: string;
  structure: string;
  fields: Array<{
    type: string;
    value: string;
    checked: boolean;
    selected: string[];
    files: Array<{ name: string; type: string; size: number }>;
    disabled: boolean;
    readOnly: boolean;
  }>;
}

export async function capturePreparedForm(
  page: Page,
): Promise<PreparedFormSnapshot | null> {
  if (page.isClosed() || page.frames().length !== 1) return null;
  return page.evaluate((selector) => {
    // Custom widgets, frame state and credentials need the original page.
    if (
      document.querySelector(
        "input[type=password],input[autocomplete=one-time-code],[contenteditable=true],[role=combobox]:not(input):not(select),[role=checkbox]:not(input),[role=radio]:not(input)",
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
      fields: controls.map((control) => ({
        type: control.type,
        value: control.type === "file" ? "" : control.value,
        checked: control instanceof HTMLInputElement && control.checked,
        selected:
          control instanceof HTMLSelectElement
            ? [...control.selectedOptions].map((option) => option.value)
            : [],
        files:
          control instanceof HTMLInputElement
            ? [...(control.files ?? [])].map((file) => ({
                name: file.name,
                type: file.type,
                size: file.size,
              }))
            : [],
        disabled: control.disabled,
        readOnly: "readOnly" in control && control.readOnly,
      })),
    };
  }, FIELDS);
}

/** No model calls, clicks, navigation between steps, or submission. */
export async function restorePreparedForm(input: {
  context: BrowserContext;
  snapshot: PreparedFormSnapshot;
  files: readonly RecoveryFile[];
  guard(page: Page): Promise<unknown>;
}): Promise<Page | null> {
  const page = await input.context.newPage();
  const deadline = setTimeout(() => {
    void page.close({ runBeforeUnload: false }).catch(() => undefined);
  }, 20_000);
  try {
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
          if (bytes.byteLength !== savedFile.size)
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
    const restored = await capturePreparedForm(page);
    if (JSON.stringify(restored) !== JSON.stringify(input.snapshot))
      throw new Error("Answers did not restore exactly");
    return page;
  } catch {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
