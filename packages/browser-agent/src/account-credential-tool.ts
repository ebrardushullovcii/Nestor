import { z } from "zod";
import { parseToolArguments, type AgentLoopTool } from "@nestor/agent-runtime";
import type { ApplyPageHands } from "./apply/types";
import { describeObservation } from "./apply/apply-prompts";

export function createSavedLoginTools(hands: ApplyPageHands): AgentLoopTool[] {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "list_saved_logins",
          description:
            "List safe saved-login metadata for this site. Choose a credentialId; no passwords are returned.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => ({
        kind: "ok",
        content: JSON.stringify(
          (await hands.listSavedCredentials?.()) ?? {
            available: false,
            credentials: [],
            message: "Login metadata is unavailable in this browser.",
          },
        ),
      }),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "fill_saved_login",
          description:
            "Have the vault type the chosen saved password into an observed password ref, without returning the secret. Type the username from metadata yourself.",
          parameters: {
            type: "object",
            properties: {
              ref: { type: "string" },
              credentialId: { type: "string" },
            },
            required: ["ref", "credentialId"],
          },
        },
      },
      execute: async (raw) => {
        const args = parseToolArguments(raw);
        if (
          typeof args.ref !== "string" ||
          typeof args.credentialId !== "string"
        )
          return {
            kind: "ok",
            status: "failed",
            content: "fill_saved_login requires ref and credentialId strings.",
          };
        const ok = await hands.fillSavedCredential?.(
          args.ref,
          args.credentialId,
        );
        return {
          kind: "ok",
          status: ok ? "done" : "failed",
          content: `${ok ? "The vault filled the password field." : "The vault could not fill that field; inspect the page and metadata."}\n${describeObservation(await hands.observe())}`,
        };
      },
    },
  ];
}

export function createAccountCredentialTool(
  hands: ApplyPageHands,
): AgentLoopTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "generate_account_login",
        description:
          "For a new account, have the vault generate a strong password, save the site's login, and type it into every password/confirm field you name. Supply the account username and observed passwordRefs; never supply or request a password value. The result contains only credentialId and metadata. Then press Create Account yourself. Later use list_saved_logins and fill_saved_login for this saved account. A retry reuses the generated login.",
        parameters: {
          type: "object",
          properties: {
            username: { type: "string" },
            passwordRefs: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
          },
          required: ["username", "passwordRefs"],
          ...{ additionalProperties: false },
        },
      },
    },
    failureKind: "browser",
    describeError: () =>
      "The vault could not generate or fill the account login; retry the vault tool or report the error.",
    execute: async (raw) => {
      const parsed = z
        .object({
          username: z.string(),
          passwordRefs: z.array(z.string()).min(1),
        })
        .strict()
        .safeParse(parseToolArguments(raw));
      if (!parsed.success)
        return {
          kind: "ok",
          status: "failed",
          content:
            "generate_account_login needs username and a nonempty passwordRefs list; it never accepts a password value.",
        };
      if (!hands.generateAccountCredential)
        return {
          kind: "ok",
          status: "failed",
          content:
            "This browser has no vault account-generation implementation. This is an app error, not a missing personal fact.",
        };
      const result = await hands.generateAccountCredential(parsed.data);
      return {
        kind: "ok",
        status: result.ok ? "done" : "failed",
        content: JSON.stringify(result),
        progress: result.ok,
      };
    },
  };
}
