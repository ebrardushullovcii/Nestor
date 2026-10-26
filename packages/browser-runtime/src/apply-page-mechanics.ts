import type {
  ApplyBlockedAttempt,
  RawApplyClickable,
  RawApplyHeading,
  RawApplyOpenedTab,
  ApplyNavigationResult,
  ApplyPageSession,
  ApplyRawPageHands,
  ApplyServiceWorkerFinding,
  ApplyUploadFile,
  ApplyWriteResult,
  RawApplyAction,
  RawApplyControl,
  RawApplyLink,
  RawApplyPage,
} from "@nestor/contracts";
import { describeBrowserError, isPageReplacedError } from "@nestor/contracts";
import type { Frame, Locator, Page } from "playwright";
import { readPageLinkedText } from "./page-linked-text";

import {
  closePrepareOnlyAuthorizedFormActionWindow,
  closePrepareOnlyIntermediateMutationWindow,
  ensurePrepareOnlyMutationGuard,
  getBlockedPrepareOnlyAttempts,
  openPrepareOnlyAuthorizedFormActionWindow,
  openPrepareOnlyIntermediateMutationWindow,
  openPrepareOnlyAttachmentUploadWindow,
  registerPrepareOnlyPreparedValue,
  type ApplicationRunServiceWorkerSentinel,
  waitForPrepareOnlyAuthorizedFormAction,
} from "./playwright-application-flow";

/**
 * Reading and writing an application form, and nothing else.
 *
 * This is the browser half of the apply seam. It knows how to find the
 * controls on a page, report what they say about themselves, and change one of
 * them. It does not know what a resume field is, which control should be
 * touched next, or whether a write is allowed; that is workflow policy and
 * lives above this layer.
 */

export const APPLY_CONTROL_SELECTOR =
  "input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select, [role='combobox'], [role='checkbox'], [role='radio'], [contenteditable='true']";

export const APPLY_ACTION_SELECTOR =
  "button, input[type='submit'], input[type='button'], [role='button']";

export const APPLY_LINK_SELECTOR = "a[href]";

/**
 * Everything else a person could press.
 *
 * Sites are built out of divs with click handlers, cards, and tiles as often
 * as they are out of buttons. A harness that can only press a `<button>`
 * cannot use the web.
 */
export const APPLY_CLICKABLE_SELECTOR =
  "[onclick], [role='link'], [role='menuitem'], [role='tab'], [role='option'], [data-testid], [class*='card'], [class*='tile'], summary, label[for]";

/**
 * Lets a page that is mid-navigation finish before it is read.
 *
 * Bounded: a page that never settles is read as it is. Short, because this
 * runs before every read and a run is made of many reads.
 */
async function settlePage(page: Page, timeout = 4_000): Promise<void> {
  await page
    .waitForLoadState("domcontentloaded", { timeout })
    .catch(() => undefined);
}

export async function readRawApplyPage(page: Page): Promise<RawApplyPage> {
  await settlePage(page);
  try {
    return await includeChildFrameContent(
      page,
      await readRawApplyPageOnce(page),
    );
  } catch (error) {
    if (!isPageReplacedError(error)) {
      throw new Error(
        describeBrowserError(error, "The page could not be read."),
      );
    }
  }
  // The page moved on while it was being read. Wait for where it went and
  // read that: a second failure is genuinely the page's, and is said plainly.
  await settlePage(page, 8_000);
  try {
    return await includeChildFrameContent(
      page,
      await readRawApplyPageOnce(page),
    );
  } catch (error) {
    throw new Error(describeBrowserError(error, "The page could not be read."));
  }
}

/**
 * Reads same-origin and cross-origin child frames through Playwright's frame
 * handles. Frame elements get explicit refs (`f0c1`, `f0a2`, …), so a later
 * tool call reaches the same frame instead of accidentally addressing a
 * similarly positioned element in the top document.
 */
async function includeChildFrameContent(
  page: Page,
  root: RawApplyPage,
): Promise<RawApplyPage> {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  if (frames.length === 0) return root;

  const snapshots = await Promise.all(
    frames.slice(0, 16).map((frame, index) => readApplyFrame(frame, index)),
  );
  const readable = snapshots.filter(
    (snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null,
  );
  if (readable.length === 0) return root;

  return {
    ...root,
    bodyText: [root.bodyText, ...readable.map((item) => item.bodyText)]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 20_000),
    controls: [...root.controls, ...readable.flatMap((item) => item.controls)],
    actions: [...root.actions, ...readable.flatMap((item) => item.actions)],
    links: [...root.links, ...readable.flatMap((item) => item.links)],
    clickables: [
      ...root.clickables,
      ...readable.flatMap((item) => item.clickables),
    ],
    headings: [...root.headings, ...readable.flatMap((item) => item.headings)],
    validationErrors: [
      ...root.validationErrors,
      ...readable.flatMap((item) => item.validationErrors),
    ].slice(0, 24),
  };
}

async function readApplyFrame(frame: Frame, frameIndex: number) {
  try {
    const [
      controls,
      actions,
      links,
      clickables,
      headings,
      bodyText,
      validationErrors,
    ] = await Promise.all([
      frame
        .locator(APPLY_CONTROL_SELECTOR)
        .evaluateAll((elements, prefix): RawApplyControl[] => {
          const labelText = (element: Element | null): string => {
            if (!element) return "";
            const clone = element.cloneNode(true) as Element;
            clone
              .querySelectorAll(
                "input, textarea, select, [role='option'], [role='listbox']",
              )
              .forEach((control) => control.remove());
            return (clone.textContent ?? "").replace(/\s+/gu, " ").trim();
          };
          const roots = Array.from(
            new Set(elements.map((element) => element.getRootNode())),
          );
          const scopeKeyFor = (element: Element): string => {
            const root = element.getRootNode();
            const rootIndex = roots.indexOf(root);
            const form =
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element instanceof HTMLSelectElement
                ? element.form
                : null;
            const forms =
              root instanceof Document || root instanceof ShadowRoot
                ? Array.from(root.querySelectorAll("form"))
                : [];
            return `${prefix}r${rootIndex}${
              form ? `form${forms.indexOf(form)}` : "root"
            }`;
          };
          return elements.map((element, index) => {
            const html = element as HTMLElement;
            const input = element instanceof HTMLInputElement ? element : null;
            const textarea =
              element instanceof HTMLTextAreaElement ? element : null;
            const select =
              element instanceof HTMLSelectElement ? element : null;
            const style = window.getComputedStyle(html);
            const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
            const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
              .split(/\s+/u)
              .filter(Boolean)
              .map((id) => labelText(document.getElementById(id)))
              .join(" ")
              .trim();
            const labels =
              input?.labels ?? textarea?.labels ?? select?.labels ?? null;
            const nearbyQuestionText = (): string => {
              let ancestor = element.parentElement;
              for (let depth = 0; ancestor && depth < 5; depth += 1) {
                const clone = ancestor.cloneNode(true) as HTMLElement;
                clone
                  .querySelectorAll(
                    "input, textarea, select, button, [role='option'], [role='listbox']",
                  )
                  .forEach((candidate) => candidate.remove());
                const text = (clone.textContent ?? "")
                  .replace(/\s+/gu, " ")
                  .trim();
                if (text.length > 0 && text.length <= 500) return text;
                ancestor = ancestor.parentElement;
              }
              return "";
            };
            const label =
              ariaLabel ||
              labelledBy ||
              (labels
                ? Array.from(labels)
                    .map((item) => labelText(item))
                    .filter(Boolean)
                    .join(" ")
                : "") ||
              labelText(element.closest("label")) ||
              nearbyQuestionText() ||
              "";
            // Nested question groups keep the outer form step's own label.
            // Reading only the nearest legend dropped that context for skills
            // and radio groups while other questions still showed the step.
            const legends: string[] = [];
            let fieldset = element.closest("fieldset");
            while (fieldset) {
              const legend = labelText(
                fieldset.querySelector(":scope > legend"),
              );
              if (legend && !legends.includes(legend)) legends.unshift(legend);
              fieldset = fieldset.parentElement?.closest("fieldset") ?? null;
            }
            const legend = legends.join(" — ");
            const role = element.getAttribute("role")?.toLowerCase() ?? "";
            const tagName = select
              ? "select"
              : textarea
                ? "textarea"
                : input
                  ? "input"
                  : "contenteditable";
            return {
              ref: `${prefix}c${index}`,
              index,
              tagName,
              inputType: input?.type.toLowerCase() ?? (role || tagName),
              accept: input?.accept ?? "",
              min: input?.min ?? "",
              max: input?.max ?? "",
              step: input?.step ?? "",
              maxLength: input?.maxLength ?? textarea?.maxLength ?? -1,
              role,
              id: html.id,
              name: input?.name ?? textarea?.name ?? select?.name ?? "",
              scopeKey: scopeKeyFor(element),
              label,
              groupLabel: legend ?? "",
              placeholder: input?.placeholder ?? textarea?.placeholder ?? "",
              autocomplete: input?.autocomplete ?? textarea?.autocomplete ?? "",
              required:
                Boolean(
                  input?.required ?? textarea?.required ?? select?.required,
                ) || element.getAttribute("aria-required") === "true",
              invalid:
                element.getAttribute("aria-invalid") === "true" ||
                Boolean(
                  (input ?? textarea ?? select)?.validity &&
                  !(input ?? textarea ?? select)?.validity.valid,
                ),
              validationMessage:
                input?.validationMessage ??
                textarea?.validationMessage ??
                select?.validationMessage ??
                "",
              disabled:
                Boolean(
                  input?.disabled ?? textarea?.disabled ?? select?.disabled,
                ) ||
                element.matches(":disabled") ||
                element.getAttribute("aria-disabled") === "true",
              readOnly: Boolean(input?.readOnly ?? textarea?.readOnly),
              // A file input is almost always hidden behind a styled "Attach"
              // button (Lever, Greenhouse, Workday). Attaching works on the
              // hidden input, so it stays in the observation; without it the
              // run saw only the button and could never attach the resume.
              visible:
                (input?.type === "file" && !input.matches(":disabled")) ||
                (style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.opacity !== "0" &&
                  html.getClientRects().length > 0),
              value:
                input?.value ??
                textarea?.value ??
                select?.value ??
                html.textContent ??
                "",
              checked:
                input?.checked ??
                element.getAttribute("aria-checked") === "true",
              multiple: select?.multiple ?? false,
              options: select
                ? Array.from(select.options)
                    .filter(
                      (option) =>
                        !option.disabled &&
                        !(
                          option.parentElement instanceof HTMLOptGroupElement &&
                          option.parentElement.disabled
                        ) &&
                        !(select.required && option.value === ""),
                    )
                    .map((option) => option.label.trim())
                    .filter(Boolean)
                : [],
              selectedOptionLabel:
                select?.selectedOptions.item(0)?.label.trim() ??
                element.getAttribute("aria-valuetext")?.trim() ??
                "",
            };
          });
        }, `f${frameIndex}`),
      frame.locator(APPLY_ACTION_SELECTOR).evaluateAll(
        (elements, prefix): RawApplyAction[] =>
          elements.map((element, index) => {
            const html = element as HTMLElement;
            const input = element instanceof HTMLInputElement ? element : null;
            const button =
              element instanceof HTMLButtonElement ? element : null;
            const actionElement = input ?? button;
            const form = actionElement?.form ?? null;
            const style = window.getComputedStyle(html);
            return {
              ref: `${prefix}a${index}`,
              index,
              label:
                element.getAttribute("aria-label")?.trim() ||
                input?.value.trim() ||
                html.innerText.trim(),
              visible:
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                style.opacity !== "0" &&
                html.getClientRects().length > 0,
              disabled:
                Boolean(input?.disabled ?? button?.disabled) ||
                element.getAttribute("aria-disabled") === "true",
              ...(form
                ? {
                    formAction: new URL(
                      (actionElement?.hasAttribute("formaction")
                        ? actionElement.formAction
                        : form.action) || window.location.href,
                      window.location.href,
                    ).toString(),
                    formMethod: (
                      (actionElement?.hasAttribute("formmethod")
                        ? actionElement.formMethod
                        : form.method) || "GET"
                    ).toUpperCase(),
                  }
                : {}),
            };
          }),
        `f${frameIndex}`,
      ),
      frame.locator(APPLY_LINK_SELECTOR).evaluateAll(
        (elements, prefix): RawApplyLink[] =>
          elements.slice(0, 400).map((element, index) => {
            const html = element as HTMLElement;
            const anchor =
              element instanceof HTMLAnchorElement ? element : null;
            const style = window.getComputedStyle(html);
            const rect = html.getBoundingClientRect();
            return {
              ref: `${prefix}l${index}`,
              index,
              label:
                element.getAttribute("aria-label")?.trim() ||
                html.innerText.trim() ||
                element.getAttribute("title")?.trim() ||
                "",
              href: anchor?.href || element.getAttribute("href") || "",
              target: anchor?.target.trim() ?? "",
              visible:
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                style.opacity !== "0" &&
                html.getClientRects().length > 0,
              topOffset: Math.round(rect.top + window.scrollY),
            };
          }),
        `f${frameIndex}`,
      ),
      frame.locator(APPLY_CLICKABLE_SELECTOR).evaluateAll(
        (elements, prefix): RawApplyClickable[] =>
          elements.slice(0, 300).flatMap((element, index) => {
            const html = element as HTMLElement;
            const style = window.getComputedStyle(html);
            const label = (
              element.getAttribute("aria-label")?.trim() ||
              html.innerText.trim() ||
              element.getAttribute("title")?.trim() ||
              ""
            ).slice(0, 300);
            if (!label) return [];
            return [
              {
                ref: `${prefix}e${index}`,
                index,
                label,
                role: element.getAttribute("role")?.toLowerCase() ?? "",
                tagName: element.tagName.toLowerCase(),
                visible:
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.opacity !== "0" &&
                  html.getClientRects().length > 0,
                topOffset: 0,
              },
            ];
          }),
        `f${frameIndex}`,
      ),
      frame
        .locator("h1, h2, h3, [role='heading']")
        .evaluateAll((elements): RawApplyHeading[] =>
          elements.slice(0, 60).flatMap((element) => {
            const text = (element as HTMLElement).innerText
              .trim()
              .slice(0, 300);
            if (!text) return [];
            const explicit = element.getAttribute("aria-level");
            const fromTag = /^H([1-6])$/u.exec(element.tagName)?.[1];
            return [
              {
                level: Number.parseInt(explicit ?? fromTag ?? "2", 10) || 2,
                text,
              },
            ];
          }),
        ),
      frame
        .locator("body")
        .innerText({ timeout: 3_000 })
        .catch(() => ""),
      frame
        .locator("[role='alert'], [aria-live='assertive']")
        .evaluateAll((elements) =>
          elements
            .map((element) => (element as HTMLElement).innerText.trim())
            .filter((text) => text.length > 0 && text.length < 300)
            .slice(0, 12),
        )
        .catch(() => [] as string[]),
    ]);
    return {
      controls,
      actions,
      links,
      clickables,
      headings,
      bodyText: bodyText.slice(0, 8_000),
      validationErrors,
    };
  } catch {
    return null;
  }
}

/** Reads present progress markers without waiting for an optional element. */
export async function readApplyStepLabel(
  page: Pick<Page, "locator">,
): Promise<string | null> {
  return page
    .locator(
      "[aria-current='step'], [role='progressbar'], [aria-label*='step' i]",
    )
    .evaluateAll((elements) => {
      const current = elements.find((element) =>
        element.matches("[aria-current='step']"),
      );
      const container = current?.closest("[role='list'], ol, ul");
      if (current && container) {
        const steps = Array.from(container.children).filter(
          (candidate) =>
            candidate.matches("li, [role='listitem']") &&
            (candidate.textContent ?? "").trim().length > 0,
        );
        const index = steps.findIndex(
          (candidate) => candidate === current || candidate.contains(current),
        );
        if (index >= 0 && steps.length >= 2) {
          const label = (current as HTMLElement).innerText.trim().slice(0, 120);
          return `Step ${index + 1} of ${steps.length}${label ? `: ${label}` : ""}`;
        }
      }
      const progress = elements.find((element) =>
        element.matches("[role='progressbar'], [aria-label*='step' i]"),
      );
      return progress
        ? (progress as HTMLElement).innerText.trim().slice(0, 200)
        : null;
    })
    .catch(() => null);
}

export const APPLY_PAGE_SELECTORS = {
  controls: APPLY_CONTROL_SELECTOR,
  actions: APPLY_ACTION_SELECTOR,
  links: APPLY_LINK_SELECTOR,
  validationErrors: "[role='alert'], [aria-live='assertive']",
  headings: "h1, h2, h3, [role='heading']",
  clickables: APPLY_CLICKABLE_SELECTOR,
};

/** Pure DOM snapshot, also usable after the person detaches the automation connection. */
export function collectApplyDocumentSnapshot(
  elements: Element[],
  selectors: typeof APPLY_PAGE_SELECTORS,
  redactCredentials = false,
) {
  const matching = (selector: string) =>
    elements.filter((element) => element.matches(selector));
  const safe = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  const controls = ((elements: Element[]): RawApplyControl[] => {
    const labelText = (element: Element | null): string => {
      if (!element) return "";
      const clone = element.cloneNode(true) as Element;
      clone
        .querySelectorAll(
          "input, textarea, select, [role='option'], [role='listbox']",
        )
        .forEach((control) => control.remove());
      return (clone.textContent ?? "").replace(/\s+/gu, " ").trim();
    };
    const isVisible = (element: HTMLElement): boolean => {
      if (element.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        element.getClientRects().length > 0
      );
    };
    const referencedText = (element: Element): string =>
      (element.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/u)
        .filter(Boolean)
        .map((id) => labelText(document.getElementById(id)))
        .join(" ")
        .trim();
    const directLabel = (element: Element): string => {
      const aria = element.getAttribute("aria-label")?.trim();
      if (aria) return aria;
      const referenced = referencedText(element);
      if (referenced) return referenced;
      const labelled = element as HTMLInputElement;
      const labels =
        "labels" in labelled && labelled.labels
          ? Array.from(labelled.labels)
          : [];
      const text = labels
        .map((label) => labelText(label))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
      const enclosing = labelText(element.closest("label"));
      if (enclosing) return enclosing;
      let ancestor = element.parentElement;
      for (let depth = 0; ancestor && depth < 5; depth += 1) {
        const clone = ancestor.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            "input, textarea, select, button, [role='option'], [role='listbox']",
          )
          .forEach((candidate) => candidate.remove());
        const nearby = (clone.textContent ?? "").replace(/\s+/gu, " ").trim();
        if (nearby.length > 0 && nearby.length <= 500) return nearby;
        ancestor = ancestor.parentElement;
      }
      return "";
    };
    const groupLabel = (element: Element): string => {
      const legends: string[] = [];
      let fieldset = element.closest("fieldset");
      while (fieldset) {
        const legend = labelText(fieldset.querySelector(":scope > legend"));
        if (legend && !legends.includes(legend)) legends.unshift(legend);
        fieldset = fieldset.parentElement?.closest("fieldset") ?? null;
      }
      if (legends.length > 0) return legends.join(" — ");
      const group = element.closest("[role='group'], [role='radiogroup']");
      return group
        ? group.getAttribute("aria-label")?.trim() || referencedText(group)
        : "";
    };
    const customOptions = (element: HTMLElement): string[] => {
      // Only a list this control says is its own. Reaching into the
      // nearest listbox in the DOM is how a phone number field ended up
      // carrying the 200 countries belonging to the picker beside it,
      // and then refusing the number as "not one of the choices".
      const owned =
        element.getAttribute("aria-controls") ??
        element.getAttribute("aria-owns");
      const listbox = owned ? document.getElementById(owned) : null;
      if (!listbox) return [];
      return Array.from(listbox.querySelectorAll("[role='option']"))
        .map((option) => option.textContent?.trim() ?? "")
        .filter(Boolean)
        .slice(0, 200);
    };

    const roots = Array.from(
      new Set(elements.map((element) => element.getRootNode())),
    );
    const scopeKeyFor = (element: Element): string => {
      const root = element.getRootNode();
      const rootIndex = roots.indexOf(root);
      const form =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? element.form
          : null;
      const forms =
        root instanceof Document || root instanceof ShadowRoot
          ? Array.from(root.querySelectorAll("form"))
          : [];
      return `r${rootIndex}${form ? `form${forms.indexOf(form)}` : "root"}`;
    };

    return elements.map((element, index) => {
      const html = element as HTMLElement;
      const input = element instanceof HTMLInputElement ? element : null;
      const textarea = element instanceof HTMLTextAreaElement ? element : null;
      const select = element instanceof HTMLSelectElement ? element : null;
      const role = element.getAttribute("role")?.toLowerCase() ?? "";
      const tagName = select
        ? "select"
        : textarea
          ? "textarea"
          : input
            ? "input"
            : "contenteditable";
      return {
        index,
        tagName,
        inputType: input?.type.toLowerCase() ?? (role || tagName),
        accept: input?.accept ?? "",
        min: input?.min ?? "",
        max: input?.max ?? "",
        step: input?.step ?? "",
        maxLength: input?.maxLength ?? textarea?.maxLength ?? -1,
        role,
        id: html.id ?? "",
        name: input?.name ?? textarea?.name ?? select?.name ?? "",
        scopeKey: scopeKeyFor(element),
        label: directLabel(element),
        groupLabel: groupLabel(element),
        placeholder: input?.placeholder ?? textarea?.placeholder ?? "",
        autocomplete: input?.autocomplete ?? textarea?.autocomplete ?? "",
        required:
          Boolean(input?.required ?? textarea?.required ?? select?.required) ||
          element.getAttribute("aria-required") === "true",
        invalid:
          element.getAttribute("aria-invalid") === "true" ||
          Boolean(
            (input ?? textarea ?? select)?.validity &&
            !(input ?? textarea ?? select)?.validity.valid,
          ),
        validationMessage:
          input?.validationMessage ??
          textarea?.validationMessage ??
          select?.validationMessage ??
          "",
        disabled:
          Boolean(input?.disabled ?? textarea?.disabled ?? select?.disabled) ||
          element.matches(":disabled") ||
          element.getAttribute("aria-disabled") === "true",
        readOnly: Boolean(input?.readOnly ?? textarea?.readOnly),
        // A file input is almost always hidden behind a styled "Attach"
        // button (Lever, Greenhouse, Workday). Attaching works on the
        // hidden input, so it stays in the observation; without it the
        // run saw only the button and could never attach the resume.
        visible:
          (input?.type === "file" && !input.matches(":disabled")) ||
          isVisible(html),
        value:
          (redactCredentials &&
          (input?.type === "password" ||
            input?.autocomplete === "one-time-code" ||
            /(?:verification|authentication|one.time) code|\botp\b/iu.test(
              `${input?.name ?? ""} ${directLabel(element)}`,
            ))
            ? ""
            : input?.value) ??
          textarea?.value ??
          select?.value ??
          html.textContent ??
          "",
        checked:
          input?.checked ?? element.getAttribute("aria-checked") === "true",
        multiple: select?.multiple ?? false,
        options: select
          ? Array.from(select.options)
              .filter(
                (option) =>
                  !option.disabled &&
                  !(
                    option.parentElement instanceof HTMLOptGroupElement &&
                    option.parentElement.disabled
                  ) &&
                  !(select.required && option.value === ""),
              )
              .map((option) => option.label.trim())
              .filter(Boolean)
          : customOptions(html),
        selectedOptionLabel:
          select?.selectedOptions.item(0)?.label.trim() ??
          element.getAttribute("aria-valuetext")?.trim() ??
          "",
      };
    });
  })(matching(selectors.controls));
  const actions = ((elements: Element[]): RawApplyAction[] =>
    elements.map((element, index) => {
      const html = element as HTMLElement;
      const input = element instanceof HTMLInputElement ? element : null;
      const button = element instanceof HTMLButtonElement ? element : null;
      const actionElement = input ?? button;
      const form = actionElement?.form ?? null;
      const style = window.getComputedStyle(html);
      return {
        index,
        label:
          element.getAttribute("aria-label")?.trim() ||
          input?.value.trim() ||
          html.innerText.trim(),
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          html.getClientRects().length > 0,
        disabled:
          Boolean(input?.disabled ?? button?.disabled) ||
          element.getAttribute("aria-disabled") === "true",
        ...(form
          ? {
              formAction: new URL(
                (actionElement?.hasAttribute("formaction")
                  ? actionElement.formAction
                  : form.action) || window.location.href,
                window.location.href,
              ).toString(),
              formMethod: (
                (actionElement?.hasAttribute("formmethod")
                  ? actionElement.formMethod
                  : form.method) || "GET"
              ).toUpperCase(),
            }
          : {}),
      };
    }))(matching(selectors.actions));
  const links = safe(
    () =>
      ((elements: Element[]): RawApplyLink[] =>
        elements.map((element, index) => {
          const html = element as HTMLElement;
          const anchor = element instanceof HTMLAnchorElement ? element : null;
          const style = window.getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          return {
            index,
            label:
              element.getAttribute("aria-label")?.trim() ||
              html.innerText.trim() ||
              element.getAttribute("title")?.trim() ||
              "",
            // `href` on the element is already resolved against the page for
            // a web address, and left as written for anything else.
            href: anchor?.href || element.getAttribute("href") || "",
            target: anchor?.target.trim() ?? "",
            visible:
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0" &&
              html.getClientRects().length > 0,
            topOffset: Math.round(rect.top + window.scrollY),
          };
        }))(matching(selectors.links)),
    [],
  );
  const validationErrors = safe(
    () =>
      ((elements: Element[]) =>
        elements
          .filter(
            (element) =>
              element.getClientRects().length > 0 &&
              window.getComputedStyle(element).visibility !== "hidden",
          )
          .map((element) => (element as HTMLElement).innerText.trim())
          .filter((text) => text.length > 0 && text.length < 300)
          .slice(0, 12))(matching(selectors.validationErrors)),
    [],
  );
  const headings = safe(
    () =>
      ((elements: Element[]): RawApplyHeading[] =>
        elements.slice(0, 60).flatMap((element) => {
          const html = element as HTMLElement;
          const text = html.innerText.trim().slice(0, 300);
          if (!text) return [];
          const explicit = element.getAttribute("aria-level");
          const fromTag = /^H([1-6])$/u.exec(element.tagName)?.[1];
          return [
            {
              level: Number.parseInt(explicit ?? fromTag ?? "2", 10) || 2,
              text,
            },
          ];
        }))(matching(selectors.headings)),
    [],
  );
  const clickables = safe(
    () =>
      ((elements: Element[]): RawApplyClickable[] =>
        elements.slice(0, 300).flatMap((element, index) => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          const label = (
            element.getAttribute("aria-label")?.trim() ||
            html.innerText.trim() ||
            element.getAttribute("title")?.trim() ||
            ""
          ).slice(0, 300);
          if (!label) return [];
          return [
            {
              index,
              label,
              role: element.getAttribute("role")?.toLowerCase() ?? "",
              tagName: element.tagName.toLowerCase(),
              visible:
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                style.opacity !== "0" &&
                html.getClientRects().length > 0,
              topOffset: Math.round(rect.top + window.scrollY),
            },
          ];
        }))(matching(selectors.clickables)),
    [],
  );
  return {
    controls,
    actions,
    links,
    validationErrors,
    headings,
    clickables,
    url: window.location.href,
    title: document.title,
    bodyText: document.body?.innerText.slice(0, 20_000) ?? "",
    loading: document.readyState !== "complete",
  };
}

async function readRawApplyPageOnce(page: Page): Promise<RawApplyPage> {
  // One DOM snapshot, preserving selector order and shadow-root access.
  const [snapshot, stepLabel, openedTabs] = await Promise.all([
    page
      .locator(Object.values(APPLY_PAGE_SELECTORS).join(", "))
      .evaluateAll(collectApplyDocumentSnapshot, APPLY_PAGE_SELECTORS),
    readApplyStepLabel(page),
    readOpenedTabs(page),
  ]);
  const { controls } = snapshot;

  // A list the page draws itself does not report its own selection, so it is
  // read separately before anything decides the control is empty.
  // One pass over the page for every list it draws itself, rather than one
  // round trip each: a form with a dozen of them is read after every single
  // field is filled in, and those round trips are the person's time.
  const customIndexes = controls
    .filter(
      (control) =>
        control.tagName !== "select" &&
        (control.role === "combobox" || control.inputType === "combobox"),
    )
    .map((control) => control.index);
  const customStates =
    customIndexes.length > 0
      ? await readCustomComboboxStates(page, customIndexes)
      : new Map<
          number,
          { selectedOptionLabel: string; compositeVisible: boolean }
        >();
  const enrichedControls = controls.map((control) => {
    const custom = customStates.get(control.index);
    if (!custom) {
      return control;
    }
    const selectedOptionLabel =
      custom.selectedOptionLabel || control.selectedOptionLabel;
    return {
      ...control,
      selectedOptionLabel,
      visible:
        control.visible ||
        (custom.compositeVisible && selectedOptionLabel.trim().length > 0),
    };
  });

  // A list the page builds itself renders its choices only while it is open.
  // Closed, the question reaches the person as a bare text box with nothing to
  // pick from, which is no question at all. Opening it is a read: it asks the
  // page to show what it already offers and writes nothing.
  const controlsWithChoices = await readClosedComboboxOptions(
    page,
    enrichedControls,
  );

  return {
    ...snapshot,
    controls: controlsWithChoices,
    openedTabs,
    stepLabel,
  };
}

/**
 * Tabs the page opened for itself.
 *
 * A site that opens its application in a new tab has not blocked anything; it
 * has just moved the work. Reporting the tab lets the model go there.
 */
async function readOpenedTabs(page: Page): Promise<RawApplyOpenedTab[]> {
  try {
    const others = await listTaskOwnedPopups(page);
    return await Promise.all(
      others.slice(0, 8).map(async (candidate, index) => ({
        index,
        url: candidate.url(),
        title: await candidate.title().catch(() => ""),
      })),
    );
  } catch {
    return [];
  }
}

/**
 * Only tabs opened by this task's page belong to this task.
 *
 * Browser contexts may be shared by several bounded jobs. Enumerating every
 * page in the context lets one job adopt or close another job's live form.
 * Following the opener chain keeps direct popups and their descendants while
 * leaving unrelated task tabs untouched.
 */
async function listTaskOwnedPopups(root: Page): Promise<Page[]> {
  const candidates = root
    .context()
    .pages()
    .filter((candidate) => candidate !== root && !candidate.isClosed());
  const owned: Page[] = [];

  for (const candidate of candidates) {
    let current: Page | null = candidate;
    const seen = new Set<Page>();
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      const opener: Page | null = await current.opener().catch(() => null);
      if (opener === root) {
        owned.push(candidate);
        break;
      }
      current = opener;
    }
  }

  return owned;
}

/** How many closed lists one page read is willing to open. */
const MAX_OPENED_COMBOBOXES = 16;

/**
 * The choices already read out of one page's lists.
 *
 * Opening a list costs the better part of a second, and a form is read again
 * after every single field is filled in. Reading the same ten lists on every
 * one of those reads was minutes of a person's run spent learning nothing new:
 * the choices a list offers do not change while the form is being filled in.
 * Keyed by the page and by what the control says about itself, so a renumbered
 * control still finds its own choices and a new page starts fresh.
 */
const comboboxOptionMemo = new WeakMap<Page, Map<string, string[]>>();

/**
 * What makes one list that list, on this page and on the next read.
 *
 * Its own words and the kind of field it is — never where it sits in the DOM,
 * and never a listbox id the page mints afresh each time it opens. Position is
 * how the country list ended up answering a yes/no question.
 */
function comboboxMemoKey(url: string, control: RawApplyControl): string {
  const words = `${control.groupLabel} ${control.label}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  return `${url}|${words}|${control.tagName}|${control.inputType}|${control.role}`;
}

/**
 * Fills in the choices of every list that only renders them while open.
 *
 * Bounded on both axes: a few lists per read, a moment each. Anything that
 * will not open is left as it was rather than holding up the read.
 */
async function readClosedComboboxOptions(
  page: Page,
  controls: readonly RawApplyControl[],
): Promise<RawApplyControl[]> {
  const closed = controls.filter(
    (control) =>
      control.visible &&
      !control.disabled &&
      control.tagName !== "select" &&
      (control.role === "combobox" || control.inputType === "combobox") &&
      control.options.length === 0 &&
      // A list that already shows a choice has been answered; opening it
      // tells the person nothing and costs them a second of their run.
      control.selectedOptionLabel.trim().length === 0,
  );
  if (closed.length === 0) {
    return [...controls];
  }

  const url = page.url();
  let memo = comboboxOptionMemo.get(page);
  if (!memo) {
    memo = new Map<string, string[]>();
    comboboxOptionMemo.set(page, memo);
  }

  const optionsByIndex = new Map<number, string[]>();
  const toOpen: RawApplyControl[] = [];
  for (const control of closed) {
    const remembered = memo.get(comboboxMemoKey(url, control));
    if (remembered) {
      if (remembered.length > 0) {
        optionsByIndex.set(control.index, remembered);
      }
      continue;
    }
    toOpen.push(control);
  }

  for (const control of toOpen.slice(0, MAX_OPENED_COMBOBOXES)) {
    const locator = page.locator(APPLY_CONTROL_SELECTOR).nth(control.index);
    try {
      // Whatever the last list left open is closed first: a click that only
      // dismisses someone else's flyout reads as a list with no choices, and
      // the question then reaches the person as a bare text box.
      await page.keyboard.press("Escape").catch(() => undefined);
      await locator
        .scrollIntoViewIfNeeded({ timeout: 1_500 })
        .catch(() => undefined);
      // Focus and a down arrow, the way a person opens one of these with the
      // keyboard. A click depends on the window being the one in front, which
      // it is not when the browser is doing this beside the app; the keyboard
      // does not care. The click stays as the fallback.
      await locator.focus({ timeout: 1_500 }).catch(() => undefined);
      await locator
        .press("ArrowDown", { timeout: 1_500 })
        .catch(() => undefined);
      if ((await locator.getAttribute("aria-expanded")) !== "true") {
        await locator.click({ timeout: 1_500 });
      }
      // Only the list this control owns. Every open flyout on the page has
      // options in the DOM, and the nearest ones are not necessarily these.
      // Give the list the moment it needs to render its choices.
      await locator
        .evaluate(
          (element) =>
            new Promise<void>((resolve) => {
              const deadline = Date.now() + 600;
              const check = (): void => {
                if (
                  element.getAttribute("aria-expanded") === "true" ||
                  Date.now() > deadline
                ) {
                  resolve();
                  return;
                }
                setTimeout(check, 50);
              };
              check();
            }),
        )
        .catch(() => undefined);
      const options = await locator.evaluate((element) => {
        // Only the list this control opened, proved by the control saying it
        // is expanded and naming the list as its own. Falling back to the
        // nearest container is how one question ends up showing another
        // question's answers.
        if (element.getAttribute("aria-expanded") !== "true") {
          return [] as string[];
        }
        const owned =
          element.getAttribute("aria-controls") ??
          element.getAttribute("aria-owns");
        const listbox = owned ? document.getElementById(owned) : null;
        if (!listbox) return [] as string[];
        return Array.from(listbox.querySelectorAll("[role='option']"))
          .map((option) => (option as HTMLElement).innerText.trim())
          .filter((text) => text.length > 0)
          .slice(0, 200);
      });
      memo.set(comboboxMemoKey(url, control), options);
      if (options.length > 0) {
        optionsByIndex.set(control.index, options);
      }
    } catch {
      // Remembered as "nothing to offer" so the next read does not pay for
      // the same list again.
      memo.set(comboboxMemoKey(url, control), []);
      // A list that will not open tells us nothing; the question still goes
      // to the person, just without its choices.
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  return controls.map((control) => {
    const options = optionsByIndex.get(control.index);
    return options ? { ...control, options } : control;
  });
}

/**
 * What a list the page draws itself is currently showing.
 *
 * A native `select` reports its own selection; a widget built out of divs does
 * not, and reading `value` off it returns nothing useful. This reads the
 * rendered selection instead, including the country a flag stands for, so a
 * pre-filled phone-country or similar picker is not mistaken for empty. It is
 * a widget-shape reading, not a rule about any particular site.
 */
async function readCustomComboboxStates(
  page: Page,
  indexes: readonly number[],
): Promise<
  Map<number, { selectedOptionLabel: string; compositeVisible: boolean }>
> {
  const wanted = new Set(indexes);
  const states = await page
    .locator(APPLY_CONTROL_SELECTOR)
    .evaluateAll(
      (elements, selected: number[]) => {
        const want = new Set(selected);
        const readOne = (
          element: Element,
        ): { selectedOptionLabel: string; compositeVisible: boolean } => {
          const controlRoot =
            element.closest("[class*='__control']") ??
            element.closest("[class*='-control']") ??
            element.closest(".select-shell, [class*='select-shell']");
          const compositeVisible = Boolean(
            controlRoot &&
            controlRoot.getAttribute("aria-hidden") !== "true" &&
            controlRoot.getAttribute("hidden") === null &&
            controlRoot.getClientRects().length > 0,
          );
          const selectedValue = controlRoot?.querySelector<HTMLElement>(
            "[class*='__single-value'], [class*='-singleValue'], [class*='single-value'], [role='option'][aria-selected='true']",
          );
          if (!selectedValue) {
            return { selectedOptionLabel: "", compositeVisible };
          }

          const selectedText = selectedValue.textContent?.trim() ?? "";
          const regionCode = [
            selectedValue,
            ...Array.from(
              controlRoot?.querySelectorAll<HTMLElement>("[class*='iti__']") ??
                [],
            ),
            ...Array.from(
              selectedValue.querySelectorAll<HTMLElement>("[class]"),
            ),
          ]
            .flatMap((candidate) =>
              (candidate.getAttribute("class") ?? "").split(/\s+/u),
            )
            .map(
              (className) => /^iti__([a-z]{2})$/iu.exec(className)?.[1] ?? "",
            )
            .find(Boolean);
          if (!regionCode) {
            return { selectedOptionLabel: selectedText, compositeVisible };
          }

          let regionName = "";
          try {
            regionName =
              new Intl.DisplayNames(["en"], { type: "region" }).of(
                regionCode.toUpperCase(),
              ) ?? "";
          } catch {
            // A flag without a verified country name stays insufficient: several
            // countries share a calling code.
          }

          return {
            selectedOptionLabel: [regionName, selectedText]
              .filter(Boolean)
              .join(" ")
              .trim(),
            compositeVisible,
          };
        };

        return elements.map((element, index) =>
          want.has(index)
            ? ([index, readOne(element)] as const)
            : ([index, null] as const),
        );
      },
      [...wanted],
    )
    .catch(
      () =>
        [] as ReadonlyArray<
          readonly [
            number,
            { selectedOptionLabel: string; compositeVisible: boolean } | null,
          ]
        >,
    );

  const byIndex = new Map<
    number,
    { selectedOptionLabel: string; compositeVisible: boolean }
  >();
  for (const [index, state] of states) {
    if (state) {
      byIndex.set(index, state);
    }
  }
  return byIndex;
}

function locatorRootForRef(
  page: Page,
  ref: string,
  kind: "c" | "a" | "l" | "e",
): { root: Page | Frame; index: number } | null {
  const top = new RegExp(`^${kind}(\\d+)$`, "u").exec(ref);
  if (top?.[1]) {
    return { root: page, index: Number.parseInt(top[1], 10) };
  }
  const framed = new RegExp(`^f(\\d+)${kind}(\\d+)$`, "u").exec(ref);
  if (!framed?.[1] || !framed[2]) {
    return null;
  }
  const frame = page
    .frames()
    .filter((candidate) => candidate !== page.mainFrame())[
    Number.parseInt(framed[1], 10)
  ];
  return frame ? { root: frame, index: Number.parseInt(framed[2], 10) } : null;
}

function controlLocator(page: Page, ref: string): Locator | null {
  const target = locatorRootForRef(page, ref, "c");
  return target
    ? target.root.locator(APPLY_CONTROL_SELECTOR).nth(target.index)
    : null;
}

function actionLocator(page: Page, ref: string): Locator | null {
  const target = locatorRootForRef(page, ref, "a");
  return target
    ? target.root.locator(APPLY_ACTION_SELECTOR).nth(target.index)
    : null;
}

/** Arms a human-owned native form action without pressing it. */
export async function armPlaywrightApplicationFormAction(
  page: Page,
  ref: string,
): Promise<void> {
  const locator = actionLocator(page, ref);
  if (
    !locator ||
    (await locator.count()) !== 1 ||
    !(await locator.isVisible()) ||
    !(await locator.isEnabled())
  ) {
    throw new Error("The exact form action is no longer available.");
  }
  await openPrepareOnlyAuthorizedFormActionWindow(page, locator, null);
}

function linkLocator(page: Page, ref: string): Locator | null {
  const target = locatorRootForRef(page, ref, "l");
  return target
    ? target.root.locator(APPLY_LINK_SELECTOR).nth(target.index)
    : null;
}

function clickableLocator(page: Page, ref: string): Locator | null {
  const target = locatorRootForRef(page, ref, "e");
  return target
    ? target.root.locator(APPLY_CLICKABLE_SELECTOR).nth(target.index)
    : null;
}

function describeWriteFailure(error: unknown, fallback: string): string {
  return describeBrowserError(error, fallback);
}

/**
 * Presses one thing and lets whatever it started finish.
 *
 * A click that begins a navigation is the click working. Waiting a moment for
 * the new page means the read that follows sees where the click went rather
 * than the document it destroyed on the way.
 */
async function clickAndSettle(page: Page, locator: Locator): Promise<void> {
  await locator
    .scrollIntoViewIfNeeded({ timeout: 2_000 })
    .catch(() => undefined);
  try {
    await locator.click({ timeout: 10_000 });
  } catch (error) {
    // Something is drawn over it, or it sits under a sticky header. A person
    // would still get the click in; so does a click aimed straight at it.
    if (
      !/intercepts pointer events|outside of the viewport|not visible/iu.test(
        error instanceof Error ? error.message : "",
      )
    ) {
      throw error;
    }
    await locator.click({ timeout: 5_000, force: true });
  }
  await page
    .waitForLoadState("domcontentloaded", { timeout: 3_000 })
    .catch(() => undefined);
}

/** The live-page implementation of the apply mechanics. */
export function createPlaywrightApplyPageMechanics(
  page: Page,
): ApplyRawPageHands {
  return {
    readPage: () => readRawApplyPage(page),
    readLinkedText: () => readPageLinkedText(page),
    checkAction: async (ref): Promise<ApplyWriteResult> => {
      const locator = actionLocator(page, ref);
      if (!locator)
        return { ok: false, error: `No action named ${ref} on this page.` };
      try {
        return await locator.evaluate(
          (element): ApplyWriteResult => {
            if (
              !(element instanceof HTMLElement) ||
              element.matches(":disabled, [aria-disabled='true']")
            )
              return {
                ok: false,
                error: "The intended button is unavailable.",
              };
            element.scrollIntoView({
              block: "center",
              inline: "center",
              behavior: "instant",
            });
            const rect = element.getBoundingClientRect();
            const root = element.getRootNode();
            const hit = (
              root instanceof ShadowRoot ? root : document
            ).elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            if (
              rect.width > 0 &&
              rect.height > 0 &&
              hit &&
              (hit === element || element.contains(hit))
            )
              return {
                ok: true,
                observedValue: "The intended button is reachable.",
              };
            const covering =
              hit?.closest("[role='dialog'], [role='alertdialog'], aside") ??
              hit;
            const text = (covering?.textContent ?? "")
              .replace(/\s+/gu, " ")
              .trim()
              .slice(0, 300);
            return {
              ok: false,
              error: `The intended button is covered or outside the visible page.${text ? ` In front of it: ${text}` : ""}`,
            };
          },
          undefined,
          { timeout: 5_000 },
        );
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(
            error,
            "The intended button could not be checked.",
          ),
        };
      }
    },
    fillText: async (ref, value): Promise<ApplyWriteResult> => {
      const locator = controlLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `No control named ${ref} on this page.` };
      }
      try {
        await locator.fill(value, { timeout: 5_000 });
        // Check immediate acceptance here. The apply workflow checks retention
        // after 300 ms, sharing that window across a batch of typed answers.
        const observedValue = await locator.inputValue({ timeout: 2_000 });
        if (value.trim().length > 0 && observedValue.trim().length === 0) {
          return {
            ok: false,
            error:
              "The field cleared the answer instead of keeping it. Leave it for the person or try a different control once.",
          };
        }
        return {
          ok: true,
          observedValue,
        };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(
            error,
            "The field would not accept the answer.",
          ),
        };
      }
    },
    chooseOption: async (ref, optionLabel): Promise<ApplyWriteResult> => {
      const locator = controlLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `No control named ${ref} on this page.` };
      }
      try {
        await locator.selectOption({ label: optionLabel }, { timeout: 5_000 });
        return { ok: true, observedValue: optionLabel };
      } catch {
        // A list the page draws itself opens on click and is picked from the
        // options it renders; the same intent, a different mechanism.
        try {
          // Open it, type enough of the answer for the list to narrow to it,
          // then take the choice that says it. Typing first is what makes a
          // list of two hundred countries usable at all.
          await locator.click({ timeout: 5_000 });
          await locator
            .fill(optionLabel, { timeout: 2_000 })
            .catch(async () => {
              await locator.type(optionLabel, { timeout: 2_000 });
            });
          await page
            .getByRole("option", { name: optionLabel, exact: true })
            .first()
            .click({ timeout: 5_000 });
          return { ok: true, observedValue: optionLabel };
        } catch (error) {
          return {
            ok: false,
            error: describeWriteFailure(
              error,
              `The list did not offer "${optionLabel}".`,
            ),
          };
        }
      }
    },
    setToggle: async (ref, checked): Promise<ApplyWriteResult> => {
      const locator = controlLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `No control named ${ref} on this page.` };
      }
      try {
        // A covered native input used to spend five seconds failing the
        // pointer check before DOM activation. Detect that geometry up front;
        // reachable controls still use Playwright's normal pointer events.
        const activateNative = (coveredOnly: boolean) =>
          locator
            .evaluate(
              (element, input) => {
                if (
                  !(element instanceof HTMLInputElement) ||
                  (element.type !== "checkbox" && element.type !== "radio") ||
                  element.matches(":disabled")
                ) {
                  return false;
                }
                if (element.checked === input.checked) return true;
                if (input.coveredOnly) {
                  // setChecked scrolls for its pointer action. The hit test
                  // only needs current geometry, without a separate wait for
                  // animation-frame stability on a hidden page.
                  element.scrollIntoView({
                    block: "center",
                    inline: "center",
                    behavior: "instant",
                  });
                  const rect = element.getBoundingClientRect();
                  const root = element.getRootNode();
                  const hit = (
                    root instanceof ShadowRoot ? root : document
                  ).elementFromPoint(
                    rect.x + rect.width / 2,
                    rect.y + rect.height / 2,
                  );
                  if (hit === element || (hit && element.contains(hit)))
                    return false;
                }
                element.click();
                return element.checked === input.checked;
              },
              { checked, coveredOnly },
            )
            .catch(() => false);
        if (!(await activateNative(true))) {
          try {
            await locator.setChecked(checked, { timeout: 5_000 });
          } catch (actionabilityError) {
            // Preserve the fallback if the page changed after the hit test.
            if (!(await activateNative(false))) throw actionabilityError;
          }
        }
        return { ok: true, observedValue: checked ? "checked" : "unchecked" };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "The box would not change."),
        };
      }
    },
    uploadFile: async (
      ref,
      file: ApplyUploadFile,
    ): Promise<ApplyWriteResult> => {
      const locator = controlLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `No control named ${ref} on this page.` };
      }
      try {
        await locator.setInputFiles(
          {
            name: file.name,
            mimeType: file.mimeType,
            buffer: Buffer.from(file.bytes),
          },
          { timeout: 15_000 },
        );
        return { ok: true, observedValue: file.name };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "The file would not attach."),
        };
      }
    },
    clickAction: async (ref): Promise<ApplyWriteResult> => {
      const locator = actionLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `No button named ${ref} on this page.` };
      }
      try {
        await clickAndSettle(page, locator);
        return { ok: true, observedValue: "clicked" };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "The button would not respond."),
        };
      }
    },
    pressKey: async (ref, key): Promise<ApplyWriteResult> => {
      const locator = ref
        ? (controlLocator(page, ref) ??
          actionLocator(page, ref) ??
          linkLocator(page, ref) ??
          clickableLocator(page, ref))
        : null;
      try {
        if (ref && !locator) {
          return { ok: false, error: `No element named ${ref} on this page.` };
        }
        if (locator) {
          await locator.press(key, { timeout: 5_000 });
        } else {
          await page.keyboard.press(key);
        }
        await page
          .waitForLoadState("domcontentloaded", { timeout: 3_000 })
          .catch(() => undefined);
        return { ok: true, observedValue: key };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(
            error,
            `The ${key} key would not respond.`,
          ),
        };
      }
    },
    followLink: async (ref): Promise<ApplyNavigationResult> => {
      const locator = linkLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `No link named ${ref} on this page.` };
      }
      let href = "";
      try {
        href = await locator.evaluate(
          (element) =>
            (element as HTMLAnchorElement).href ||
            element.getAttribute("href") ||
            "",
          undefined,
          { timeout: 5_000 },
        );
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "That link is no longer here."),
        };
      }
      let target: URL;
      try {
        target = new URL(href, page.url());
      } catch {
        return { ok: false, error: "That link does not point at a page." };
      }
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        return {
          ok: false,
          error: "That link does not open a web page.",
        };
      }
      try {
        // Asking for the address the link already publishes, rather than
        // clicking it, keeps the hop a plain read: no popup, no script, and
        // nothing the page can turn into a write.
        await page.goto(target.toString(), {
          waitUntil: "domcontentloaded",
          // Short on purpose: a hop that does not answer quickly is a hop
          // that is costing the person their run.
          timeout: 15_000,
        });
        return { ok: true, url: page.url() };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "That page would not open."),
        };
      }
    },
    navigate: async (url): Promise<ApplyNavigationResult> => {
      let target: URL;
      try {
        target = new URL(url, page.url());
      } catch {
        return { ok: false, error: `${url} is not an address.` };
      }
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        return { ok: false, error: "That address is not a web page." };
      }
      if (page.isClosed()) {
        return {
          ok: false,
          error:
            "The prepared application page was closed. Prepare it again before continuing.",
        };
      }
      // A recovery prompt can tell the model to return to the exact retained
      // apply URL even though it is already there. Reloading that same page
      // erases the person's CAPTCHA, declaration, and other in-page work.
      if (new URL(page.url()).toString() === target.toString()) {
        return { ok: true, url: page.url() };
      }
      try {
        await page.goto(target.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        return { ok: true, url: page.url() };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "That page would not open."),
        };
      }
    },
    clickElement: async (ref): Promise<ApplyWriteResult> => {
      const locator =
        actionLocator(page, ref) ??
        linkLocator(page, ref) ??
        clickableLocator(page, ref) ??
        controlLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `There is nothing called ${ref} here.` };
      }
      try {
        const changesToggle = await locator.evaluate((element) => {
          const label = element.closest("label");
          const target = label?.control ?? element;
          return target.matches(
            "input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio']",
          );
        });
        if (changesToggle) {
          return {
            ok: false,
            error:
              "This click changes a checkbox or radio answer. Use set_checkbox with the control reference so its answer is checked first.",
          };
        }
        await clickAndSettle(page, locator);
        return { ok: true, observedValue: "clicked" };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "That would not respond."),
        };
      }
    },
    scroll: async (direction): Promise<ApplyWriteResult> => {
      try {
        await page.evaluate((where) => {
          const step = window.innerHeight * 0.85;
          if (where === "top") window.scrollTo({ top: 0 });
          else if (where === "bottom")
            window.scrollTo({ top: document.body.scrollHeight });
          else window.scrollBy({ top: where === "down" ? step : -step });
        }, direction);
        return { ok: true, observedValue: direction };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "The page would not scroll."),
        };
      }
    },
    wait: async (milliseconds) => {
      await page.waitForTimeout(Math.max(0, Math.min(10_000, milliseconds)));
    },
    goBack: async (): Promise<ApplyNavigationResult> => {
      try {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
        return { ok: true, url: page.url() };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "There is nothing to go back to."),
        };
      }
    },
    adoptOpenedTab: async (index): Promise<ApplyNavigationResult> => {
      const others = await listTaskOwnedPopups(page);
      const opened = others[index];
      if (!opened) {
        return { ok: false, error: "That tab is no longer open." };
      }
      await opened
        .waitForLoadState("domcontentloaded", { timeout: 5_000 })
        .catch(() => undefined);
      const url = opened.url();
      if (!/^https?:/iu.test(url)) {
        await opened.close().catch(() => undefined);
        return { ok: false, error: "That tab never loaded a web page." };
      }
      await opened.close().catch(() => undefined);
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        return { ok: true, url: page.url() };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "That page would not open here."),
        };
      }
    },
    readText: async (ref) => {
      if (!ref) {
        return page.locator("body").innerText({ timeout: 5_000 });
      }
      const locator =
        controlLocator(page, ref) ??
        actionLocator(page, ref) ??
        linkLocator(page, ref) ??
        clickableLocator(page, ref);
      if (!locator) {
        return "";
      }
      return locator.innerText({ timeout: 5_000 });
    },
  };
}

/**
 * One open application page and the safety mechanics that go with it.
 *
 * Everything the workflow layer is allowed to do to this page is here, and
 * nothing here decides anything.
 */
export function createPlaywrightApplyPageSession(input: {
  page: Page;
  sentinel?: ApplicationRunServiceWorkerSentinel;
}): ApplyPageSession {
  const { page } = input;
  const mechanics = createPlaywrightApplyPageMechanics(page);
  let intermediateWriteCount = 0;
  // Attempts already handed to the workflow layer. Each read hands out one
  // it has not seen, and the one that matters most first: the page trying to
  // open a tab or send the form is never hidden behind its own analytics.
  const handedOut = new Set<string>();
  const attemptWeight = (attempt: ApplyBlockedAttempt): number =>
    attempt.kind.includes("submit")
      ? 3
      : attempt.kind === "download"
        ? 2
        : attempt.kind === "popup_open" || attempt.kind === "window_open"
          ? 1
          : 0;

  return {
    ...mechanics,
    uploadFile: async (ref, file) => {
      const control = controlLocator(page, ref);
      if (
        control &&
        (await control.evaluate(
          (element) =>
            element instanceof HTMLInputElement && element.type === "file",
        ))
      )
        await openPrepareOnlyAttachmentUploadWindow(page, file);
      return mechanics.uploadFile(ref, file);
    },
    installPrepareOnlyGuard: async (guardInput) => {
      await ensurePrepareOnlyMutationGuard(
        page,
        guardInput.intermediateMutationsAuthorized,
        guardInput.allowedOrigins,
        guardInput.attachmentUploadsAuthorized === true,
      );
    },
    readBlockedAttempt: async (): Promise<ApplyBlockedAttempt | null> => {
      const unseen = (await getBlockedPrepareOnlyAttempts(page)).filter(
        (attempt) =>
          !handedOut.has(
            `${attempt.kind}|${attempt.method}|${attempt.url ?? ""}|${attempt.at}`,
          ),
      );
      if (unseen.length === 0) {
        return null;
      }
      const chosen = unseen.reduce((best, attempt) =>
        attemptWeight(attempt) > attemptWeight(best) ? attempt : best,
      );
      handedOut.add(
        `${chosen.kind}|${chosen.method}|${chosen.url ?? ""}|${chosen.at}`,
      );
      return chosen;
    },
    registerPreparedValue: (value) =>
      registerPrepareOnlyPreparedValue(page, value),
    openIntermediateWriteWindow: async () => {
      await openPrepareOnlyIntermediateMutationWindow(page);
      intermediateWriteCount += 1;
    },
    closeIntermediateWriteWindow: () =>
      closePrepareOnlyIntermediateMutationWindow(page),
    clickAuthorizedFormAction: async (ref) => {
      const locator = actionLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `No button named ${ref} on this page.` };
      }
      try {
        await openPrepareOnlyAuthorizedFormActionWindow(page, locator);
        await clickAndSettle(page, locator);
        await waitForPrepareOnlyAuthorizedFormAction(page);
        return { ok: true, observedValue: "clicked" };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(
            error,
            "The authorized form action would not respond.",
          ),
        };
      } finally {
        await closePrepareOnlyAuthorizedFormActionWindow(page);
      }
    },
    readIntermediateWriteCount: () => intermediateWriteCount,
    checkServiceWorker: async (): Promise<ApplyServiceWorkerFinding | null> => {
      const finding = await input.sentinel?.check("form_preparation");
      if (!finding) {
        return null;
      }
      return {
        reason: finding.reason,
        summary:
          "A background worker on this site can change the page while Job Finder is on it.",
        detail: finding.detail,
      };
    },
  };
}
