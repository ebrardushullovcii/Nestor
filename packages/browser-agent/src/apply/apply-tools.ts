import type { ApplyProposal } from "./types";

const STORED_FACT_PARAMETER = {
  type: "string",
  description:
    "For an unchanged stored value: its exact id from the stored-fact catalog. Values that differ still need an answer check. Eligibility always needs its question and hiring context checked.",
};

/**
 * What the apply agent can do.
 *
 * This is a harness, not a form-filler on rails. The agent gets the ordinary
 * powers a person has in a browser — look, read, click anything, follow a
 * link, type, go back, wait, scroll — and is trusted to work out how a
 * particular site wants to be used. Job Finder does not decide in advance
 * which button is the Apply button, because every time it has tried, it has
 * been wrong about some site a person could have used without thinking.
 *
 * The deliberate exceptions are safety, and they are small: the answer to a
 * question comes from the person's own facts rather than the model's
 * imagination, and sending an application goes through a separate check.
 */

export const APPLY_TOOL_NAMES = [
  "observe",
  "read_text",
  "navigate",
  "follow_link",
  "click",
  "type",
  "select",
  "set_checkbox",
  "upload",
  "scroll",
  "wait",
  "go_back",
  "submit_application",
  "finish",
] as const;

export type ApplyToolName = (typeof APPLY_TOOL_NAMES)[number];

/** Same shape the discovery tools hand the model, so one client serves both. */
export interface ApplyToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export function getApplyToolDefinitions(): ApplyToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "observe",
        description:
          "Look at the whole page: its address, headings, every visible field, every button, every link with where it goes, anything else clickable, tabs the page opened, and an excerpt of the text. Nothing is filtered — what a person could see, you can see. The first page view is supplied before your first turn. Use observe when that read failed or you need page facts beyond the fresh view returned by fill_fields.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "read_text",
        description:
          "Read the full text of the page, or of one element, when the excerpt in observe was not enough.",
        parameters: {
          type: "object",
          properties: {
            ref: {
              type: "string",
              description:
                "Optional handle of one element. Omit for the whole page.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "navigate",
        description:
          "Go to a web address. Use it for an address you read on the page, or to get back to one you saw earlier.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            reason: {
              type: "string",
              description:
                "If this leaves the site the listing is on: exactly why it serves the application, what on the page points there, and what you expect to find. A second review reads it.",
            },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "follow_link",
        description:
          "Open what a link points at, in this same tab, whether or not the site wanted it in a new one. This is how you get from a job listing to the form that belongs to it, including onto a different company's site.",
        parameters: {
          type: "object",
          properties: {
            ref: {
              type: "string",
              description: "The link handle, such as l4.",
            },
            reason: {
              type: "string",
              description:
                "If this leaves the site the listing is on: exactly why it serves the application, what on the page points there, and what you expect to find. A second review reads it.",
            },
          },
          required: ["ref"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "click",
        description:
          "Press a button, link, card, tab, a cookie banner's Reject or Essential only, or the close cross on a chat widget. Never accept optional cookies, tracking or marketing consent. Security checks and unapproved declarations stay with the person.",
        parameters: {
          type: "object",
          properties: {
            ref: {
              type: "string",
              description: "Any handle from observe: a3, l7, e12, c2.",
            },
            reason: {
              type: "string",
              description:
                "If this leaves the site the listing is on: exactly why it serves the application, what on the page points there, and what you expect to find. A second review reads it.",
            },
          },
          required: ["ref"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "type",
        description:
          "Type into one field. To fill several fields at once, use fill_fields. An answer about the person must come from their facts; Job Finder checks it before it is typed.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string" },
            text: { type: "string" },
            storedFactId: STORED_FACT_PARAMETER,
            groundedIn: {
              type: "array",
              items: { type: "string" },
              description:
                "For text you wrote yourself: what you based it on, in plain words.",
            },
          },
          required: ["ref", "text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "select",
        description: "Choose an option in a list or dropdown.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string" },
            storedFactId: STORED_FACT_PARAMETER,
            option: {
              type: "string",
              description: "The option's exact label.",
            },
          },
          required: ["ref", "option"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_checkbox",
        description:
          "Tick or untick a checkbox or radio. Anything the person has to declare themselves — certifying answers are true, consenting to a background check, equal-opportunity questions — is only ticked when they approved that kind in advance; otherwise it waits for them.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string" },
            storedFactId: STORED_FACT_PARAMETER,
            checked: { type: "boolean" },
          },
          required: ["ref", "checked"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "upload",
        description:
          "Attach one of the files Job Finder holds for this application to a file field.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string" },
            documentId: {
              type: "string",
              description: "An id from the file list in your instructions.",
            },
          },
          required: ["ref", "documentId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "scroll",
        description:
          "Move the page, for content that only loads or appears when you scroll.",
        parameters: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["down", "up", "top", "bottom"],
            },
          },
          required: ["direction"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wait",
        description:
          "Wait for a page that is still settling, then look again. Use it sparingly.",
        parameters: {
          type: "object",
          properties: {
            milliseconds: {
              type: "number",
              description:
                "Up to 30000. A page checking the browser by itself can take a minute or two: wait 20000 to 30000 at a time.",
            },
          },
          required: ["milliseconds"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "go_back",
        description: "Go back, when a link turned out to be the wrong way.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "submit_application",
        description:
          "Say the form is complete and this is the button that sends it. First read the fresh page returned by fill_fields or observe and dismiss ordinary cookie banners, newsletter dialogs, and chat overlays using their own controls; readable fields can still have a covered send button. Job Finder checks everything again and presses it only if the person allowed that; otherwise the application stops here, filled in and ready for them.",
        parameters: {
          type: "object",
          properties: { ref: { type: "string" } },
          required: ["ref"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description:
          "Finish. Before reporting a completed form, read the fresh page returned by fill_fields or observe, dismiss ordinary cookie banners, newsletter dialogs, and chat overlays using their own controls, and check the final button on the returned page. When questions remain for the person, use needsPerson: true and name each one in forPerson; one finish hands back all the questions and ends the run. Call finish when the form is complete, when only the person can go further (they have to sign in, pass a security check, pay, or make an account), or when you are genuinely stuck. The reason is your report to the person: which site and page you were on, what you tried, what the page did, and what they need to do. Pass stuck: true when you could not get there.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Why you are finishing, in one plain sentence.",
            },
            stuck: { type: "boolean" },
            needsPerson: {
              type: "boolean",
              description:
                "true when the person has to do something on the site before this can go further. Needs at least one forPerson item.",
            },
            forPerson: {
              type: "array",
              items: { type: "string" },
              description:
                "Each question the person must answer or thing they must do before this can go further, one per item, apart from the reason. For a form field, use its observed control ref (for example c3), so any wording stays bound to that field's own question, options and saved answer. Do not restate the field as another question. For a separate manual step such as sign-in or MFA, describe that step in plain words. Leave it empty when the form is complete; a form that only wants looking over is complete.",
            },
          },
          required: ["reason"],
        },
      },
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const values = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return values.length > 0 ? values : null;
}

export type ApplyProposalParse =
  | { ok: true; proposal: ApplyProposal }
  | { ok: false; error: string };

/** Turns one model tool call into a proposal, or says plainly what was wrong. */
export function parseApplyProposal(
  toolName: string,
  rawArguments: string,
): ApplyProposalParse {
  let parsedArguments: unknown = {};
  if (rawArguments.trim().length > 0) {
    try {
      parsedArguments = JSON.parse(rawArguments);
    } catch {
      return {
        ok: false,
        error: `The arguments for ${toolName} were not valid JSON.`,
      };
    }
  }
  const args = asRecord(parsedArguments);
  const ref = asString(args.ref);
  const reason = asString(args.reason);
  const storedFactId = asString(args.storedFactId);
  const factReference = storedFactId ? { storedFactId } : {};
  const withReason = <T extends object>(
    proposal: T,
  ): T & { reason?: string } => (reason ? { ...proposal, reason } : proposal);
  const needsRef = (): ApplyProposalParse => ({
    ok: false,
    error: `${toolName} needs the handle of what to act on, in ref.`,
  });

  switch (toolName) {
    case "observe":
      return { ok: true, proposal: { tool: "observe" } };
    case "read_text":
      return {
        ok: true,
        proposal: { tool: "read_text", ...(ref ? { ref } : {}) },
      };
    case "navigate": {
      const url = asString(args.url);
      return url
        ? { ok: true, proposal: withReason({ tool: "navigate" as const, url }) }
        : { ok: false, error: "navigate needs a url." };
    }
    case "follow_link":
      return ref
        ? {
            ok: true,
            proposal: withReason({ tool: "follow_link" as const, ref }),
          }
        : needsRef();
    case "click":
      return ref
        ? { ok: true, proposal: withReason({ tool: "click" as const, ref }) }
        : needsRef();
    case "type": {
      if (!ref) return needsRef();
      const text = asString(args.text);
      if (text === null) {
        return { ok: false, error: "type needs the text to put in the field." };
      }
      const groundedIn = asStringArray(args.groundedIn);
      return {
        ok: true,
        proposal: {
          tool: "type",
          ref,
          text,
          ...(groundedIn ? { groundedIn } : {}),
          ...factReference,
        },
      };
    }
    case "select": {
      if (!ref) return needsRef();
      const option = asString(args.option);
      return option
        ? {
            ok: true,
            proposal: { tool: "select", ref, option, ...factReference },
          }
        : { ok: false, error: "select needs the option's label." };
    }
    case "set_checkbox":
      return ref
        ? {
            ok: true,
            proposal: {
              tool: "set_checkbox",
              ref,
              checked: args.checked !== false,
              ...factReference,
            },
          }
        : needsRef();
    case "upload": {
      if (!ref) return needsRef();
      const documentId = asString(args.documentId);
      return documentId
        ? { ok: true, proposal: { tool: "upload", ref, documentId } }
        : { ok: false, error: "upload needs a documentId." };
    }
    case "scroll": {
      const direction = asString(args.direction) ?? "down";
      return ["down", "up", "top", "bottom"].includes(direction)
        ? {
            ok: true,
            proposal: {
              tool: "scroll",
              direction: direction as "down" | "up" | "top" | "bottom",
            },
          }
        : { ok: false, error: "scroll takes down, up, top, or bottom." };
    }
    case "wait": {
      const milliseconds =
        typeof args.milliseconds === "number" ? args.milliseconds : 1_000;
      return { ok: true, proposal: { tool: "wait", milliseconds } };
    }
    case "go_back":
      return { ok: true, proposal: { tool: "go_back" } };
    case "submit_application":
      return ref
        ? { ok: true, proposal: { tool: "submit_application", ref } }
        : needsRef();
    case "finish": {
      const reason = asString(args.reason) ?? "Finished without saying why.";
      const named = (asStringArray(args.forPerson) ?? [])
        .map((item) => item.trim())
        .filter(Boolean);
      // Past twenty, the rest go together as one more item: none is dropped.
      const forPerson =
        named.length > 20
          ? [...named.slice(0, 20), named.slice(20).join("; ")]
          : named;
      return {
        ok: true,
        proposal: {
          tool: "finish",
          reason,
          stuck: args.stuck === true,
          // A named item is something waiting on the person.
          needsPerson: args.needsPerson === true || forPerson.length > 0,
          forPerson,
        },
      };
    }
    default:
      return { ok: false, error: `There is no tool called ${toolName}.` };
  }
}

/** A batch carries the same proposals as the single-field tools. */
export const FILL_FIELDS_TOOL_DEFINITION: ApplyToolDefinition = {
  type: "function",
  function: {
    name: "fill_fields",
    description:
      "Complete the visible step in one call, from the first step onward: fill all answerable fields, attach the requested available documents with upload, then include thenContinue for Continue or Next when no required answer is missing. Entries use the exact single-tool arguments for type, select, set_checkbox, upload or click through the same executor, permissions and send checks. Independent stored-fact fills may run before answers waiting for a check; clicks, uploads and writes to the same field or choice group retain their order. Click may dismiss a cookie banner or add a required history row on this step; use handles already observed and read the returned page for newly revealed handles. Choose a radio with set_checkbox on its option's ref. A refusal, pause, navigation, changed step or newly revealed question after a field write stops the rest and names entries not attempted. Ordinary upload buttons changing or a chore click revealing a row on this same page do not stop planned entries. Omit thenContinue when a question needs the person; fill everything else, then finish once. Never use this tool to send. Validation errors or an unchanged step are reported with one fresh page observation.",
    parameters: {
      type: "object",
      properties: {
        thenContinue: {
          type: "string",
          description:
            "Optional ref of this step’s Continue or Next control. Use only when every required field is answered.",
        },
        finishWhenReady: {
          type: "boolean",
          description:
            "On the final page, finish after filling and verifying every answer. Uses the same readiness checks as finish; never presses Send.",
        },
        fields: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                enum: ["type", "select", "set_checkbox", "upload", "click"],
              },
              ref: { type: "string" },
              storedFactId: STORED_FACT_PARAMETER,
              text: {
                type: "string",
                description: "For type: the text to enter.",
              },
              option: {
                type: "string",
                description: "For select: the option's label.",
              },
              checked: {
                type: "boolean",
                description: "For set_checkbox: true or false.",
              },
              documentId: {
                type: "string",
                description:
                  "For upload: an id from the available document list, or letter for an observed cover-letter field. Job Finder writes and checks a missing permitted letter locally; put that upload after the other fields so its writing can overlap their fills.",
              },
              reason: {
                type: "string",
                description: "For click: why this page chore is needed.",
              },
              groundedIn: {
                type: "array",
                items: { type: "string" },
                description:
                  "For text you wrote: what you based it on, in plain words.",
              },
            },
            required: ["tool", "ref"],
          },
        },
      },
      required: ["fields"],
    },
  },
};

export type FillFieldsEntry = Extract<
  ApplyProposal,
  { tool: "type" | "select" | "set_checkbox" | "upload" | "click" }
>;

export function parseFillFields(rawArguments: string):
  | {
      ok: true;
      fields: FillFieldsEntry[];
      thenContinue?: string;
      finishWhenReady?: boolean;
    }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return {
      ok: false,
      error: "The arguments for fill_fields were not valid JSON.",
    };
  }
  const record = asRecord(parsed);
  const thenContinue = record.thenContinue;
  if (
    (record.finishWhenReady !== undefined &&
      typeof record.finishWhenReady !== "boolean") ||
    (record.finishWhenReady === true && thenContinue !== undefined)
  ) {
    return {
      ok: false,
      error:
        "Use finishWhenReady: true on the final page, or thenContinue on an earlier step, never both.",
    };
  }
  if (
    thenContinue !== undefined &&
    (typeof thenContinue !== "string" || !thenContinue.trim())
  ) {
    return {
      ok: false,
      error: "thenContinue needs the ref of Continue or Next.",
    };
  }
  const entries = record.fields;
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      ok: false,
      error: "fill_fields needs a non-empty list of field actions.",
    };
  }
  const fields: FillFieldsEntry[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (
      record.tool !== "type" &&
      record.tool !== "select" &&
      record.tool !== "set_checkbox" &&
      record.tool !== "upload" &&
      record.tool !== "click"
    ) {
      return {
        ok: false,
        error:
          "fill_fields accepts only type, select, set_checkbox, upload and page-chore click actions. Use separate tools for navigation and sending.",
      };
    }
    if (record.tool === "set_checkbox" && typeof record.checked !== "boolean") {
      return {
        ok: false,
        error: "A set_checkbox field action needs checked: true or false.",
      };
    }
    const result = parseApplyProposal(record.tool, JSON.stringify(record));
    if (!result.ok) return result;
    const proposal = result.proposal;
    if (
      proposal.tool === "type" ||
      proposal.tool === "select" ||
      proposal.tool === "set_checkbox" ||
      proposal.tool === "upload" ||
      proposal.tool === "click"
    ) {
      fields.push(proposal);
    }
  }
  return {
    ok: true,
    fields,
    ...(record.finishWhenReady === true ? { finishWhenReady: true } : {}),
    ...(typeof thenContinue === "string"
      ? { thenContinue: thenContinue.trim() }
      : {}),
  };
}
