import { parseToolArguments, type AgentLoopTool } from "@nestor/agent-runtime";
import type { ApplyFormObservation, ApplyPageHands } from "./apply/types";
import { describeObservation } from "./apply/apply-prompts";
import { markVerificationPrivate } from "@nestor/core/run-trace";
import { z } from "zod";

export const MAILBOX_INSTRUCTIONS =
  "Keep the application's form open. Use open_tab to read emailed verification codes in Gmail in this same browser session, switch_tab with the form tab's id to type the code, then close_tab for the mailbox when finished. Emailed codes may be used transiently for the step that needs them; never put a code in saved answers, the profile, reports, evidence or tool reasons. Passwords, cookies, tokens and non-email MFA secrets stay outside model context. If a real mailbox attempt cannot retrieve the code, hand off the step on the open form through Needs you.";

export async function mailboxAccountFacts(
  hands: ApplyPageHands,
): Promise<string> {
  try {
    const mailbox = await hands.readMailboxSession?.();
    if (mailbox?.status === "signed_in")
      return `Mailbox state read from the browser's own account UI: ${JSON.stringify(mailbox.accounts)}. These Google accounts are signed in in this browser. When the site offers Google sign-in/sign-up and the person has enabled it, use their existing Google session if it fits the site. ${MAILBOX_INSTRUCTIONS}`;
    if (mailbox?.status === "google_accounts_redirect")
      return `At run start Gmail redirected to Google Accounts in this browser. The Gmail inbox was unavailable and there is no confirmed Google session to reuse. If Google asks for a sign-in or verification step only the person can complete, tell them Google needs them to sign in again in Nestor’s browser. ${MAILBOX_INSTRUCTIONS}`;
    return `The run-start read could not establish a signed-in mailbox account. You can inspect Gmail yourself in a second tab. ${MAILBOX_INSTRUCTIONS}`;
  } catch {
    return `The run-start mailbox read was unavailable. You can inspect it yourself. ${MAILBOX_INSTRUCTIONS}`;
  }
}

export async function signInSessionFacts(
  hands: ApplyPageHands,
): Promise<string> {
  const [mailbox, providers] = await Promise.all([
    mailboxAccountFacts(hands),
    (async () => {
      try {
        return await hands.readProviderSessions?.();
      } catch {
        return undefined;
      }
    })(),
  ]);
  return [
    mailbox,
    ...(providers ?? []).map(({ provider, status }) =>
      status === "signed_in"
        ? `${provider} is signed in in this browser. The run-start read found its account menu.`
        : `The run-start read did not confirm a ${provider} session in this browser.`,
    ),
    "For providers with unknown or unavailable session status, use any signed-in identity shown by the site's sign-in flow.",
  ].join("\n");
}

/** Shared by application, search, source checks and sign-in page workflows. */
export function createTabTools(
  hands: ApplyPageHands,
  remember: (observation: ApplyFormObservation) => void,
  describe = describeObservation,
): AgentLoopTool[] {
  return (["open_tab", "switch_tab", "close_tab"] as const).map((name) => ({
    definition: {
      type: "function" as const,
      function: {
        name,
        description:
          name === "open_tab"
            ? "Open an auxiliary tab and work there while keeping the application form open and bound. Use this for Gmail and emailed codes. The result lists task tab IDs."
            : name === "switch_tab"
              ? "Work in a task tab by its id, without reloading either page. All page tools now act on this tab."
              : "Close an auxiliary task tab. Its form tab remains open and bound.",
        parameters: {
          type: "object",
          properties:
            name === "open_tab"
              ? { url: { type: "string", minLength: 1, pattern: "\\S" } }
              : { tabId: { type: "string", minLength: 1, pattern: "\\S" } },
          required: [name === "open_tab" ? "url" : "tabId"],
          additionalProperties: false,
        },
      },
    },
    failureKind: "browser" as const,
    execute: async (raw: string) => {
      const parsed = (
        name === "open_tab"
          ? z.object({ url: z.string().regex(/\S/u) }).strict()
          : z.object({ tabId: z.string().regex(/\S/u) }).strict()
      ).safeParse(parseToolArguments(raw));
      if (!parsed.success)
        return {
          kind: "ok" as const,
          status: "failed" as const,
          content: `${name} contract: ${parsed.error.message}`,
        };
      const args = parsed.data;
      const value = "url" in args ? args.url : args.tabId;
      if (typeof value !== "string" || !value.trim())
        return {
          kind: "ok" as const,
          status: "failed" as const,
          content: `${name} needs ${name === "open_tab" ? "url" : "tabId"}.`,
        };
      const method =
        name === "open_tab"
          ? hands.openTab
          : name === "switch_tab"
            ? hands.switchTab
            : hands.closeTab;
      if (!method)
        return {
          kind: "ok" as const,
          status: "failed" as const,
          content: "This browser has no task-tab implementation.",
        };
      if (name === "open_tab") markVerificationPrivate();
      const result = await method(value);
      const page = await hands.observe();
      remember(page);
      return {
        kind: "ok" as const,
        status: result.ok ? ("done" as const) : ("failed" as const),
        content: `${result.ok ? `Completed ${name}.` : result.error}\n${describe(page)}`,
        progress: result.ok,
      };
    },
  }));
}
