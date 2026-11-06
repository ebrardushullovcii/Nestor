import { APPLY_CONTROL_SELECTOR } from "@nestor/contracts";
import { readPressability } from "./element-state";
import { withBrowserReadLiveness } from "./browser-read-liveness";
import { withNavigationLiveness } from "./browser-navigation";
import { tracePageHands, tracePage } from "./trace-page";

import { watchPageSelfLimits } from "./self-limit-page";
import {
  trackAccountFlowEntry,
  readAccountFlowEntry,
} from "./account-flow-entry";
import { clickPreparedLoginAction } from "./application-login-action";
import { attachFile } from "./file-attachment";
import { createHash } from "node:crypto";
import { withAccountWindowSession } from "./account-window-session";
import { choosePageOption } from "./choose-page-option";
import { collectCustomComboboxStates } from "./custom-combobox-state";
import { replaceFieldText } from "./replace-field-text";
import type {
  ApplyBlockedAttempt,
  RawApplyClickable,
  RawApplyPlacement,
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
  RawApplyUpload,
  RawApplyLink,
  RawApplyPage,
} from "@nestor/contracts";
import { describeBrowserError, isPageReplacedError } from "@nestor/contracts";
import type { Frame, Locator, Page } from "playwright";
import { readPageLinkedText } from "./page-linked-text";
import { isVisibleFrame, readVisibleText } from "./visible-page-text";
import { readPageMessages } from "./page-messages";
import {
  readClosedShadowControls,
  clickClosedShadowControl,
  setClosedShadowToggle,
} from "./closed-shadow-controls";
import {
  controlSnapshot,
  controlRefFrame,
  boundControlLocator,
  hasBoundControlRefs,
} from "./page-control-refs";
export {
  installPageMessageRecorderInPage,
  PAGE_MESSAGE_CONSOLE_PREFIX,
  pageMessageReadsAsFailure,
} from "./page-messages";
import {
  rememberAttachedFile,
  watchAttachmentUploads,
  withAttachmentUploadOutcomes,
} from "./attachment-upload-ledger";

import {
  closePrepareOnlyAuthorizedFormActionWindow,
  closePrepareOnlyIntermediateMutationWindow,
  ensurePrepareOnlyMutationGuard,
  getBlockedPrepareOnlyAttempts,
  openPrepareOnlyAuthorizedFormActionWindow,
  openPrepareOnlyIntermediateMutationWindow,
  closePrepareOnlyAttachmentUploadWindow,
  allowPrepareOnlyRunNavigation,
  markPrepareOnlyPickerChoice,
  openPrepareOnlyAttachmentUploadWindow,
  registerPrepareOnlyPreparedValue,
  readPrepareOnlyIntermediateWriteCount,
  drainPrepareOnlyIntermediateWrites,
  type ApplicationRunServiceWorkerSentinel,
  waitForPrepareOnlyAuthorizedFormAction,
  hasPrepareOnlyPreparedValues,
  isClaimedAccountWindow,
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

export { APPLY_CONTROL_SELECTOR } from "@nestor/contracts";
export const APPLY_ACTION_SELECTOR =
  "button, input[type='submit'], input[type='button'], [role='button'], [role='tab']";

// A tab implemented as an anchor keeps its panel-navigation semantics and
// has one action handle, rather than a second ordinary-link handle.
export const APPLY_LINK_SELECTOR = "a[href]:not([role='tab'])";

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
 * Network activity keeps the existing idle clock alive.
 */
async function settlePage(page: Page): Promise<void> {
  await page
    .waitForLoadState("domcontentloaded", { timeout: 0 })
    .catch(() => undefined);
}

const mutationCounts = new WeakMap<Page, { count: number }>();

function mutationCounter(page: Page): { count: number } {
  let counter = mutationCounts.get(page);
  if (!counter) {
    counter = { count: 0 };
    mutationCounts.set(page, counter);
    const current = counter;
    page.on("request", (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
        current.count += 1;
    });
  }
  return counter;
}

async function collectRawApplyPage(page: Page): Promise<RawApplyPage> {
  watchPageSelfLimits(page);
  const counter = mutationCounter(page);
  const raw = await readRawApplyPageContent(page);
  const closed = await readClosedShadowControls(
    page,
    `${APPLY_CONTROL_SELECTOR}, ${APPLY_ACTION_SELECTOR}, ${APPLY_LINK_SELECTOR}, ${APPLY_CLICKABLE_SELECTOR}`,
  );
  raw.clickables.push(...closed.clickables);
  raw.validationErrors.push(...closed.validationErrors);
  if (closed.bodyText)
    raw.bodyText = [raw.bodyText, closed.bodyText].filter(Boolean).join("\n\n");
  // A dropzone's inner input often says only "Choose a file". Its actual
  // question lives outside the shadow root, beside the widget's host.
  for (const [index, frame] of page.frames().entries()) {
    const fields = raw.controls.filter(
      (control) =>
        control.inputType === "file" &&
        (controlRefFrame(page, control.ref) === frame ||
          (!hasBoundControlRefs(page) &&
            (index === 0
              ? !control.ref?.startsWith("f")
              : control.ref?.startsWith(`f${index - 1}c`)))),
    );
    if (!fields.length) continue;
    const labels = await frame
      .locator("input[type='file']")
      .evaluateAll(readFileFieldLabels)
      .catch(() => []);
    fields.forEach((control, ordinal) => {
      if (labels[ordinal]) control.label = labels[ordinal]!;
    });
  }
  return withPageMessages(page, {
    ...raw,
    networkMutationCount: counter.count,
  });
}

/** Self-contained for evaluation in each frame, including open shadow roots. */
function readFileFieldLabels(inputs: Element[]): string[] {
  const headings = (root: Element | ShadowRoot): Element[] => {
    const result = [
      ...root.querySelectorAll("h1,h2,h3,h4,legend,[role='heading']"),
    ];
    for (const node of root.querySelectorAll("*"))
      if (node.shadowRoot) result.push(...headings(node.shadowRoot));
    return result;
  };
  const parent = (node: Element): Element | null =>
    node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
  return inputs.map((input) => {
    const own =
      input.getAttribute("aria-label")?.trim() ||
      Array.from((input as HTMLInputElement).labels ?? [])
        .map((label) => label.textContent?.trim())
        .join(" ");
    if (
      own &&
      !/^(?:choose|select|attach|upload|drop)\b.*\b(?:file|document)\b/iu.test(
        own,
      )
    )
      return "";
    for (
      let node = parent(input), depth = 0;
      node && depth < 12;
      node = parent(node), depth++
    ) {
      if (node.matches("form,body,main")) break;
      if (
        Array.from(node.querySelectorAll("input,textarea,select")).some(
          (other) => other !== input && !other.matches("input[type='hidden']"),
        )
      )
        break;
      const names = headings(node)
        .filter((heading) => heading.getClientRects().length > 0)
        .map(
          (heading) => heading.textContent?.replace(/\s+/gu, " ").trim() ?? "",
        )
        .filter((name) => name.length > 0 && name.length < 120);
      if (names.length === 1) return names[0]!;
    }
    return "";
  });
}

/** Adds what the page said through its own alert, confirm or prompt. */
async function withPageMessages(
  page: Page,
  raw: RawApplyPage,
): Promise<RawApplyPage> {
  const pageMessages = await readPageMessages(page);
  return pageMessages.length ? { ...raw, pageMessages } : raw;
}

async function readRawApplyPageContent(page: Page): Promise<RawApplyPage> {
  watchAttachmentUploads(page);
  await settlePage(page);
  try {
    return withAttachmentUploadOutcomes(
      page,
      await includeChildFrameContent(page, await readRawApplyPageOnce(page)),
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
  await settlePage(page);
  try {
    return withAttachmentUploadOutcomes(
      page,
      await includeChildFrameContent(page, await readRawApplyPageOnce(page)),
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
    frames.map((frame, index) => readApplyFrame(frame, index)),
  );
  const readable = snapshots.filter(
    (snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null,
  );
  if (readable.length === 0) return root;

  return {
    ...root,
    bodyText: [root.bodyText, ...readable.map((item) => item.bodyText)]
      .filter(Boolean)
      .join("\n\n"),
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
    ],
    ...(root.summaryRows?.length ||
    readable.some((item) => item.summaryRows.length)
      ? {
          summaryRows: [
            ...(root.summaryRows ?? []),
            ...readable.flatMap((item) => item.summaryRows),
          ],
        }
      : {}),
  };
}

async function readApplyFrame(frame: Frame, frameIndex: number) {
  try {
    if (!(await isVisibleFrame(frame))) return null;
    const owner = () => {
      try {
        const url = new URL(frame.url());
        return url.origin === "null" || url.username || url.password
          ? { origin: "null", pathname: "" }
          : { origin: url.origin, pathname: url.pathname };
      } catch {
        return { origin: "null", pathname: "" };
      }
    };
    const frameOwner = owner();
    const snapshot = {
      locator: (selector: string, kind: "c" | "a" | "l" | "e") =>
        controlSnapshot(frame, frame.locator(selector), { [kind]: selector }),
    };
    const [
      controls,
      unplacedActions,
      links,
      unplacedClickables,
      headings,
      bodyText,
      validationErrors,
      actionPlacements,
      clickablePlacements,
      summaryRows,
    ] = await Promise.all([
      snapshot
        .locator(APPLY_CONTROL_SELECTOR, "c")
        .evaluateAll((elements, prefix): RawApplyControl[] => {
          const labelText = (element: Element | null): string => {
            if (!element) return "";
            const clone = element.cloneNode(true) as Element;
            clone
              .querySelectorAll(
                "input, textarea, select, svg, script, style, noscript, template, [role='option'], [role='listbox']",
              )
              .forEach((control) => control.remove());
            return (clone.textContent ?? "").replace(/\s+/gu, " ").trim();
          };
          const hintFor = (element: Element, label: string): string => {
            // Help text beside the field, such as "Please provide your GitHub
            // username": what the field's own block says besides its label.
            const described = (element.getAttribute("aria-describedby") ?? "")
              .split(/\s+/u)
              .filter(Boolean)
              .map((id) => labelText(document.getElementById(id)))
              .join(" ")
              .trim();
            let block: Element | null = null;
            for (
              let ancestor = element.parentElement, depth = 0;
              ancestor && depth < 4;
              ancestor = ancestor.parentElement, depth += 1
            ) {
              if (
                ancestor.querySelectorAll(
                  "input:not([type='hidden']), textarea, select, [role='combobox'], [role='checkbox'], [role='radio'], [contenteditable='true']",
                ).length > 1
              )
                break;
              block = ancestor;
            }
            const staticBlock = block?.cloneNode(true) as Element | undefined;
            // Live feedback is page state, not the field's wording. It stays
            // in the page text so new instructions there are still observed.
            staticBlock
              ?.querySelectorAll("[role='status'], [aria-live]")
              .forEach((node) => node.remove());
            const hint =
              described ||
              labelText(staticBlock ?? null)
                .replace(label, "")
                .replace(/\s+/gu, " ")
                .trim();

            return hint;
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
                : element.closest("form");
            const forms =
              root instanceof Document || root instanceof ShadowRoot
                ? Array.from(root.querySelectorAll("form"))
                : [];
            return `${prefix}r${rootIndex}${
              form ? `form${forms.indexOf(form)}` : "root"
            }`;
          };
          const phoneCallingCodeFor = (
            element: Element,
          ): string | undefined => {
            if (
              !(element instanceof HTMLInputElement) ||
              element.type !== "tel"
            )
              return undefined;
            const box = element.parentElement;
            if (
              !box ||
              box.querySelectorAll(
                "input:not([type='hidden']),textarea,select,[role='combobox']",
              ).length !== 1
            )
              return undefined;
            const buttons = Array.from(
              box.querySelectorAll(
                "button[aria-haspopup='dialog'][aria-expanded='false'][aria-controls]",
              ),
            );
            if (buttons.length !== 1) return undefined;
            const button = buttons[0];
            if (
              !(button instanceof HTMLButtonElement) ||
              button.disabled ||
              button.getAttribute("aria-disabled") === "true" ||
              button.getAttribute("aria-invalid") === "true" ||
              button.form !== element.form ||
              !button.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              }) ||
              button.closest('[aria-hidden="true"]')
            )
              return undefined;
            const root = element.getRootNode();
            const owned = button.getAttribute("aria-controls");
            const dialog =
              (root instanceof Document || root instanceof ShadowRoot) && owned
                ? root.getElementById(owned)
                : null;
            if (
              !dialog ||
              !box.contains(dialog) ||
              dialog.getAttribute("role") !== "dialog" ||
              !dialog.querySelector("[role='listbox']") ||
              dialog.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              })
            )
              return undefined;
            const shown = [
              ...button.innerText.matchAll(/\+[1-9]\d{0,2}(?!\d)/gu),
            ];
            const named = [
              ...(button.getAttribute("aria-label") ?? "").matchAll(
                /\+[1-9]\d{0,2}(?!\d)/gu,
              ),
            ];
            return shown.length === 1 &&
              named.length === 1 &&
              shown[0]?.[0] === named[0]?.[0]
              ? shown[0]?.[0]
              : undefined;
          };
          // What a file input's own field shows about its upload: the site's
          // message for it, the chip with the chosen name, or the browser's
          // own widget. Help text further away is never read as a failure.
          const readUpload = (input: HTMLInputElement): RawApplyUpload => {
            const rendered = (node: Element | null): node is HTMLElement =>
              node instanceof HTMLElement && node.getClientRects().length > 0;
            const described = ["aria-describedby", "aria-errormessage"]
              .flatMap((name) => (input.getAttribute(name) ?? "").split(/\s+/u))
              .filter(Boolean)
              .map((id) => document.getElementById(id))
              .filter(rendered)
              .map((node) => node.innerText.trim())
              .filter(Boolean)
              .join("\n");
            let box: HTMLElement | null = null;
            for (
              let node = input.parentElement, depth = 0;
              node && depth < 6;
              node = node.parentElement, depth += 1
            ) {
              if (node.matches("form, body")) break;
              const other = Array.from(
                node.querySelectorAll("input, textarea, select"),
              ).some(
                (field) =>
                  field !== input &&
                  !(
                    field instanceof HTMLInputElement && field.type === "hidden"
                  ),
              );
              if (other) break;
              box = node;
            }
            const style = window.getComputedStyle(input);
            const rect = input.getBoundingClientRect();
            return {
              described: described,
              ariaInvalid: input.getAttribute("aria-invalid") === "true",
              nearby: (box?.innerText ?? "")
                .replace(/[ \t]+/gu, " ")
                .replace(/\s*\n\s*/gu, "\n")
                .trim(),
              shown:
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity) > 0.1 &&
                rect.width >= 40 &&
                rect.height >= 10,
              ...(input.files?.[0]
                ? {
                    fileName: input.files[0].name,
                    fileSize: input.files[0].size,
                  }
                : {}),
              // HTML form submission sends a named file input's file.
              ...(input.name &&
              input.form?.getAttribute("method")?.toLowerCase() === "post" &&
              input.form.enctype === "multipart/form-data"
                ? {
                    formSubmits: true,
                    formAction: new URL(
                      input.form.getAttribute("action") || window.location.href,
                      document.baseURI,
                    ).href,
                  }
                : {}),
            };
          };
          // A question's title can say it is required when its control doesn't
          // (Ashby marks the title with a "required" class and leaves its pickers
          // bare): the nearest box with a title and no other field.
          const titledRequired = (element: Element): boolean => {
            for (
              let box = element.parentElement, depth = 0;
              box && box !== document.body && depth < 4;
              box = box.parentElement, depth += 1
            ) {
              const title = box.querySelector(
                "label, legend, [class*='question-title' i]",
              );
              if (!title) continue;
              const alone = Array.from(
                box.querySelectorAll(
                  "input:not([type='hidden']), select, textarea",
                ),
              ).every((field) => field === element);
              return (
                alone &&
                (/\*\s*$/u.test(title.textContent ?? "") ||
                  box.querySelector(
                    "[aria-required='true'], label[class*='required' i], [class*='question-title'][class*='required' i]",
                  ) !== null)
              );
            }
            return false;
          };
          // The words a person sees in an element: no icons, nothing hidden from
          // assistive technology, no scripts or styles.
          const shownText = (element: HTMLElement): string => {
            const clone = element.cloneNode(true) as HTMLElement;
            for (const hidden of clone.querySelectorAll(
              "svg, [aria-hidden='true'], script, style, noscript, template",
            ))
              hidden.remove();
            return (clone.textContent ?? "").replace(/\s+/gu, " ").trim();
          };
          // A text box that is a calendar's (a date picker): its class or its
          // picker's says date, or it asks for a date. It takes a date, read as
          // one, never words like "Immediately". (An open calendar beside a field
          // is also left out of the field's question, above and below.)
          const datePicker = (element: Element): boolean =>
            element instanceof HTMLInputElement &&
            element.type === "text" &&
            (/(?:^|[\s_-])date(?:picker)?(?:$|[\s_-])|datepicker/iu.test(
              element.className,
            ) ||
              Boolean(
                element.closest(
                  "[class*='datepicker' i], [class*='date-picker' i]",
                ),
              ) ||
              /pick (?:a )?date|select (?:a )?date|\b(?:dd|mm)\s*[/.-]\s*(?:dd|mm)\s*[/.-]\s*(?:yy)?yy\b/iu.test(
                element.placeholder,
              ));
          return elements.map((element, index) => {
            const html = element as HTMLElement;
            const input = element instanceof HTMLInputElement ? element : null;
            const phoneCallingCode = phoneCallingCodeFor(element);
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
                    "input, textarea, select, button, svg, [role='option'], [role='listbox'], [role='grid'], [role='dialog'], [class*='popper' i], [class*='calendar' i], [class*='datepicker__' i]",
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
              inputType: datePicker(element)
                ? "date"
                : (input?.type.toLowerCase() ?? (role || tagName)),
              accept: input?.accept ?? "",
              min: input?.min ?? "",
              max: input?.max ?? "",
              step: input?.step ?? "",
              maxLength: input?.maxLength ?? textarea?.maxLength ?? -1,
              role,
              id: html.id,
              name: input?.name ?? textarea?.name ?? select?.name ?? "",
              scopeKey: scopeKeyFor(element),
              ...((input?.form ?? textarea?.form ?? select?.form)
                ? {
                    formIndex: Array.from(document.forms).indexOf(
                      (input?.form ?? textarea?.form ?? select?.form)!,
                    ),
                  }
                : {}),
              ...(phoneCallingCode ? { phoneCallingCode } : {}),
              label,
              hint: hintFor(element, label),
              groupLabel: legend ?? "",
              placeholder: input?.placeholder ?? textarea?.placeholder ?? "",
              autocomplete: input?.autocomplete ?? textarea?.autocomplete ?? "",
              required:
                Boolean(
                  input?.required ?? textarea?.required ?? select?.required,
                ) ||
                element.getAttribute("aria-required") === "true" ||
                titledRequired(element),
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
                // A custom checkbox or radio answers with its state; its
                // text is its option at most, never an icon's fallback
                // ("SVGs not supported by this browser.").
                (role === "checkbox" || role === "radio"
                  ? shownText(html)
                  : shownText(html)) ??
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
              ...(input?.type === "file" ? { upload: readUpload(input) } : {}),
            };
          });
        }, `f${frameIndex}`),
      snapshot.locator(APPLY_ACTION_SELECTOR, "a").evaluateAll(
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
              role: element.getAttribute("role")?.toLowerCase() ?? "",
              ...(element.hasAttribute("aria-pressed")
                ? { pressed: element.getAttribute("aria-pressed") === "true" }
                : {}),
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
                        : form.getAttribute("action")) || window.location.href,
                      document.baseURI,
                    ).toString(),
                    formMethod: (
                      (actionElement?.hasAttribute("formmethod")
                        ? actionElement.formMethod
                        : form.getAttribute("method")) || "GET"
                    ).toUpperCase(),
                    submitsForm:
                      button?.type === "submit" ||
                      input?.type === "submit" ||
                      input?.type === "image",
                  }
                : {}),
            };
          }),
        `f${frameIndex}`,
      ),
      snapshot
        .locator(APPLY_LINK_SELECTOR, "l")
        .evaluateAll((elements, prefix): RawApplyLink[] => {
          return elements.map((element, index) => {
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
          });
        }, `f${frameIndex}`),
      snapshot.locator(APPLY_CLICKABLE_SELECTOR, "e").evaluateAll(
        (elements, [prefix, owned]): RawApplyClickable[] => {
          return elements.flatMap((element, index) => {
            // A button already has its own ref, with its form's action:
            // neither it nor anything inside it (a label span, an icon),
            // across shadow roots, is a second name to press it under.
            for (
              let node: Element | null = element;
              node;
              node =
                node.parentElement ??
                ((node.getRootNode() as ShadowRoot).host || null)
            )
              if (node.matches(owned)) return [];
            const html = element as HTMLElement;
            const style = window.getComputedStyle(html);
            const label =
              element.getAttribute("aria-label")?.trim() ||
              html.innerText.trim() ||
              element.getAttribute("title")?.trim() ||
              "";
            if (!label) return [];
            return [
              {
                ref: `${prefix}e${index}`,
                index,
                label,
                role: element.getAttribute("role")?.toLowerCase() ?? "",
                tagName: element.tagName.toLowerCase(),
                disabled:
                  (element instanceof HTMLButtonElement && element.disabled) ||
                  element.getAttribute("aria-disabled") === "true",
                visible:
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.opacity !== "0" &&
                  html.getClientRects().length > 0,
                topOffset: 0,
              },
            ];
          });
        },
        [`f${frameIndex}`, APPLY_ACTION_SELECTOR] as const,
      ),
      frame
        .locator("h1, h2, h3, [role='heading']")
        .evaluateAll((elements): RawApplyHeading[] => {
          return elements.flatMap((element) => {
            const text = (element as HTMLElement).innerText.trim();
            if (!text) return [];
            const explicit = element.getAttribute("aria-level");
            const fromTag = /^H([1-6])$/u.exec(element.tagName)?.[1];
            return [
              {
                level: Number.parseInt(explicit ?? fromTag ?? "2", 10) || 2,
                text,
              },
            ];
          });
        }),
      readVisibleText(frame.locator("body")).catch(() => ""),
      frame
        .locator("[role='alert'], [aria-live='assertive']")
        .evaluateAll((elements) => {
          return elements
            .map((element) => (element as HTMLElement).innerText.trim())
            .filter((text) => text.length > 0);
        })
        .catch(() => [] as string[]),
      // Where each sits is extra: a frame that will not say still reads.
      frame
        .locator(APPLY_ACTION_SELECTOR)
        .evaluateAll(readApplyPlacements)
        .catch(() => [] as RawApplyPlacement[]),
      frame
        .locator(APPLY_CLICKABLE_SELECTOR)
        .evaluateAll(readApplyPlacements)
        .catch(() => [] as RawApplyPlacement[]),
      frame
        .locator("dl")
        .evaluateAll(readApplySummaryRows)
        .catch(() => [] as { label: string; value: string }[]),
    ]);
    const currentOwner = owner();
    if (
      currentOwner.origin !== frameOwner.origin ||
      currentOwner.pathname !== frameOwner.pathname
    )
      return null;
    const actions = unplacedActions.map((action) => ({
      ...action,
      frame: frameOwner,
      ...actionPlacements[action.index],
    }));
    const clickables = unplacedClickables.map((clickable) => ({
      ...clickable,
      frame: frameOwner,
      ...clickablePlacements[clickable.index],
    }));
    return {
      controls: controls.map((control) => ({ ...control, frame: frameOwner })),
      actions,
      links: links.map((link) => ({ ...link, frame: frameOwner })),
      clickables,
      headings,
      bodyText,
      validationErrors,
      summaryRows: summaryRows.map((row) => ({ ...row, frame: frameOwner })),
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
          const label = (current as HTMLElement).innerText.trim();
          return `Step ${index + 1} of ${steps.length}${label ? `: ${label}` : ""}`;
        }
      }
      const progress = elements.find((element) =>
        element.matches("[role='progressbar'], [aria-label*='step' i]"),
      );
      return progress ? (progress as HTMLElement).innerText.trim() : null;
    })
    .catch(() => null);
}

/**
 * Visible description-list rows: each `dt` with exactly one following `dd`
 * (also inside the `div` groups HTML allows). Generic page mechanics only;
 * nothing here interprets a row. Self-contained: Playwright serializes it.
 */
export function readApplySummaryRows(
  elements: Element[],
): { label: string; value: string }[] {
  const shown = (element: Element) => {
    const style = getComputedStyle(element);
    return (
      element.getClientRects().length > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const text = (element: Element) =>
    ((element as HTMLElement).innerText ?? element.textContent ?? "")
      .replace(/\s+/gu, " ")
      .trim();
  const rows: { label: string; value: string }[] = [];
  for (const list of elements) {
    if (!shown(list)) continue;
    const children = Array.from(list.children).flatMap((child) =>
      child.tagName === "DIV" ? Array.from(child.children) : [child],
    );
    for (let index = 0; index < children.length; index++) {
      const term = children[index]!;
      if (term.tagName !== "DT") continue;
      const values: Element[] = [];
      for (
        let next = index + 1;
        next < children.length && children[next]!.tagName !== "DT";
        next++
      )
        if (children[next]!.tagName === "DD") values.push(children[next]!);
      const [value] = values;
      if (values.length !== 1 || !value || !shown(term) || !shown(value))
        continue;
      const label = text(term);
      if (!label) continue;
      rows.push({
        label,
        value: text(value),
      });
    }
  }
  return rows;
}

export const APPLY_PAGE_SELECTORS = {
  controls: APPLY_CONTROL_SELECTOR,
  actions: APPLY_ACTION_SELECTOR,
  links: APPLY_LINK_SELECTOR,
  validationErrors: "[role='alert'], [aria-live='assertive']",
  headings: "h1, h2, h3, [role='heading']",
  clickables: APPLY_CLICKABLE_SELECTOR,
};

/**
 * Where each element sits: the part of the page holding it and whether that
 * part is a form. Self-contained: Playwright serializes it into each frame.
 * `collectApplyDocumentSnapshot` keeps the same reading for the top page.
 */
export function readApplyPlacements(elements: Element[]): RawApplyPlacement[] {
  return elements.map((element) => {
    const words = (node: Element | null | undefined): string =>
      (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
    const legends: string[] = [];
    for (
      let set = element.closest("fieldset");
      set;
      set = set.parentElement?.closest("fieldset") ?? null
    ) {
      const legend = words(set.querySelector(":scope > legend"));
      if (legend && !legends.includes(legend)) legends.unshift(legend);
    }
    let section = legends.join(" — ");
    let sectionBox: Element | null = section
      ? element.closest("fieldset")
      : null;
    if (!section) {
      const part = element.closest(
        "dialog, [role='dialog'], [role='alertdialog'], [role='region'], [role='group'], section, aside, form",
      );
      section = part
        ? part.getAttribute("aria-label")?.trim() ||
          words(
            document.getElementById(
              part.getAttribute("aria-labelledby")?.split(/\s+/u)[0] ?? "",
            ),
          ) ||
          words(part.querySelector("h1, h2, h3, h4, legend"))
        : "";
      if (section) sectionBox = part;
    }
    // The words beside it: the nearest box whose own text, without its
    // buttons and fields, says something short.
    for (
      let box = element.parentElement, depth = 0;
      !section && box && box !== document.body && depth < 5;
      box = box.parentElement, depth += 1
    ) {
      const clone = box.cloneNode(true) as Element;
      clone
        .querySelectorAll(
          "button, a, input, select, textarea, svg, [role='button']",
        )
        .forEach((node) => node.remove());
      const nearby = words(clone);
      if (nearby.length > 300) break;
      section = nearby;
      if (section) sectionBox = box;
    }
    // A field's menu may live inside several custom-element shadow roots.
    // Follow their hosts as well as DOM parents; do not treat the body as a
    // field group just because some other part of the page has an input.
    const parent = (node: Element): Element | null =>
      node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
    const hasFields = (root: Element | ShadowRoot): boolean =>
      Boolean(
        root.querySelector(
          "input:not([type='hidden']):not([type='button']):not([type='submit']), select, textarea",
        ),
      ) ||
      Array.from(root.querySelectorAll("*")).some(
        (node) => node.shadowRoot && hasFields(node.shadowRoot),
      );
    let inForm = Boolean(
      element.closest("form, fieldset, [role='form'], [role='group']"),
    );
    for (
      let box = parent(element), depth = 0;
      !inForm && box && box !== document.body && depth < 12;
      box = parent(box), depth += 1
    )
      inForm = Boolean(
        box.matches("form, fieldset, [role='form'], [role='group']") ||
        hasFields(box),
      );
    // A toggle button answers the question around it; whether that question
    // is required is said by its label (a "required" class, as Ashby's
    // title has, aria-required, or a trailing *).
    const sectionRequired =
      element.hasAttribute("aria-pressed") && sectionBox
        ? /\*\s*$/u.test(section) ||
          Boolean(
            sectionBox.querySelector(
              "[aria-required='true'], label[class*='required' i], [class*='question-title'][class*='required' i]",
            ),
          )
        : false;
    const owner =
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement
        ? element.form
        : element.closest("form");
    return {
      ...(owner && Array.from(document.forms).includes(owner)
        ? { formIndex: Array.from(document.forms).indexOf(owner) }
        : {}),
      section: section,
      inForm,
      ...(sectionRequired ? { sectionRequired } : {}),
    };
  });
}

export { personSubmissionObserverSource } from "./person-submission-observer";

/** Pure DOM snapshot, also usable after the person detaches the automation connection. */
export function collectApplyDocumentSnapshot(
  elements: Element[],
  selectors: typeof APPLY_PAGE_SELECTORS,
  redactCredentials = false,
) {
  const matching = (selector: string) =>
    elements.filter((element) => element.matches(selector));
  const fieldVisibility = (element: Element) => {
    const rect = element.getBoundingClientRect();
    let ariaHidden = false,
      cssHidden = false;
    for (
      let node: Element | null = element;
      node;
      node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host
    ) {
      const style = getComputedStyle(node);
      ariaHidden ||= node.getAttribute("aria-hidden") === "true";
      cssHidden ||=
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0";
    }
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      inViewport:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight,
      offCanvas:
        rect.right <= 0 ||
        rect.bottom <= 0 ||
        rect.left + scrollX >=
          Math.max(innerWidth, document.documentElement.scrollWidth) ||
        rect.top + scrollY >=
          Math.max(innerHeight, document.documentElement.scrollHeight),
      zeroSize: rect.width === 0 || rect.height === 0,
      ariaHidden,
      cssHidden,
    };
  };
  const fieldDescriptions = matching(selectors.controls).flatMap((control) => {
    const root = control.getRootNode();
    // Live picker guidance can be aria-describedby too. Its text still stays
    // in the control's hint; only labels and explicit errors protect body text.
    const ids = ["aria-labelledby", "aria-errormessage"]
      .flatMap((attribute) =>
        (control.getAttribute(attribute) ?? "").split(/\s+/u),
      )
      .filter(Boolean);
    return [
      ...(control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
        ? Array.from(control.labels ?? [])
        : []),
      ...ids.flatMap((id) => {
        const label =
          root instanceof Document || root instanceof ShadowRoot
            ? root.getElementById(id)
            : null;
        return label ? [label] : [];
      }),
    ];
  });
  const hiddenPickerAnnouncement = (node: HTMLElement): boolean => {
    const region = node.closest('[role="status"], [aria-live="polite"]');
    if (
      !region ||
      region.matches(selectors.controls) ||
      region.querySelector(selectors.controls) ||
      region.closest('[role="alert"], [aria-live="assertive"]') ||
      region.querySelector(
        '[role="alert"], [aria-live="assertive"], [aria-invalid="true"], input, select, textarea',
      ) ||
      fieldDescriptions.some(
        (description) =>
          description.contains(region) || region.contains(description),
      )
    )
      return false;
    const text = region.textContent ?? "";
    // Positive picker-navigation evidence only. Unknown live prose stays;
    // an error mixed with a picker announcement stays too.
    if (
      !/\b(?:\d+ (?:results?|options?) (?:are )?available|option .{1,100} selected|select is focused|use (?:up|down) and (?:up|down)|press (?:up|down|enter|escape))\b/iu.test(
        text,
      ) ||
      /\b(?:error|invalid|fail(?:ed|ure)?|missing|required|cannot|unable|denied|captcha|robot|must|try again)\b|\bplease (?:enter|choose|select|provide)\b/iu.test(
        text,
      )
    )
      return false;
    const navigationWords = new Set(
      "option options result results available selected select selection focused focus is are was currently current you your have has been a an the for of in on at by with can to and or use up down left right arrow arrows key keys enter escape esc tab space backspace home end press open close menu list choose choices type typing search term refine input value values edit clear remove exit move navigate item items".split(
        " ",
      ),
    );
    for (const control of matching(selectors.controls))
      for (const value of [
        control.getAttribute("placeholder"),
        "value" in control && typeof control.value === "string"
          ? control.value
          : "",
      ])
        for (const word of value?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
          navigationWords.add(word);
    const announcement = text
      .replace(
        /\boption\s+[^.!?]{1,160}?\s*,?\s*(?:selected|focused)\b/giu,
        "option selected",
      )
      .replace(
        /(?:^|[.!?])\s*[^.!?]{1,160},\s*(?:selected|focused)\b/giu,
        ". selected",
      );
    if (
      (announcement.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).some(
        (word) => !/^\d+$/u.test(word) && !navigationWords.has(word),
      )
    )
      return false;
    for (
      let box: Element | null = region;
      box && box !== document.body;
      box = box.parentElement
    ) {
      const style = getComputedStyle(box);
      const rect = box.getBoundingClientRect();
      const clip = style.clip
        .match(/^rect\(([^)]+)\)$/u)?.[1]
        ?.split(/[,\s]+/u)
        .map(Number.parseFloat);
      const emptyClip =
        clip?.length === 4 &&
        clip.every(Number.isFinite) &&
        (clip[2]! <= clip[0]! || clip[1]! <= clip[3]!);
      const tiny =
        rect.width <= 1 &&
        rect.height <= 1 &&
        [style.overflow, style.overflowX, style.overflowY].includes("hidden");
      if (
        emptyClip ||
        tiny ||
        /^(?:inset\((?:50|100)%|circle\(0(?:px)?)/u.test(style.clipPath)
      )
        return true;
    }
    return false;
  };
  const renderedText = (root: ParentNode): string => {
    const parts: string[] = [];
    const rootStyle = root instanceof Element ? getComputedStyle(root) : null;
    if (
      rootStyle &&
      (rootStyle.display === "none" ||
        rootStyle.contentVisibility === "hidden" ||
        Number(rootStyle.opacity || "1") === 0)
    )
      return "";
    const assigned =
      root instanceof HTMLSlotElement
        ? root.assignedNodes({ flatten: true })
        : [];
    for (const node of assigned.length ? assigned : root.childNodes) {
      if (node instanceof Text) {
        if (
          !rootStyle ||
          !["hidden", "collapse"].includes(rootStyle.visibility)
        )
          parts.push(node.textContent ?? "");
        continue;
      }
      if (
        !(node instanceof HTMLElement) ||
        ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)
      )
        continue;
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.contentVisibility === "hidden" ||
        Number(style.opacity || "1") === 0 ||
        (style.display !== "contents" && !node.getClientRects().length)
      )
        continue;
      if (hiddenPickerAnnouncement(node)) continue;
      const block = !["inline", "inline-block", "contents"].includes(
        style.display,
      );
      if (block) parts.push("\n");
      parts.push(renderedText(node.shadowRoot ?? node));
      if (block) parts.push("\n");
    }
    return parts.join(" ");
  };
  // When the page's send was last pressed while sends were let through.
  const sendPressed = (): {
    sendPressedAt?: string;
    sendConfirmationBefore?: string[];
    sendOrigin?: string;
  } => {
    const send = (
      window as unknown as Record<
        string,
        | {
            sendPressedAt?: number;
            sendConfirmationBefore?: string[];
            sendOrigin?: string;
          }
        | undefined
      >
    )["__nestorPrepareOnlyMutationGuardV1"];
    return typeof send?.sendPressedAt === "number"
      ? {
          sendPressedAt: new Date(send.sendPressedAt).toISOString(),
          ...(send.sendConfirmationBefore
            ? { sendConfirmationBefore: send.sendConfirmationBefore }
            : {}),
          ...(send.sendOrigin ? { sendOrigin: send.sendOrigin } : {}),
        }
      : {};
  };
  const safe = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  // The same reading as `readApplyPlacements`; this function is serialized
  // on its own and cannot call it.
  const placement = (element: Element): RawApplyPlacement => {
    const words = (node: Element | null | undefined): string =>
      (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
    const legends: string[] = [];
    for (
      let set = element.closest("fieldset");
      set;
      set = set.parentElement?.closest("fieldset") ?? null
    ) {
      const legend = words(set.querySelector(":scope > legend"));
      if (legend && !legends.includes(legend)) legends.unshift(legend);
    }
    let section = legends.join(" — ");
    let sectionBox: Element | null = section
      ? element.closest("fieldset")
      : null;
    if (!section) {
      const part = element.closest(
        "dialog, [role='dialog'], [role='alertdialog'], [role='region'], [role='group'], section, aside, form",
      );
      section = part
        ? part.getAttribute("aria-label")?.trim() ||
          words(
            document.getElementById(
              part.getAttribute("aria-labelledby")?.split(/\s+/u)[0] ?? "",
            ),
          ) ||
          words(part.querySelector("h1, h2, h3, h4, legend"))
        : "";
      if (section) sectionBox = part;
    }
    // The words beside it: the nearest box whose own text, without its
    // buttons and fields, says something short.
    for (
      let box = element.parentElement, depth = 0;
      !section && box && box !== document.body && depth < 5;
      box = box.parentElement, depth += 1
    ) {
      const clone = box.cloneNode(true) as Element;
      clone
        .querySelectorAll(
          "button, a, input, select, textarea, svg, [role='button']",
        )
        .forEach((node) => node.remove());
      const nearby = words(clone);
      if (nearby.length > 300) break;
      section = nearby;
      if (section) sectionBox = box;
    }
    const parent = (node: Element): Element | null =>
      node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null;
    const hasFields = (root: Element | ShadowRoot): boolean =>
      Boolean(
        root.querySelector(
          "input:not([type='hidden']):not([type='button']):not([type='submit']), select, textarea",
        ),
      ) ||
      Array.from(root.querySelectorAll("*")).some(
        (node) => node.shadowRoot && hasFields(node.shadowRoot),
      );
    let inForm = Boolean(
      element.closest("form, fieldset, [role='form'], [role='group']"),
    );
    for (
      let box = parent(element), depth = 0;
      !inForm && box && box !== document.body && depth < 12;
      box = parent(box), depth += 1
    )
      inForm = Boolean(
        box.matches("form, fieldset, [role='form'], [role='group']") ||
        hasFields(box),
      );
    // A toggle button answers the question around it; whether that question
    // is required is said by its label (a "required" class, as Ashby's
    // title has, aria-required, or a trailing *).
    const sectionRequired =
      element.hasAttribute("aria-pressed") && sectionBox
        ? /\*\s*$/u.test(section) ||
          Boolean(
            sectionBox.querySelector(
              "[aria-required='true'], label[class*='required' i], [class*='question-title'][class*='required' i]",
            ),
          )
        : false;
    return {
      section: section,
      inForm,
      ...(sectionRequired ? { sectionRequired } : {}),
    };
  };
  const controls = ((elements: Element[]): RawApplyControl[] => {
    const labelText = (element: Element | null): string => {
      if (!element) return "";
      const clone = element.cloneNode(true) as Element;
      clone
        .querySelectorAll(
          "input, textarea, select, svg, script, style, noscript, template, [role='option'], [role='listbox']",
        )
        .forEach((control) => control.remove());
      return (clone.textContent ?? "").replace(/\s+/gu, " ").trim();
    };
    const hintFor = (element: Element, label: string): string => {
      // Help text beside the field, such as "Please provide your GitHub
      // username": what the field's own block says besides its label.
      const described = (element.getAttribute("aria-describedby") ?? "")
        .split(/\s+/u)
        .filter(Boolean)
        .map((id) => labelText(document.getElementById(id)))
        .join(" ")
        .trim();
      let block: Element | null = null;
      for (
        let ancestor = element.parentElement, depth = 0;
        ancestor && depth < 4;
        ancestor = ancestor.parentElement, depth += 1
      ) {
        if (
          ancestor.querySelectorAll(
            "input:not([type='hidden']), textarea, select, [role='combobox'], [role='checkbox'], [role='radio'], [contenteditable='true']",
          ).length > 1
        )
          break;
        block = ancestor;
      }
      const staticBlock = block?.cloneNode(true) as Element | undefined;
      // Keep live feedback in page text, separate from the question's hint.
      staticBlock
        ?.querySelectorAll("[role='status'], [aria-live]")
        .forEach((node) => node.remove());
      const hint =
        described ||
        labelText(staticBlock ?? null)
          .replace(label, "")
          .replace(/\s+/gu, " ")
          .trim();

      return hint;
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
            "input, textarea, select, button, svg, [role='option'], [role='listbox'], [role='grid'], [role='dialog'], [class*='popper' i], [class*='calendar' i], [class*='datepicker__' i]",
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
    const sectionPath = (element: Element): string[] => {
      const names: string[] = [];
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        // Structural landmarks are page facts, including unnamed ones.
        // Consumers can distinguish footer/navigation/search controls from
        // the fields in the main document without guessing from their labels.
        const landmark = parent.matches(
          "footer, nav, [role='contentinfo'], [role='navigation'], [role='search']",
        )
          ? parent.getAttribute("role") || parent.tagName.toLowerCase()
          : null;
        if (landmark && !names.includes(landmark)) names.unshift(landmark);
        const name = parent.matches("fieldset")
          ? labelText(parent.querySelector(":scope > legend"))
          : parent.matches(
                "section, form, [role='group'], [role='radiogroup'], [role='region']",
              )
            ? parent.getAttribute("aria-label")?.trim() ||
              referencedText(parent) ||
              labelText(
                parent.querySelector(":scope > h1, :scope > h2, :scope > h3"),
              )
            : "";
        if (name && !names.includes(name)) names.unshift(name);
      }
      return names;
    };
    const customOptions = (element: HTMLElement): string[] => {
      if (element.getAttribute("aria-expanded") === "false") return [];
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
        .filter(Boolean);
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
          : element.closest("form");
      const forms =
        root instanceof Document || root instanceof ShadowRoot
          ? Array.from(root.querySelectorAll("form"))
          : [];
      return `r${rootIndex}${form ? `form${forms.indexOf(form)}` : "root"}`;
    };
    const rowScopeKeyFor = (element: Element): string | undefined => {
      const root = element.getRootNode();
      const row = element.closest("fieldset, [role='group'], section");
      if (!row || !(root instanceof Document || root instanceof ShadowRoot))
        return undefined;
      return `${scopeKeyFor(element)}:group:${Array.from(root.querySelectorAll("fieldset, [role='group'], section")).indexOf(row)}`;
    };
    const phoneCallingCodeFor = (element: Element): string | undefined => {
      if (!(element instanceof HTMLInputElement) || element.type !== "tel")
        return undefined;
      const box = element.parentElement;
      if (
        !box ||
        box.querySelectorAll(
          "input:not([type='hidden']),textarea,select,[role='combobox']",
        ).length !== 1
      )
        return undefined;
      const buttons = Array.from(
        box.querySelectorAll(
          "button[aria-haspopup='dialog'][aria-expanded='false'][aria-controls]",
        ),
      );
      if (buttons.length !== 1) return undefined;
      const button = buttons[0];
      if (
        !(button instanceof HTMLButtonElement) ||
        button.disabled ||
        button.getAttribute("aria-disabled") === "true" ||
        button.getAttribute("aria-invalid") === "true" ||
        button.form !== element.form ||
        !button.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        }) ||
        button.closest('[aria-hidden="true"]')
      )
        return undefined;
      const root = element.getRootNode();
      const owned = button.getAttribute("aria-controls");
      const dialog =
        (root instanceof Document || root instanceof ShadowRoot) && owned
          ? root.getElementById(owned)
          : null;
      if (
        !dialog ||
        !box.contains(dialog) ||
        dialog.getAttribute("role") !== "dialog" ||
        !dialog.querySelector("[role='listbox']") ||
        dialog.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        return undefined;
      const shown = [...button.innerText.matchAll(/\+[1-9]\d{0,2}(?!\d)/gu)];
      const named = [
        ...(button.getAttribute("aria-label") ?? "").matchAll(
          /\+[1-9]\d{0,2}(?!\d)/gu,
        ),
      ];
      return shown.length === 1 &&
        named.length === 1 &&
        shown[0]?.[0] === named[0]?.[0]
        ? shown[0]?.[0]
        : undefined;
    };

    // What a file input's own field shows about its upload: the site's
    // message for it, the chip with the chosen name, or the browser's
    // own widget. Help text further away is never read as a failure.
    const readUpload = (input: HTMLInputElement): RawApplyUpload => {
      const rendered = (node: Element | null): node is HTMLElement =>
        node instanceof HTMLElement && node.getClientRects().length > 0;
      const described = ["aria-describedby", "aria-errormessage"]
        .flatMap((name) => (input.getAttribute(name) ?? "").split(/\s+/u))
        .filter(Boolean)
        .map((id) => document.getElementById(id))
        .filter(rendered)
        .map((node) => node.innerText.trim())
        .filter(Boolean)
        .join("\n");
      let box: HTMLElement | null = null;
      for (
        let node = input.parentElement, depth = 0;
        node && depth < 6;
        node = node.parentElement, depth += 1
      ) {
        if (node.matches("form, body")) break;
        const other = Array.from(
          node.querySelectorAll("input, textarea, select"),
        ).some(
          (field) =>
            field !== input &&
            !(field instanceof HTMLInputElement && field.type === "hidden"),
        );
        if (other) break;
        box = node;
      }
      const style = window.getComputedStyle(input);
      const rect = input.getBoundingClientRect();
      return {
        described: described,
        ariaInvalid: input.getAttribute("aria-invalid") === "true",
        nearby: (box?.innerText ?? "")
          .replace(/[ \t]+/gu, " ")
          .replace(/\s*\n\s*/gu, "\n")
          .trim(),
        shown:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0.1 &&
          rect.width >= 40 &&
          rect.height >= 10,
        ...(input.files?.[0]
          ? { fileName: input.files[0].name, fileSize: input.files[0].size }
          : {}),
        // HTML form submission sends a named file input's file.
        ...(input.name &&
        input.form?.getAttribute("method")?.toLowerCase() === "post" &&
        input.form.enctype === "multipart/form-data"
          ? {
              formSubmits: true,
              formAction: new URL(
                input.form.getAttribute("action") || window.location.href,
                document.baseURI,
              ).href,
            }
          : {}),
      };
    };
    // A question's title can say it is required when its control doesn't
    // (Ashby marks the title with a "required" class and leaves its pickers
    // bare): the nearest box with a title and no other field.
    const titledRequired = (element: Element): boolean => {
      for (
        let box = element.parentElement, depth = 0;
        box && box !== document.body && depth < 4;
        box = box.parentElement, depth += 1
      ) {
        const title = box.querySelector(
          "label, legend, [class*='question-title' i]",
        );
        if (!title) continue;
        const alone = Array.from(
          box.querySelectorAll("input:not([type='hidden']), select, textarea"),
        ).every((field) => field === element);
        return (
          alone &&
          (/\*\s*$/u.test(title.textContent ?? "") ||
            box.querySelector(
              "[aria-required='true'], label[class*='required' i], [class*='question-title'][class*='required' i]",
            ) !== null)
        );
      }
      return false;
    };
    // The words a person sees in an element: no icons, nothing hidden from
    // assistive technology, no scripts or styles.
    const shownText = (element: HTMLElement): string => {
      const clone = element.cloneNode(true) as HTMLElement;
      for (const hidden of clone.querySelectorAll(
        "svg, [aria-hidden='true'], script, style, noscript, template",
      ))
        hidden.remove();
      return (clone.textContent ?? "").replace(/\s+/gu, " ").trim();
    };
    // A text box that is a calendar's (a date picker): its class or its
    // picker's says date, or it asks for a date. It takes a date, read as
    // one, never words like "Immediately". (An open calendar beside a field
    // is also left out of the field's question, above and below.)
    const datePicker = (element: Element): boolean =>
      element instanceof HTMLInputElement &&
      element.type === "text" &&
      (/(?:^|[\s_-])date(?:picker)?(?:$|[\s_-])|datepicker/iu.test(
        element.className,
      ) ||
        Boolean(
          element.closest("[class*='datepicker' i], [class*='date-picker' i]"),
        ) ||
        /pick (?:a )?date|select (?:a )?date|\b(?:dd|mm)\s*[/.-]\s*(?:dd|mm)\s*[/.-]\s*(?:yy)?yy\b/iu.test(
          element.placeholder,
        ));
    return elements.map((element, index) => {
      const html = element as HTMLElement;
      const input = element instanceof HTMLInputElement ? element : null;
      const phoneCallingCode = phoneCallingCodeFor(element);
      const rowScopeKey = rowScopeKeyFor(element);
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
        visibility: fieldVisibility(element),
        tagName,
        inputType: datePicker(element)
          ? "date"
          : (input?.type.toLowerCase() ?? (role || tagName)),
        accept: input?.accept ?? "",
        min: input?.min ?? "",
        max: input?.max ?? "",
        step: input?.step ?? "",
        maxLength: input?.maxLength ?? textarea?.maxLength ?? -1,
        role,
        id: html.id ?? "",
        name: input?.name ?? textarea?.name ?? select?.name ?? "",
        scopeKey: scopeKeyFor(element),
        ...((input?.form ?? textarea?.form ?? select?.form)
          ? {
              formIndex: Array.from(document.forms).indexOf(
                (input?.form ?? textarea?.form ?? select?.form)!,
              ),
            }
          : {}),
        ...(phoneCallingCode ? { phoneCallingCode } : {}),
        label: directLabel(element),
        hint: hintFor(element, directLabel(element)),
        groupLabel: groupLabel(element),
        ...(rowScopeKey ? { rowScopeKey } : {}),
        sectionPath: sectionPath(element),
        placeholder: input?.placeholder ?? textarea?.placeholder ?? "",
        autocomplete: input?.autocomplete ?? textarea?.autocomplete ?? "",
        required:
          Boolean(input?.required ?? textarea?.required ?? select?.required) ||
          element.getAttribute("aria-required") === "true" ||
          titledRequired(element),
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
          // A custom checkbox or radio answers with its state; its text is
          // its option at most, never an icon's fallback.
          (role === "checkbox" || role === "radio"
            ? shownText(html)
            : shownText(html)) ??
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
        ...(input?.type === "file" ? { upload: readUpload(input) } : {}),
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
        role: element.getAttribute("role")?.toLowerCase() ?? "",
        ...placement(element),
        ...(element.hasAttribute("aria-pressed")
          ? { pressed: element.getAttribute("aria-pressed") === "true" }
          : {}),
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
              formIndex: Array.from(document.forms).indexOf(form),
              formAction: new URL(
                (actionElement?.hasAttribute("formaction")
                  ? actionElement.formAction
                  : form.getAttribute("action")) || window.location.href,
                document.baseURI,
              ).toString(),
              formMethod: (
                (actionElement?.hasAttribute("formmethod")
                  ? actionElement.formMethod
                  : form.getAttribute("method")) || "GET"
              ).toUpperCase(),
              submitsForm:
                button?.type === "submit" ||
                input?.type === "submit" ||
                input?.type === "image",
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
          .filter((text) => text.length > 0))(
        matching(selectors.validationErrors),
      ),
    [],
  );
  const headings = safe(
    () =>
      ((elements: Element[]): RawApplyHeading[] =>
        elements.flatMap((element) => {
          const html = element as HTMLElement;
          const text = html.innerText.trim();
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
        elements.flatMap((element, index) => {
          // A button already has its own ref, with its form's action:
          // neither it nor anything inside it (a label span, an icon),
          // across shadow roots, is a second name to press it under.
          for (
            let node: Element | null = element;
            node;
            node =
              node.parentElement ??
              ((node.getRootNode() as ShadowRoot).host || null)
          )
            if (node.matches(selectors.actions)) return [];
          const html = element as HTMLElement;
          const style = window.getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          const label =
            element.getAttribute("aria-label")?.trim() ||
            html.innerText.trim() ||
            element.getAttribute("title")?.trim() ||
            "";
          if (!label) return [];
          return [
            {
              index,
              label,
              ...placement(element),
              role: element.getAttribute("role")?.toLowerCase() ?? "",
              tagName: element.tagName.toLowerCase(),
              disabled:
                (element instanceof HTMLButtonElement && element.disabled) ||
                element.getAttribute("aria-disabled") === "true",
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
  const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  const bodyText =
    bodyStyle &&
    (bodyStyle.display === "none" ||
      bodyStyle.contentVisibility === "hidden" ||
      Number(bodyStyle.opacity || "1") === 0)
      ? ""
      : renderedText(document.body ?? document);
  return {
    controls,
    actions,
    links,
    validationErrors,
    headings,
    clickables,
    url: window.location.href,
    title: document.title,
    bodyText: bodyText,
    loading: document.readyState !== "complete",
    ...sendPressed(),
  };
}

async function readRawApplyPageOnce(page: Page): Promise<RawApplyPage> {
  // One DOM snapshot, preserving selector order and shadow-root access.
  const [snapshot, stepLabel, openedTabs, summaryRows] = await Promise.all([
    controlSnapshot(
      page,
      page.locator(Object.values(APPLY_PAGE_SELECTORS).join(", ")),
      {
        c: APPLY_CONTROL_SELECTOR,
        a: APPLY_ACTION_SELECTOR,
        l: APPLY_LINK_SELECTOR,
        e: APPLY_CLICKABLE_SELECTOR,
      },
    ).evaluateAll(collectApplyDocumentSnapshot, APPLY_PAGE_SELECTORS),
    readApplyStepLabel(page),
    readOpenedTabs(page),
    page
      .locator("dl")
      .evaluateAll(readApplySummaryRows)
      .catch(() => [] as { label: string; value: string }[]),
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

  // Observing must not open, dismiss or change pickers or their parent dialogs.
  const controlsWithChoices = enrichedControls;

  return {
    ...snapshot,
    controls: controlsWithChoices,
    openedTabs,
    stepLabel,
    ...(summaryRows.length ? { summaryRows } : {}),
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
      others.map(async (candidate, index) => ({
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
    .evaluateAll(collectCustomComboboxStates, [...wanted])
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

/**
 * Sets a toggle button (`aria-pressed`) that answers a question, such as a
 * Yes or No. One already in the wanted state is left alone: pressing it
 * again would clear the answer. A button with no type inside a form would
 * also submit that form; it is made a plain button first, so the press only
 * answers. Anything the page itself sends on the press still meets the fence.
 */
async function pressToggleButton(
  locator: Locator,
  checked: boolean,
): Promise<ApplyWriteResult> {
  const pressed = () =>
    locator.evaluate(
      (element) => element.getAttribute("aria-pressed") === "true",
    );
  try {
    // Only an option button is pressed here, never the form's own buttons:
    // a ref that went stale must not turn Submit into a plain button.
    if (
      !(await locator.evaluate((element) =>
        element.hasAttribute("aria-pressed"),
      ))
    )
      return { ok: false, error: "That is not an option button." };
    if ((await pressed()) !== checked) {
      await locator.evaluate((element) => {
        if (
          element instanceof HTMLButtonElement &&
          element.form &&
          !element.hasAttribute("type")
        )
          element.type = "button";
      });
      await locator.click({ timeout: 0 });
    }
    return (await pressed()) === checked
      ? { ok: true, observedValue: checked ? "pressed" : "not pressed" }
      : { ok: false, error: "The option did not take the press." };
  } catch (error) {
    return {
      ok: false,
      error: describeWriteFailure(error, "The option would not change."),
    };
  }
}

function controlLocator(page: Page, ref: string): Locator | null {
  if (hasBoundControlRefs(page)) return boundControlLocator(page, ref, "c");
  const target = locatorRootForRef(page, ref, "c");
  return target
    ? target.root.locator(APPLY_CONTROL_SELECTOR).nth(target.index)
    : null;
}

export function actionLocator(page: Page, ref: string): Locator | null {
  if (hasBoundControlRefs(page)) return boundControlLocator(page, ref, "a");
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
  if (hasBoundControlRefs(page)) return boundControlLocator(page, ref, "l");
  const target = locatorRootForRef(page, ref, "l");
  return target
    ? target.root.locator(APPLY_LINK_SELECTOR).nth(target.index)
    : null;
}

function clickableLocator(page: Page, ref: string): Locator | null {
  if (hasBoundControlRefs(page)) return boundControlLocator(page, ref, "e");
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
  if ((await locator.count()) === 0)
    throw new Error("Stale control; observe again.");
  const interaction = await locator.evaluate(readPressability);
  if (interaction.disabled) throw new Error("The control is disabled.");
  if (interaction.inert) throw new Error("The control is inert.");
  await locator.scrollIntoViewIfNeeded({ timeout: 0 }).catch(() => undefined);
  try {
    await locator.click({ timeout: 0 });
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
    await locator.click({ timeout: 0, force: true });
  }
  await page
    .waitForLoadState("domcontentloaded", { timeout: 0 })
    .catch(() => undefined);
}

/** The live-page implementation of the apply mechanics. */
export function createPlaywrightApplyPageMechanics(
  page: Page,
): ApplyRawPageHands {
  // Before any file is attached, so the request that carries it is seen.
  watchAttachmentUploads(page);
  return tracePageHands(page, {
    clickAuthorizedFormAction: async (ref) => {
      const locator = actionLocator(page, ref);
      if (!locator)
        return {
          ok: false,
          error:
            "The account or verification button is no longer on this page.",
        };
      try {
        await openPrepareOnlyAuthorizedFormActionWindow(page, locator);
        await clickAndSettle(page, locator);
        await waitForPrepareOnlyAuthorizedFormAction(page);
        return { ok: true, observedValue: "clicked" };
      } catch {
        // A prefilled password must never escape through a locator call log.
        return {
          ok: false,
          error: "The account or verification action could not be completed.",
        };
      } finally {
        await closePrepareOnlyAuthorizedFormActionWindow(page);
      }
    },
    readPage: () => {
      trackAccountFlowEntry(page);
      return readRawApplyPage(page);
    },
    readAccountFlowEntry: (origins) =>
      Promise.resolve(readAccountFlowEntry(page, origins)),
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
                error: "The intended button is disabled or unavailable.",
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
              .trim();
            return {
              ok: false,
              error: `The intended button is covered or outside the visible page.${text ? ` In front of it: ${text}` : ""}`,
            };
          },
          undefined,
          { timeout: 0 },
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
        return await replaceFieldText(locator, value);
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
        return await choosePageOption(page, locator, optionLabel);
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(
            error,
            "The picker could not select that option.",
          ),
        };
      }
    },
    setToggle: async (ref, checked): Promise<ApplyWriteResult> => {
      if (/^s\d+$/u.test(ref)) return setClosedShadowToggle(page, ref, checked);
      const toggle = actionLocator(page, ref);
      if (toggle) return pressToggleButton(toggle, checked);
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
            await locator.setChecked(checked, { timeout: 0 });
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
        // Read before the file goes in: some widgets (Greenhouse) remove
        // the input the moment it changes.
        const field = await locator
          .evaluate((element) =>
            element instanceof HTMLInputElement
              ? element.name || element.id || null
              : null,
          )
          .catch(() => null);
        // Leave the field being typed in, as a person reaching for the file
        // does: its answer is then committed, and a résumé parser that fills
        // untouched fields (Lever's) leaves it alone.
        await page
          .evaluate(() => {
            const active = document.activeElement;
            if (active instanceof HTMLElement && active !== document.body)
              active.blur();
          })
          .catch(() => undefined);
        rememberAttachedFile(page, ref, {
          field,
          name: file.name,
          size: file.bytes.byteLength,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        });
        await attachFile(page, locator, file);
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
          await locator.press(key, { timeout: 0 });
        } else {
          await page.keyboard.press(key);
        }
        await page
          .waitForLoadState("domcontentloaded", { timeout: 0 })
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
          { timeout: 0 },
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
        allowPrepareOnlyRunNavigation(page, target.toString());
        await withNavigationLiveness(page, () =>
          page.goto(target.toString(), {
            waitUntil: "domcontentloaded",
            timeout: 0,
          }),
        );
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
        allowPrepareOnlyRunNavigation(page, target.toString());
        await withNavigationLiveness(page, () =>
          page.goto(target.toString(), {
            waitUntil: "domcontentloaded",
            timeout: 0,
          }),
        );
        return { ok: true, url: page.url() };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "That page would not open."),
        };
      }
    },
    clickElement: async (ref): Promise<ApplyWriteResult> => {
      if (/^s\d+$/u.test(ref)) return clickClosedShadowControl(page, ref);
      const locator =
        actionLocator(page, ref) ??
        linkLocator(page, ref) ??
        clickableLocator(page, ref) ??
        controlLocator(page, ref);
      if (!locator) {
        return { ok: false, error: `There is nothing called ${ref} here.` };
      }
      try {
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
      await page.waitForTimeout(Math.max(0, milliseconds));
    },
    goBack: async (): Promise<ApplyNavigationResult> => {
      try {
        await withNavigationLiveness(page, () =>
          page.goBack({ waitUntil: "domcontentloaded", timeout: 0 }),
        );
        return { ok: true, url: page.url() };
      } catch (error) {
        return {
          ok: false,
          error: describeWriteFailure(error, "There is nothing to go back to."),
        };
      }
    },
    adoptOpenedTab: async (index): Promise<ApplyNavigationResult> => {
      if (hasPrepareOnlyPreparedValues(page))
        return {
          ok: false,
          error:
            "This tab holds prepared application values; its form stays in this tab.",
        };
      const others = await listTaskOwnedPopups(page);
      const opened = others[index];
      if (!opened) {
        return { ok: false, error: "That tab is no longer open." };
      }
      if (isClaimedAccountWindow(opened))
        return {
          ok: false,
          error:
            "An account window belongs to its original application and cannot be adopted.",
        };
      await opened
        .waitForLoadState("domcontentloaded", { timeout: 0 })
        .catch(() => undefined);
      const url = opened.url();
      if (!/^https?:/iu.test(url)) {
        await opened.close().catch(() => undefined);
        return { ok: false, error: "That tab never loaded a web page." };
      }
      await opened.close().catch(() => undefined);
      try {
        allowPrepareOnlyRunNavigation(page, url);
        await withNavigationLiveness(page, () =>
          page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 0,
          }),
        );
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
        return (await readRawApplyPage(page)).bodyText;
      }
      const locator =
        controlLocator(page, ref) ??
        actionLocator(page, ref) ??
        linkLocator(page, ref) ??
        clickableLocator(page, ref);
      if (!locator) {
        return "";
      }
      return readVisibleText(locator);
    },
  });
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
  signal?: AbortSignal;
}): ApplyPageSession & { closeAccountWindow(): Promise<void> } {
  const { page } = input;
  const mechanics = createPlaywrightApplyPageMechanics(page);
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

  const session: ApplyPageSession = {
    ...mechanics,
    clickAuthorizedFormAction: mechanics.clickAuthorizedFormAction!,
    clickAuthorizedLoginAction: async (grant) => {
      const locator = actionLocator(page, grant.ref);
      if (!locator)
        return { ok: false, error: "The sign-in control is unavailable." };
      return clickPreparedLoginAction(
        page,
        locator,
        grant,
        async () => {
          try {
            return await clickAndSettle(page, locator);
          } finally {
            await tracePage(page, "login_action");
          }
        },
        input.signal,
      );
    },
    clickWithoutWrites: (expected) => mechanics.clickElement(expected.ref),
    clickBoundAction: (expected) => mechanics.clickElement(expected.ref),
    setToggle: async (ref, checked) => {
      // A radio or checkbox sends its value ("PT") and its page shows a label
      // ("Portugal"): the guard has to know both before it is activated.
      const control = controlLocator(page, ref);
      const declared = control
        ? await control
            .evaluate((element) => {
              const input =
                element instanceof HTMLInputElement
                  ? element
                  : element.querySelector("input");
              if (!input || !["radio", "checkbox"].includes(input.type))
                return [];
              const label =
                input.labels?.[0]?.textContent ??
                input.getAttribute("aria-label") ??
                "";
              // What the control submits: its value, or the browser's "on"
              // when it has no value attribute.
              return [input.value, label];
            })
            .catch(() => [] as string[])
        : [];
      if (checked)
        for (const value of declared)
          if (value.trim())
            await registerPrepareOnlyPreparedValue(page, value).catch(
              () => undefined,
            );
      return mechanics.setToggle(ref, checked);
    },
    chooseOption: async (ref, optionLabel) => {
      // A native select sends its option's value ("PT"), not the label the
      // run declared ("Portugal"): the guard has to know both.
      const control = controlLocator(page, ref);
      const value = control
        ? await control
            .evaluate((element, label) => {
              if (!(element instanceof HTMLSelectElement)) return null;
              const wanted = label.trim();
              return (
                [...element.options].find(
                  (option) =>
                    option.label.trim() === wanted ||
                    option.text.trim() === wanted,
                )?.value ?? null
              );
            }, optionLabel)
            .catch(() => null)
        : null;
      if (value?.trim())
        await registerPrepareOnlyPreparedValue(page, value).catch(
          () => undefined,
        );
      // The page may load the list that depends on this choice.
      await markPrepareOnlyPickerChoice(page, [optionLabel, value ?? ""]);
      return mechanics.chooseOption(ref, optionLabel);
    },
    uploadFile: async (ref, file) => {
      const control = controlLocator(page, ref);
      // The file input's own name or id, or false when it is not one.
      const fileField = control
        ? await control.evaluate((element) =>
            element instanceof HTMLInputElement && element.type === "file"
              ? element.name || element.id || null
              : false,
          )
        : false;
      if (fileField !== false)
        await openPrepareOnlyAttachmentUploadWindow(page, file, fileField);
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
    },
    closeUploadWindow: () => closePrepareOnlyAttachmentUploadWindow(page),
    closeIntermediateWriteWindow: () =>
      closePrepareOnlyIntermediateMutationWindow(page),
    readIntermediateWriteCount: () =>
      readPrepareOnlyIntermediateWriteCount(page),
    drainIntermediateWrites: () => drainPrepareOnlyIntermediateWrites(page),
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
  return withAccountWindowSession({
    ...input,
    session,
    locate: (ref) =>
      controlLocator(page, ref) ??
      actionLocator(page, ref) ??
      linkLocator(page, ref) ??
      clickableLocator(page, ref),
    click: async (locator) => {
      try {
        return await clickAndSettle(page, locator);
      } finally {
        await tracePage(page, "account_action");
      }
    },
    mechanics: createPlaywrightApplyPageMechanics,
  });
}

/** Reads use the shared browser connection liveness; navigation is a tool error. */
export function readRawApplyPage(page: Page): Promise<RawApplyPage> {
  return withBrowserReadLiveness(page, () => collectRawApplyPage(page));
}
