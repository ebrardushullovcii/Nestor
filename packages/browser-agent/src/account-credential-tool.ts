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

export function createAccountCredentialTools(
  hands: ApplyPageHands,
): AgentLoopTool[] {
  return [createAccountDraftTool(hands), resolveAccountDraftTool(hands)];
}

function createAccountDraftTool(hands: ApplyPageHands): AgentLoopTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "generate_account_login",
        description:
          "For a new password account, have the vault draft a strong password and type it into every observed password/confirm field you name. Supply the username and passwordRefs. The result contains the draft credentialId and metadata, never the password. A retry on this tab reuses the draft. Press Create Account, observe what the site says, then call resolve_account_login to save or discard it.",
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

function resolveAccountDraftTool(hands: ApplyPageHands): AgentLoopTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "resolve_account_login",
        description:
          "Resolve your generated draft by credentialId. Use accepted after you observe that the site accepted this new password login, including required verification. The vault then saves it for later runs. Use discarded when the site rejected signup and you are dropping the draft. Saved or imported logins cannot be discarded with this tool.",
        parameters: {
          type: "object",
          properties: {
            credentialId: { type: "string" },
            outcome: { type: "string", enum: ["accepted", "discarded"] },
          },
          required: ["credentialId", "outcome"],
          additionalProperties: false,
        },
      },
    },
    failureKind: "browser",
    describeError: () =>
      "The vault could not resolve the draft login. Retry the vault tool or report the error.",
    execute: async (raw) => {
      const parsed = z
        .object({
          credentialId: z.string(),
          outcome: z.enum(["accepted", "discarded"]),
        })
        .strict()
        .safeParse(parseToolArguments(raw));
      if (!parsed.success)
        return {
          kind: "ok",
          status: "failed",
          content: `resolve_account_login contract: ${parsed.error.message}`,
        };
      const resolved = await hands.resolveAccountCredential?.(parsed.data);
      return {
        kind: "ok",
        status: resolved ? "done" : "failed",
        content: !hands.resolveAccountCredential
          ? "This browser has no vault draft resolution implementation."
          : !resolved
            ? "That draft is unavailable in this task's tabs. Saved logins were not changed."
            : parsed.data.outcome === "accepted"
              ? "The vault saved the accepted login. Use list_saved_logins to find its saved ID."
              : "The vault discarded the draft login.",
      };
    },
  };
}
