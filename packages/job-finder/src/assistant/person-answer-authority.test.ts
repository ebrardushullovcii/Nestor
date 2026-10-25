import { describe, expect, it, vi } from "vitest";
import { AssistantMessageSchema } from "@nestor/contracts";
import { verifyPersonAnswerAuthority } from "./person-answer-authority";
import { editProfileTool } from "./tools/profile-tools";
import { createWorkspaceServiceHarness } from "../workspace-service.test-support";
import type { AssistantTurnSession } from "./tool-kit";
import type { AssistantHostPorts } from "./ports";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  origin: "sidebar" | "host" = "sidebar",
) {
  return AssistantMessageSchema.parse({
    id,
    conversationId: "conversation",
    role,
    origin,
    parts: [{ type: "text", text }],
    createdAt: "2026-10-05T10:00:00.000Z",
  });
}
const answers = [
  { question: "Years of analysis experience", answer: "0" },
  { question: "Years of coordination experience", answer: "0" },
];

describe("the person's answer authority", () => {
  it("rejects agent-chosen zeroes even when the person asked to apply", async () => {
    const sourceMessage = message("person", "user", "Apply to Ledgerleaf.");
    const judge = vi.fn((prompt: string) => {
      expect(prompt).toContain("ownership, not factual grounding");
      expect(prompt).toContain("Years of analysis experience");
      return Promise.resolve(
        JSON.stringify({
          answers: [
            { index: 0, personMessageIds: [] },
            { index: 1, personMessageIds: [] },
          ],
          reuseMessageIds: [],
        }),
      );
    });
    await expect(
      verifyPersonAnswerAuthority({
        answers,
        saveForFuture: true,
        sourceMessage,
        messages: [
          message("agent", "assistant", "I filled in 0 years for both."),
          sourceMessage,
        ],
        judge,
      }),
    ).rejects.toThrow("give or approve");
  });
  it("allows an explicit approval of the proposed zeroes and future reuse", async () => {
    const sourceMessage = message(
      "person",
      "user",
      "Yes, use those zeroes and save them for next time.",
    );
    await expect(
      verifyPersonAnswerAuthority({
        answers,
        saveForFuture: true,
        sourceMessage,
        messages: [
          message(
            "agent",
            "assistant",
            "May I use 0 analysis years and 0 coordination years?",
          ),
          sourceMessage,
        ],
        judge: () =>
          Promise.resolve(
            JSON.stringify({
              answers: [
                { index: 0, personMessageIds: ["person"] },
                { index: 1, personMessageIds: ["person"] },
              ],
              reuseMessageIds: ["person"],
            }),
          ),
      }),
    ).resolves.toBeUndefined();
  });
  it("does not promote one-use answers when reuse was never approved", async () => {
    const sourceMessage = message(
      "person",
      "user",
      "Use 0 for both on this application only.",
    );
    const input = {
      answers,
      sourceMessage,
      messages: [sourceMessage],
      judge: () =>
        Promise.resolve(
          JSON.stringify({
            answers: [
              { index: 0, personMessageIds: ["person"] },
              { index: 1, personMessageIds: ["person"] },
            ],
            reuseMessageIds: [],
          }),
        ),
    };
    await expect(
      verifyPersonAnswerAuthority({ ...input, saveForFuture: false }),
    ).resolves.toBeUndefined();
    await expect(
      verifyPersonAnswerAuthority({ ...input, saveForFuture: true }),
    ).rejects.toThrow("give or approve");
  });
  it("rejects assistant or host citations, incomplete checks, and unavailable checks", async () => {
    const sourceMessage = message("person", "user", "Apply.");
    for (const personMessageIds of [["agent"], ["host"], ["missing"]]) {
      await expect(
        verifyPersonAnswerAuthority({
          answers: answers.slice(0, 1),
          saveForFuture: false,
          sourceMessage,
          messages: [
            message("agent", "assistant", "0"),
            message("host", "user", "0", "host"),
          ],
          judge: () =>
            Promise.resolve(
              JSON.stringify({
                answers: [{ index: 0, personMessageIds }],
                reuseMessageIds: [],
              }),
            ),
        }),
      ).rejects.toThrow("give or approve");
    }
    await expect(
      verifyPersonAnswerAuthority({
        answers,
        saveForFuture: false,
        sourceMessage,
        messages: [],
        judge: null,
      }),
    ).rejects.toThrow("give or approve");
  });
  it("leaves Profile unchanged when an assistant tries to remember an unapproved zero", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const before = (await workspaceService.getWorkspaceSnapshot()).profile;
    const session = {
      assertCurrent: () => undefined,
      assertPersonAnswerAuthority: () =>
        Promise.reject(new Error("Ask the person to approve this answer.")),
    } as unknown as AssistantTurnSession;
    await expect(
      editProfileTool.execute(
        editProfileTool.input.parse({
          summary: "Save zero analysis years",
          operations: [
            {
              operation: "upsert_reusable_answer",
              record: {
                kind: "other",
                label: answers[0]!.question,
                question: answers[0]!.question,
                answer: "0",
              },
            },
          ],
        }),
        {
          service: workspaceService,
          session,
          ports: {
            publishWorkspaceUpdate: vi.fn(),
          } as unknown as AssistantHostPorts,
        },
      ),
    ).rejects.toThrow("Needs you");
    expect((await workspaceService.getWorkspaceSnapshot()).profile).toEqual(
      before,
    );
  });
});
