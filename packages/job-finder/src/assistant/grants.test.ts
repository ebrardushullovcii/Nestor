import { describe, expect, it } from "vitest";
import {
  AssistantInstructionGrantSchema,
  AssistantMessageSchema,
  AssistantResultSetSchema,
  type AssistantInstructionGrant,
} from "@nestor/contracts";

import { checkGrantTargets, decideUnderGrants, narrowGrant } from "./grants";

const at = (minute: number) =>
  `2026-09-27T10:${String(minute).padStart(2, "0")}:00.000Z`;

function grant(
  overrides: Partial<AssistantInstructionGrant>,
): AssistantInstructionGrant {
  return AssistantInstructionGrantSchema.parse({
    id: "grant_1",
    conversationId: "conv_1",
    sourceMessageId: "msg_1",
    action: "prepare_and_send",
    jobIds: ["job_a", "job_b"],
    status: "active",
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  });
}

function message(context: unknown) {
  return AssistantMessageSchema.parse({
    id: "msg_1",
    conversationId: "conv_1",
    role: "user",
    origin: "sidebar",
    parts: [{ type: "text", text: "Apply to these and send them" }],
    context,
    createdAt: at(0),
  });
}

describe("checkGrantTargets", () => {
  it("accepts jobs from the message's screen context and rejects others", () => {
    const result = checkGrantTargets({
      requestedJobIds: ["job_a", "job_b", "job_elsewhere"],
      authorizingMessage: message({
        screen: "discovery",
        focus: { kind: "job", id: "job_a", label: "A" },
        list: {
          listKind: "jobs",
          selectedIds: ["job_a"],
          displayedIds: ["job_a", "job_b"],
          filteredIds: ["job_a", "job_b"],
          totalFilteredCount: 2,
        },
        capturedAt: at(0),
      }),
      resultSets: [],
    });
    expect(result.accepted).toEqual(["job_a", "job_b"]);
    expect(result.rejected).toEqual(["job_elsewhere"]);
  });

  it("accepts jobs from result sets the conversation produced", () => {
    const result = checkGrantTargets({
      requestedJobIds: ["job_found"],
      authorizingMessage: message(null),
      resultSets: [
        AssistantResultSetSchema.parse({
          id: "rs_1",
          conversationId: "conv_1",
          kind: "jobs",
          label: "Search results",
          itemIds: ["job_found"],
          source: "tool_query",
          createdAt: at(0),
        }),
      ],
    });
    expect(result.accepted).toEqual(["job_found"]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects everything when the message had no context and no result sets", () => {
    const result = checkGrantTargets({
      requestedJobIds: ["job_a"],
      authorizingMessage: message(null),
      resultSets: [],
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual(["job_a"]);
  });
});

describe("decideUnderGrants", () => {
  it("lets a send instruction send, even when the saved mode is Prepare for me", () => {
    const [decision] = decideUnderGrants({
      grants: [grant({})],
      jobIds: ["job_a"],
      action: "send",
      savedMode: "prepare_only",
    });
    expect(decision?.allowed).toBe(true);
    expect(decision?.mode).toBe("autonomous_submit");
  });

  it("blocks sending under a prepare-only instruction", () => {
    const [decision] = decideUnderGrants({
      grants: [grant({ action: "prepare" })],
      jobIds: ["job_a"],
      action: "send",
      savedMode: "autonomous_submit",
    });
    expect(decision?.allowed).toBe(false);
    expect(decision?.mode).toBe("prepare_only");
  });

  it("blocks sending under 'use my saved mode' when that mode is Prepare for me", () => {
    const [decision] = decideUnderGrants({
      grants: [grant({ action: "apply_saved_mode" })],
      jobIds: ["job_a"],
      action: "send",
      savedMode: "prepare_only",
    });
    expect(decision?.allowed).toBe(false);
  });

  it("refuses jobs no live grant covers and says when one was withdrawn", () => {
    const decisions = decideUnderGrants({
      grants: [grant({ status: "revoked" })],
      jobIds: ["job_a", "job_z"],
      action: "prepare",
      savedMode: "prepare_only",
    });
    expect(decisions.map((entry) => entry.allowed)).toEqual([false, false]);
    expect(decisions[0]?.reason).toMatch(/withdrew/u);
    expect(decisions[1]?.reason).toMatch(/Record their instruction/u);
  });

  it("lets the newest live grant decide, so a later 'prepare only' narrows an earlier send", () => {
    const decisions = decideUnderGrants({
      grants: [
        grant({
          id: "grant_old",
          action: "prepare_and_send",
          updatedAt: at(1),
        }),
        grant({
          id: "grant_new",
          action: "prepare",
          jobIds: ["job_a"],
          updatedAt: at(5),
        }),
      ],
      jobIds: ["job_a", "job_b"],
      action: "send",
      savedMode: "prepare_only",
    });
    expect(decisions[0]).toMatchObject({
      allowed: false,
      grantId: "grant_new",
    });
    expect(decisions[1]).toMatchObject({ allowed: true, grantId: "grant_old" });
  });
});

describe("narrowGrant", () => {
  it("only ever weakens the action and records the change", () => {
    const narrowed = narrowGrant(grant({ action: "prepare" }), {
      action: "prepare_and_send",
      messageId: "msg_2",
      description: "Tried to strengthen",
      at: at(3),
    });
    expect(narrowed.action).toBe("prepare");
    expect(narrowed.status).toBe("narrowed");
    expect(narrowed.history.at(-1)?.change).toBe("Tried to strengthen");
  });

  it("revokes when every job is removed", () => {
    const narrowed = narrowGrant(grant({}), {
      removeJobIds: ["job_a", "job_b"],
      messageId: "msg_2",
      description: "Don't apply to those",
      at: at(3),
    });
    expect(narrowed.status).toBe("revoked");
  });
});
