import {
  parseToolArguments,
  type AgentLoopTool,
  type AgentLoopToolOutcome,
} from "@nestor/agent-runtime";
import { describeBrowserError } from "@nestor/contracts";

import { describeObservation } from "./apply/apply-prompts";
import { TEXT_RETENTION_MS, textRetentionError } from "./apply/text-retention";
import type { ApplyFormObservation, ApplyPageHands } from "./apply/types";

/**
 * The ordinary powers a person has in a browser, as tools.
 *
 * One pack, shared by every agent that works a web page: look at the whole
 * page, read it, go to an address, follow a link, press anything, type,
 * choose, tick, scroll, wait, go back. Nothing here decides what a page
 * means or which button matters; that is the model's, with the whole page
 * in front of it.
 *
 * What is added is only what the harness can see and the model cannot: a
 * tab the page opened is brought into the working tab and reported; a page
 * that changed since the model last looked is refused once and shown again;
 * an address outside what the person allowed is refused with the reason.
 */

export interface PageToolPolicy {
  /** Returns a plain refusal when the address is outside the run's home, else null. */
  allowUrl?: (url: string) => string | null;
  /**
   * Asked when an address is outside the home and the model said why it
   * wants to go there. A second judgement, made against the goal: allowed
   * with a note, or refused with the verdict the model reads.
   */
  reviewMove?: (input: {
    url: string;
    reason: string;
    fromUrl: string | null;
  }) => Promise<{ allowed: boolean; verdict: string }>;
  /**
   * How a page view is written for the model. Defaults to the full view; a
   * host can send a leaner one or say a view is unchanged.
   */
  describe?: (observation: ApplyFormObservation) => string;
}

export interface PageToolsState {
  /** The page as the model last saw it. */
  observation: ApplyFormObservation | null;
  /** Every address the run has been on, oldest first, without duplicates. */
  visitedUrls: string[];
  /** Origins outside the home that a review allowed, with the reason given. */
  approvedOrigins: Map<string, string>;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface PageTools {
  tools: AgentLoopTool[];
  state: PageToolsState;
  /** Reads the page and remembers it as what the model has seen. */
  observe: () => Promise<ApplyFormObservation>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function ok(content: string, progress = false): AgentLoopToolOutcome {
  return { kind: "ok", content, progress };
}

export function createPageTools(
  hands: ApplyPageHands,
  policy: PageToolPolicy = {},
): PageTools {
  const state: PageToolsState = {
    observation: null,
    visitedUrls: [],
    approvedOrigins: new Map(),
  };
  const describe = policy.describe ?? describeObservation;

  /**
   * Whether the run may go to an address.
   *
   * Inside the home, always. Outside it, only with a specific reason that a
   * second judgement accepts against the goal; an origin accepted once stays
   * accepted for the run.
   */
  const authorize = async (
    url: string,
    reason: string | null,
  ): Promise<
    { allowed: true; note: string | null } | { allowed: false; refusal: string }
  > => {
    const refusal = policy.allowUrl?.(url) ?? null;
    if (!refusal) return { allowed: true, note: null };
    const origin = originOf(url);
    if (origin && state.approvedOrigins.has(origin)) {
      return { allowed: true, note: null };
    }
    if (!policy.reviewMove) return { allowed: false, refusal };
    if (!reason) {
      return {
        allowed: false,
        refusal: `${refusal} If going there serves the goal, call again with a reason that says exactly why: what you saw that points there and what you expect to find.`,
      };
    }
    let review: { allowed: boolean; verdict: string };
    try {
      review = await policy.reviewMove({
        url,
        reason,
        fromUrl: state.observation?.url ?? null,
      });
    } catch {
      return {
        allowed: false,
        refusal: `${refusal} The move could not be reviewed safely right now, so it was not allowed.`,
      };
    }
    if (!review.allowed) {
      return {
        allowed: false,
        refusal: `${refusal} A review of your reason did not allow it: ${review.verdict}`,
      };
    }
    if (origin) state.approvedOrigins.set(origin, reason);
    return {
      allowed: true,
      note: `Leaving the home site was allowed after review: ${review.verdict}`,
    };
  };

  const remember = (
    observation: ApplyFormObservation,
  ): ApplyFormObservation => {
    state.observation = observation;
    if (observation.url && !state.visitedUrls.includes(observation.url)) {
      state.visitedUrls.push(observation.url);
    }
    return observation;
  };
  const observe = async (): Promise<ApplyFormObservation> =>
    remember(await hands.observe());

  /**
   * After anything that may have moved the page: bring in a tab it opened,
   * check the address is allowed, and show the model where it is now.
   */
  const settle = async (
    lead: string,
    reason: string | null = null,
  ): Promise<AgentLoopToolOutcome> => {
    let observation = await observe();
    const notes: string[] = [lead];
    const newest = observation.openedTabs[observation.openedTabs.length - 1];
    if (newest && hands.adoptOpenedTab) {
      const adopted = await hands.adoptOpenedTab(newest.index);
      observation = await observe();
      notes.push(
        adopted.ok
          ? `That opened ${adopted.url} in a new tab. Job Finder works in one tab, so it opened that address here instead.`
          : `That tried to open a new tab, which could not be brought here: ${adopted.error}`,
      );
    }
    if (observation.url && policy.allowUrl) {
      const verdict = await authorize(observation.url, reason);
      if (!verdict.allowed) {
        const back = await hands.goBack();
        observation = await observe();
        notes.push(
          `${verdict.refusal}${back.ok ? " Job Finder went back." : ""}`,
        );
        return ok(
          `${notes.join(" ")}\n\nThe page now:\n\n${describe(observation)}`,
        );
      }
      if (verdict.note) notes.push(verdict.note);
    }
    return ok(
      `${notes.join(" ")}\n\nThe page now:\n\n${describe(observation)}`,
      true,
    );
  };

  const refuseIfMoved = async (
    seenSignature: string,
  ): Promise<AgentLoopToolOutcome | null> => {
    const current = await observe();
    if (seenSignature && current.signature !== seenSignature) {
      return ok(
        `The page changed since you last looked, so that step was not taken. Decide again from the page as it is now:\n\n${describe(current)}`,
      );
    }
    return null;
  };

  const tools: AgentLoopTool[] = [
    {
      definition: {
        type: "function",
        function: {
          name: "observe",
          description:
            "Look at the whole page: its address, headings, every visible field, every button, every link with where it goes, anything else clickable, tabs the page opened, and an excerpt of the text. Nothing is filtered — what a person could see, you can see. Start here and look again whenever the page changes.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => ok(describe(await observe())),
    },
    {
      definition: {
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
      execute: async (raw) => {
        const ref = asString(parseToolArguments(raw).ref);
        const text = await hands.readText(ref ?? undefined);
        return ok(text.slice(0, 20_000) || "That has no text.");
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "navigate",
          description:
            "Go to a web address: one you read on the page, or one you saw earlier.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string" },
              reason: {
                type: "string",
                description:
                  "If this leaves the site the run is on: exactly why it serves the goal, what on the page points there, and what you expect to find. A second review reads it.",
              },
            },
            required: ["url"],
          },
        },
      },
      execute: async (raw) => {
        const args = parseToolArguments(raw);
        const url = asString(args.url);
        if (!url) return ok("navigate needs a url.");
        if (/[<>{}]/u.test(url)) {
          return ok(
            `${url} is a pattern with a placeholder in it, not an address. Use a real address you read on the page, or press the link that leads there.`,
          );
        }
        const reason = asString(args.reason);
        const verdict = await authorize(url, reason);
        if (!verdict.allowed) return ok(verdict.refusal);
        const moved = await hands.navigate(url);
        if (!moved.ok) {
          return ok(
            `${url} would not open: ${moved.error}\n\nThe page now:\n\n${describe(await observe())}`,
          );
        }
        return settle(
          [`Opened ${moved.url}.`, verdict.note].filter(Boolean).join(" "),
          reason,
        );
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "follow_link",
          description:
            "Open what a link points at, in this same tab, whether or not the site wanted it in a new one. This is how you get from a listing to the form or page that belongs to it, including onto a different site.",
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
                  "If this leaves the site the run is on: exactly why it serves the goal, what on the page points there, and what you expect to find. A second review reads it.",
              },
            },
            required: ["ref"],
          },
        },
      },
      execute: async (raw) => {
        const args = parseToolArguments(raw);
        const ref = asString(args.ref);
        if (!ref) return ok("follow_link needs the link handle in ref.");
        const reason = asString(args.reason);
        const link = state.observation?.links.find(
          (entry) => entry.ref === ref,
        );
        let allowedNote: string | null = null;
        if (link) {
          const verdict = await authorize(link.href, reason);
          if (!verdict.allowed) return ok(verdict.refusal);
          allowedNote = verdict.note;
        }
        const moved = await hands.followLink(ref);
        if (!moved.ok) {
          return ok(
            `That link would not open: ${moved.error}\n\nThe page now:\n\n${describe(await observe())}`,
          );
        }
        return settle(
          [
            `Followed ${link?.label ? `"${link.label}"` : "the link"} to ${moved.url}.`,
            allowedNote,
          ]
            .filter(Boolean)
            .join(" "),
          reason,
        );
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "click",
          description:
            "Press anything on the page: a button, a link, a card, a tab, a cookie banner's Accept, the close cross on a chat widget. If a person could click it, you can.",
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
                  "If this leaves the site the run is on: exactly why it serves the goal, what on the page points there, and what you expect to find. A second review reads it.",
              },
            },
            required: ["ref"],
          },
        },
      },
      execute: async (raw) => {
        const args = parseToolArguments(raw);
        const ref = asString(args.ref);
        if (!ref) return ok("click needs the handle of what to press in ref.");
        const reason = asString(args.reason);
        const seen = state.observation;
        const moved = await refuseIfMoved(seen?.signature ?? "");
        if (moved) return moved;
        const label =
          seen?.actions.find((entry) => entry.ref === ref)?.label ??
          seen?.links.find((entry) => entry.ref === ref)?.label ??
          seen?.clickables.find((entry) => entry.ref === ref)?.label ??
          ref;
        const pressed = await hands.clickElement(ref);
        if (!pressed.ok) {
          return ok(
            `"${label}" would not press: ${pressed.error}\n\nThe page now:\n\n${describe(await observe())}`,
          );
        }
        const before = seen?.signature ?? "";
        const outcome = await settle(`Pressed "${label}".`, reason);
        // A press that changed nothing on the page is not progress, and the
        // model is told so rather than left to press it again.
        if (
          outcome.kind === "ok" &&
          outcome.progress === true &&
          state.observation &&
          state.observation.signature === before
        ) {
          // Reuse the view settle already wrote: describing the page twice
          // would let a host's "unchanged" note point at a view never sent.
          const marker = "\n\nThe page now:\n\n";
          const at = outcome.content.indexOf(marker);
          const view =
            at >= 0
              ? outcome.content.slice(at + marker.length)
              : describe(state.observation);
          return ok(
            `Pressed "${label}", and the page did not change. If it should have, something may be covering it or it may need a moment; otherwise try another way.${marker}${view}`,
          );
        }
        return outcome;
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "press_key",
          description:
            "Press a keyboard key on an element or on the active page. Use this for Enter, Escape, Tab, arrow keys, and controls that only respond to the keyboard.",
          parameters: {
            type: "object",
            properties: {
              ref: {
                type: "string",
                description:
                  "Optional handle from observe. Omit to press the key on the active page.",
              },
              key: {
                type: "string",
                description:
                  "A Playwright keyboard key such as Enter, Escape, Tab, ArrowDown, or Shift+Tab.",
              },
            },
            required: ["key"],
          },
        },
      },
      execute: async (raw) => {
        const args = parseToolArguments(raw);
        const ref = asString(args.ref);
        const key = asString(args.key);
        if (!key) return ok("press_key needs a key.");
        if (!hands.pressKey) {
          return ok("This browser cannot press keyboard keys yet.");
        }
        const moved = await refuseIfMoved(state.observation?.signature ?? "");
        if (moved) return moved;
        const pressed = await hands.pressKey(ref ?? undefined, key);
        if (!pressed.ok) {
          return ok(`The ${key} key would not respond: ${pressed.error}`);
        }
        return settle(`Pressed ${key}${ref ? ` on ${ref}` : ""}.`);
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "type",
          description: "Type into a field, replacing what is there.",
          parameters: {
            type: "object",
            properties: {
              ref: { type: "string" },
              text: { type: "string" },
            },
            required: ["ref", "text"],
          },
        },
      },
      execute: async (raw) => {
        const args = parseToolArguments(raw);
        const ref = asString(args.ref);
        const text = typeof args.text === "string" ? args.text : null;
        if (!ref || text === null) return ok("type needs ref and text.");
        const moved = await refuseIfMoved(state.observation?.signature ?? "");
        if (moved) return moved;
        const written = await hands.fillText(ref, text);
        if (!written.ok) {
          return ok(`The field would not take that: ${written.error}`);
        }
        const before = state.observation!;
        await hands.wait(TEXT_RETENTION_MS);
        const after = await observe();
        const control = before.controls.find((entry) => entry.ref === ref);
        const error = control
          ? textRetentionError(before, after, control, text)
          : "The field is no longer on this page.";
        if (error) return ok(`The field would not take that: ${error}`);
        return ok(
          `Typed into ${ref}. The page now:\n\n${describe(after)}`,
          true,
        );
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "select",
          description:
            "Choose an option in a list or dropdown by its exact label.",
          parameters: {
            type: "object",
            properties: {
              ref: { type: "string" },
              option: { type: "string" },
            },
            required: ["ref", "option"],
          },
        },
      },
      execute: async (raw) => {
        const args = parseToolArguments(raw);
        const ref = asString(args.ref);
        const option = asString(args.option);
        if (!ref || !option) return ok("select needs ref and option.");
        const moved = await refuseIfMoved(state.observation?.signature ?? "");
        if (moved) return moved;
        const chosen = await hands.chooseOption(ref, option);
        if (!chosen.ok) {
          return ok(`The list did not take "${option}": ${chosen.error}`);
        }
        return ok(
          `Chose "${option}" in ${ref}. The page now:\n\n${describe(await observe())}`,
          true,
        );
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "set_checkbox",
          description: "Tick or untick a checkbox or radio.",
          parameters: {
            type: "object",
            properties: {
              ref: { type: "string" },
              checked: { type: "boolean" },
            },
            required: ["ref", "checked"],
          },
        },
      },
      execute: async (raw) => {
        const args = parseToolArguments(raw);
        const ref = asString(args.ref);
        if (!ref) return ok("set_checkbox needs ref.");
        const moved = await refuseIfMoved(state.observation?.signature ?? "");
        if (moved) return moved;
        const set = await hands.setToggle(ref, args.checked !== false);
        if (!set.ok) return ok(`The box would not change: ${set.error}`);
        return ok(
          `${args.checked !== false ? "Ticked" : "Unticked"} ${ref}. The page now:\n\n${describe(await observe())}`,
          true,
        );
      },
    },
    {
      definition: {
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
      execute: async (raw) => {
        const direction = asString(parseToolArguments(raw).direction) ?? "down";
        const allowed = ["down", "up", "top", "bottom"] as const;
        const chosen = allowed.find((entry) => entry === direction) ?? "down";
        await hands.scroll(chosen);
        return ok(
          `Scrolled ${chosen}. The page now:\n\n${describe(await observe())}`,
        );
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "wait",
          description:
            "Wait for a page that is still settling, then look again.",
          parameters: {
            type: "object",
            properties: {
              milliseconds: {
                type: "number",
                description:
                  "Up to 30000. A page checking the browser by itself can take a minute or two: wait 20000 to 30000 at a time.",
              },
            },
          },
        },
      },
      execute: async (raw) => {
        const requested = parseToolArguments(raw).milliseconds;
        const milliseconds =
          typeof requested === "number"
            ? Math.max(0, Math.min(30_000, requested))
            : 1_000;
        await hands.wait(milliseconds);
        return ok(
          `Waited ${Math.round(milliseconds)}ms. The page now:\n\n${describe(await observe())}`,
        );
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "go_back",
          description: "Go back, when a link turned out to be the wrong way.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => {
        const back = await hands.goBack();
        if (!back.ok) {
          return ok(
            `Could not go back: ${back.error}\n\nThe page now:\n\n${describe(await observe())}`,
          );
        }
        return settle(`Went back to ${back.url}.`);
      },
    },
  ];

  return {
    tools: tools.map((tool) => ({
      ...tool,
      failureKind: "browser" as const,
      describeError: (error: unknown) =>
        describeBrowserError(error, "The browser did not respond."),
    })),
    state,
    observe,
  };
}
