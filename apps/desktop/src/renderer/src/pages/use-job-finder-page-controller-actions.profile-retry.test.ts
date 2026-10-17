import { expect, test, vi } from "vitest";
import type {
  JobFinderRendererWorkspaceSnapshot,
  ProfileCopilotMessage,
} from "@nordri/contracts";
import type { JobFinderShellActions } from "@renderer/features/job-finder/lib/job-finder-types";
import { createPrimaryPageActions } from "./use-job-finder-page-controller-actions";

const question: ProfileCopilotMessage = {
  id: "saved-question",
  role: "user",
  content: "What does amber-review mean?",
  context: { surface: "profile", section: "basics" },
  patchGroups: [],
  createdAt: "2020-01-01T00:00:00.000Z",
};

test.each([
  {
    label: "old unanswered question",
    messages: [question],
    content: question.content,
    optimistic: false,
  },
  {
    label: "new question",
    messages: [question],
    content: "A different question",
    optimistic: true,
  },
  {
    label: "already answered question",
    messages: [
      question,
      {
        ...question,
        id: "answer",
        role: "assistant" as const,
        content: "An answer",
      },
    ],
    content: question.content,
    optimistic: true,
  },
  {
    label: "question in another context",
    messages: [{ ...question, context: { surface: "general" as const } }],
    content: question.content,
    optimistic: true,
  },
])(
  "preserves transcript identity for $label",
  async ({ messages, content, optimistic }) => {
    let release!: () => void;
    const request = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendProfileCopilotMessage = vi.fn(() => request);
    const setOptimisticProfileCopilotMessages = vi.fn();
    const setProfileCopilotBusy = vi.fn();
    // The newest hydrated snapshot owns the question; the action's captured
    // snapshot may predate the failed request.
    const workspace = {
      profileCopilotMessages: [],
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    const latest = {
      profileCopilotMessages: messages,
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    type Args = Parameters<typeof createPrimaryPageActions>[0];
    const args = {
      actions: {
        sendProfileCopilotMessage,
      } as unknown as JobFinderShellActions,
      workspace,
      latestWorkspaceRef: { current: latest },
      profileCopilotRequestTokenRef: { current: 0 },
      setOptimisticProfileCopilotMessages,
      setProfileCopilotBusy,
      setProfileCopilotPendingContextKey: vi.fn(),
      setActionState: vi.fn(),
    } satisfies Pick<
      Args,
      | "actions"
      | "workspace"
      | "latestWorkspaceRef"
      | "profileCopilotRequestTokenRef"
      | "setOptimisticProfileCopilotMessages"
      | "setProfileCopilotBusy"
      | "setProfileCopilotPendingContextKey"
      | "setActionState"
    >;
    const pending = createPrimaryPageActions(
      args as unknown as Args,
    ).onSendProfileCopilotMessage(content, question.context);
    expect(setOptimisticProfileCopilotMessages).toHaveBeenCalledTimes(
      optimistic ? 1 : 0,
    );
    expect(setProfileCopilotBusy).toHaveBeenLastCalledWith(true);
    expect(sendProfileCopilotMessage).toHaveBeenCalledWith(
      content,
      question.context,
    );
    expect(latest.profileCopilotMessages).toEqual(messages);
    release();
    await expect(pending).resolves.toBe(true);
    expect(setProfileCopilotBusy).toHaveBeenLastCalledWith(false);
  },
);
