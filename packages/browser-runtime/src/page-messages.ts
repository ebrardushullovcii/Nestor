import type { Page } from "playwright";
import type { RawApplyPageMessage } from "@nestor/contracts";

/** What a recorded page message prints to the console, for the app's banner. */
export const PAGE_MESSAGE_CONSOLE_PREFIX = "nestor-page-message:";

/**
 * Runs inside a job page. Its alert, confirm and prompt never open a window:
 * each is dismissed (confirm answers no, prompt gives nothing) and its text
 * is kept for the run to read and printed for the app to show in its own
 * design. Keep this function self-contained: it is serialized into pages.
 */
export function installPageMessageRecorderInPage(): void {
  const pageWindow = window as unknown as Record<string, unknown>;
  if (pageWindow["__nestorPageMessages"]) return;
  const messages: Array<{ kind: string; text: string; at: number }> = [];
  pageWindow["__nestorPageMessages"] = messages;
  const note = (kind: string, value: unknown): void => {
    const said =
      typeof value === "string"
        ? value
        : value === undefined || value === null
          ? ""
          : (JSON.stringify(value) ?? "");
    const text = said.replace(/\s+/gu, " ").trim().slice(0, 500);
    if (!text) return;
    messages.push({ kind, text, at: Date.now() });
    messages.splice(0, Math.max(0, messages.length - 20));
    try {
      console.debug(`nestor-page-message:${JSON.stringify({ kind, text })}`);
    } catch {
      /* A page that replaced console still had its message recorded. */
    }
  };
  const replace = (name: "alert" | "confirm" | "prompt", answer: unknown) => {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        writable: true,
        value: function (message?: unknown) {
          note(name, message);
          return answer;
        },
      });
    } catch {
      /* The app's own dialog switch still keeps any window from showing. */
    }
  };
  replace("alert", undefined);
  replace("confirm", false);
  replace("prompt", null);
}

/** The messages the page's frames recorded at or after `sinceMs`. */
export async function readPageMessages(
  page: Page,
  sinceMs = 0,
): Promise<RawApplyPageMessage[]> {
  const messages: RawApplyPageMessage[] = [];
  for (const frame of page.frames()) {
    const recorded = await frame
      .evaluate(
        () =>
          ((window as unknown as Record<string, unknown>)[
            "__nestorPageMessages"
          ] ?? []) as RawApplyPageMessage[],
      )
      .catch(() => [] as RawApplyPageMessage[]);
    messages.push(...recorded.filter((message) => message.at >= sinceMs));
  }
  return messages.sort((a, b) => a.at - b.at).slice(-20);
}

/**
 * True when a page message reads as a failure: a CAPTCHA that could not be
 * reached, a connection or server error, a retry request. Never proof either
 * way about a send; a site can show one and still take the application.
 */
export function pageMessageReadsAsFailure(text: string): boolean {
  return /captcha|cannot contact|could ?n[o’']t|unable to|failed|failure|error|try again|went wrong|not (?:be )?(?:sent|submitted)|check your connection|invalid|required/iu.test(
    text,
  );
}
