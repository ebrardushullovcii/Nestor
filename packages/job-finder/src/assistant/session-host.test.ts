import {
  AssistantConversationSchema,
  AssistantMessageSchema,
  AssistantProposalSchema,
  ApplicationPrivacyReceiptSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
  type AssistantContextReference,
  type AssistantEvent,
  type AssistantMessage,
  type UserActionRequest,
} from "@nestor/contracts";
import { createAssistantRepository } from "@nestor/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import { createScriptedAssistantModelHandle } from "./model-handle";
import type { AssistantHostPorts } from "./ports";
import type { AssistantTurnSession } from "./tool-kit";
import {
  availablePromptTokens,
  createTokenCalibrator,
  estimateJsonTokens,
  estimateTokens,
} from "@nestor/agent-runtime";

import { assembleModelInput } from "./context-assembly";
import { ASSISTANT_SYSTEM_PROMPT, buildProfileDigest } from "./prompt";
import { buildAssistantToolCatalog } from "./tools";
import {
  AssistantSessionHost,
  type AssistantModelHandle,
} from "./session-host";

function context(
  overrides: Partial<AssistantContextReference> = {},
): AssistantContextReference {
  return {
    screen: "profile",
    route: "/job-finder/profile",
    sectionLabel: null,
    focus: null,
    list: null,
    editor: null,
    browser: null,
    selectedText: null,
    mentions: [],
    attachments: [],
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createPorts(): AssistantHostPorts & {
  started: { jobIds: readonly string[]; mode: string }[];
  sent: string[][];
} {
  const started: { jobIds: readonly string[]; mode: string }[] = [];
  const sent: string[][] = [];
  return {
    started,
    sent,
    checkSource: () => Promise.resolve(),
    listDocuments: () => Promise.resolve([]),
    readDocumentText: () => Promise.resolve(null),
    loadDocumentFile: () =>
      Promise.resolve({
        name: "x",
        mimeType: "text/plain",
        bytes: new Uint8Array(),
      }),
    importResumeDocument: () => Promise.resolve(),
    publishWorkspaceUpdate: () => undefined,
  };
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function applicationHandoff() {
  const seed = createSeed();
  const at = "2026-09-28T03:00:00.000Z";
  const run = ApplyRunSchema.parse({
    id: "run_person_handoff",
    state: "completed",
    jobIds: ["job_ready"],
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    summary: "Sign in to continue.",
    detail: "The application is parked for sign-in.",
    totalJobs: 1,
    blockedJobs: 1,
  });
  const result = ApplyJobResultSchema.parse({
    id: "result_person_handoff",
    runId: run.id,
    jobId: "job_ready",
    state: "awaiting_review",
    summary: run.summary,
    detail: run.detail,
    startedAt: at,
    updatedAt: at,
    blockerReason: "auth_required",
    blockerSummary:
      "Sign in to the existing application; nothing has been sent.",
  });
  const request = UserActionRequestSchema.parse({
    id: "request_login",
    dedupeKey: "application-login",
    revision: 1,
    kind: "login",
    state: "awaiting_user",
    scope: {
      type: "application",
      runId: run.id,
      jobId: result.jobId,
      resultId: result.id,
      source: "target_site",
    },
    verification: {
      type: "page_blocker_absent",
      blockerFingerprint: "login-form",
    },
    title: "Sign in to continue",
    summary: result.blockerSummary,
    createdAt: at,
    updatedAt: at,
  });
  seed.applyRuns = [run];
  seed.applyJobResults = [result];
  seed.userActionRequests = [request];
  return { seed, run, result, request };
}

function userActionTransition(
  request: UserActionRequest,
  state: "verifying" | "resolved",
) {
  const at = new Date().toISOString();
  const next = UserActionRequestSchema.parse({
    ...request,
    revision: request.revision + 1,
    state,
    updatedAt: at,
    resolvedAt: state === "resolved" ? at : null,
  });
  return {
    request: next,
    event: UserActionEventSchema.parse({
      id: `${request.id}_${next.revision}`,
      requestId: request.id,
      operation:
        state === "resolved" ? "verification_succeeded" : "confirm_done",
      previousRevision: request.revision,
      resultingRevision: next.revision,
      previousState: request.state,
      resultingState: state,
      occurredAt: at,
    }),
  };
}

function submittedResult(
  result: ReturnType<typeof applicationHandoff>["result"],
) {
  const at = new Date().toISOString();
  const destination = {
    origin: "https://replica.example.test",
    safePath: "/receipt",
  };
  const applicationRecordId = "application_confirmed";
  return ApplyJobResultSchema.parse({
    ...result,
    state: "submitted",
    applicationRecordId,
    updatedAt: at,
    completedAt: at,
    blockerReason: null,
    blockerSummary: null,
    privacyReceipt: ApplicationPrivacyReceiptSchema.parse({
      generatedAt: at,
      lineage: {
        runId: result.runId,
        jobId: result.jobId,
        resultId: result.id,
        applicationRecordId,
      },
      destination,
      resume: { source: "original_upload", fileName: "synthetic-resume.pdf" },
      finalSubmitOccurred: true,
      submissionOutcome: {
        id: "outcome_confirmed",
        preflightId: "preflight_confirmed",
        idempotencyKey: "send_once",
        authorityEnvelopeId: "authority_confirmed",
        authorityRevision: 1,
        runId: result.runId,
        jobId: result.jobId,
        resultId: result.id,
        applicationRecordId,
        outcome: "submitted",
        attemptedAt: at,
        verifiedAt: at,
        evidence: [
          {
            id: "receipt_visible",
            kind: "employer_site_state",
            observedAt: at,
            destination,
            artifactRefId: null,
            summary: "The employer page confirmed receipt.",
          },
        ],
        retry: { eligible: false, blockReason: "submission_confirmed" },
      },
    }),
  });
}

async function installApplicationWatch(
  host: AssistantSessionHost,
  conversationId: string,
  options: {
    kind?: "apply_run" | "apply_batch";
    resumed?: boolean;
    sourceMessageId?: string;
  } = {},
) {
  const input = {
    conversationId,
    run: {
      kind: options.kind ?? "apply_run",
      id: "run_person_handoff",
      jobIds: ["job_ready"],
    },
    note: "Applying to the existing job",
    sourceMessageId: options.sourceMessageId ?? null,
    turnId: "turn_initial_apply",
    resumed: options.resumed,
  };
  await (
    host as unknown as { watch: (value: typeof input) => Promise<void> }
  ).watch(input);
}

describe("assistant session host", () => {
  const hosts: AssistantSessionHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.shutdown();
  });

  function setup(
    options: {
      delayMs?: number;
      budgetOverrideTokens?: number;
      seed?: ReturnType<typeof createSeed>;
      modelHandle?: AssistantModelHandle;
    } = {},
  ) {
    const harness = createWorkspaceServiceHarness(
      options.seed ? { seed: options.seed } : {},
    );
    const repository = createAssistantRepository({ filePath: ":memory:" });
    const ports = createPorts();
    const events: AssistantEvent[] = [];
    const handle =
      options.modelHandle ??
      createScriptedAssistantModelHandle(
        options.delayMs !== undefined ? { delayMs: options.delayMs } : {},
      );
    const host = new AssistantSessionHost({
      repository,
      service: harness.workspaceService,
      ports,
      resolveModel: () => ({ kind: "ready", handle }),
      publish: (event) => events.push(event),
      budgetOverrideTokens: options.budgetOverrideTokens ?? null,
      stallAfterMs: 60_000,
      watchIntervalMs: 50,
      log: () => undefined,
    });
    hosts.push(host);
    return { harness, repository, ports, events, host };
  }

  async function sendAndWait(
    host: AssistantSessionHost,
    text: string,
    ctx: AssistantContextReference = context(),
    conversationId: string | null = null,
  ) {
    const result = await host.sendMessage({
      conversationId,
      clientMessageId: `client_${Math.random().toString(36).slice(2)}`,
      text,
      context: ctx,
    });
    await waitFor(
      () => host.readConversation({ conversationId: result.conversationId }),
      (view) => view.activeTurn === null,
    );
    return result;
  }

  it("loads off-screen profile tools and refreshes facts without changing the system prefix", async () => {
    const systems: string[] = [];
    const offered: string[][] = [];
    const userInputs: string[] = [];
    let step = 0;
    const world = setup({
      modelHandle: {
        ...createScriptedAssistantModelHandle(),
        createModel: () => ({
          chatWithTools(messages, definitions) {
            systems.push(messages[0]!.content);
            offered.push(
              definitions.map((definition) => definition.function.name),
            );
            userInputs.push(
              messages.filter((message) => message.role === "user").at(-1)!
                .content,
            );
            const actions = [
              {
                name: "load_tools",
                arguments: JSON.stringify({ groups: ["profile", "files"] }),
              },
              {
                name: "edit_profile",
                arguments: JSON.stringify({
                  summary: "Change headline",
                  mode: "apply",
                  operations: [
                    {
                      operation: "replace_identity_fields",
                      value: { headline: "Synthetic engineer" },
                    },
                  ],
                }),
              },
            ];
            const action = actions[step++];
            return Promise.resolve(
              action
                ? {
                    toolCalls: [
                      {
                        id: `call_${step}`,
                        type: "function" as const,
                        function: action,
                      },
                    ],
                  }
                : { content: "Your headline is saved. Undo is available." },
            );
          },
        }),
      },
    });
    const sent = await sendAndWait(
      world.host,
      "Change my headline to Synthetic engineer",
      context({ screen: "home" }),
    );
    expect(offered[0]).toContain("load_tools");
    expect(offered[0]).not.toContain("edit_profile");
    expect(offered[0]).not.toContain("import_resume");
    expect(offered[1]).toContain("import_resume");
    expect(offered[1]).toContain("edit_profile");
    expect(offered[2]).toContain("edit_profile");
    expect(new Set(systems)).toEqual(new Set([ASSISTANT_SYSTEM_PROMPT]));
    expect(userInputs[2]).toContain("Headline: Synthetic engineer");
    const view = await world.host.readConversation({
      conversationId: sent.conversationId,
    });
    const change = view.messages
      .at(-1)!
      .parts.find((part) => part.type === "change");
    expect(change?.type).toBe("change");
    if (change?.type !== "change") throw new Error("Expected Undo receipt");
    await world.host.undoChange(sent.conversationId, change.receiptId);
    expect(
      (await world.harness.workspaceService.getWorkspaceSnapshot()).profile
        .headline,
    ).not.toBe("Synthetic engineer");
  });

  it.each(["candidate-assets:delete", "reset-workspace"])(
    "accepts %s once, with confirmation saved before a workspace replacement",
    async (actionId) => {
      const { host, repository, ports } = setup();
      const conversation = await host.createConversation();
      const proposal = AssistantProposalSchema.parse({
        id: "proposal",
        conversationId: conversation.id,
        messageId: "proposal_message",
        kind: "job_finder_action",
        summary: "Confirm action",
        items: [
          {
            id: "item",
            label: "Confirm action",
            payload: {
              actionId,
              input: actionId === "reset-workspace" ? {} : { assetId: "asset" },
            },
          },
        ],
        createdAt: new Date().toISOString(),
      });
      await repository.upsertProposal(proposal);
      await repository.upsertMessage(
        AssistantMessageSchema.parse({
          id: "proposal_message",
          conversationId: conversation.id,
          role: "assistant",
          origin: "sidebar",
          parts: [
            {
              type: "proposal",
              proposalId: proposal.id,
              kind: proposal.kind,
              summary: proposal.summary,
              status: "pending",
              source: { store: "assistant" },
            },
          ],
          createdAt: new Date().toISOString(),
        }),
      );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const execute = vi.fn(async () => {
        if (actionId === "reset-workspace")
          expect((await repository.getProposal(proposal.id))?.status).toBe(
            "applied",
          );
        await gate;
        return true;
      });
      ports.executeAction = execute;
      const input = {
        conversationId: conversation.id,
        messageId: "proposal_message",
        proposalId: proposal.id,
        action: "accept" as const,
      };
      const first = host.resolveProposal(input);
      const second = host.resolveProposal(input);
      await waitFor(
        () => execute.mock.calls.length,
        (count) => count === 1,
      );
      release();
      await Promise.all([first, second]);
      expect(execute).toHaveBeenCalledTimes(1);
      await host.resolveProposal(input);
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await repository.getProposal(proposal.id))?.status).toBe(
        "applied",
      );
    },
  );

  it("persists the exact proposed summary on its review card", async () => {
    let calls = 0;
    const proposed =
      "Synthetic designer for senior in-house roles. Improved a synthetic result by 23%.";
    const { host } = setup({
      modelHandle: {
        ...createScriptedAssistantModelHandle(),
        createModel: () => ({
          chatWithTools: () => {
            calls += 1;
            return Promise.resolve(
              calls === 1
                ? {
                    content: "",
                    toolCalls: [
                      {
                        id: "suggest_summary",
                        type: "function" as const,
                        function: {
                          name: "edit_profile",
                          arguments: JSON.stringify({
                            mode: "suggest",
                            summary: "Rewrite your summary",
                            operations: [
                              {
                                operation:
                                  "replace_professional_summary_fields",
                                value: { fullSummary: proposed },
                              },
                            ],
                          }),
                        },
                      },
                    ],
                  }
                : { content: "The wording is ready to review." },
            );
          },
        }),
      },
    });
    const sent = await sendAndWait(host, "Propose a summary.");
    const view = await host.readConversation({
      conversationId: sent.conversationId,
    });
    const card = view.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "proposal");
    expect(card).toMatchObject({
      type: "proposal",
      items: [
        {
          label: "Update summary",
          detail: expect.stringContaining(proposed) as unknown,
        },
      ],
    });
  });

  it("clears streamed commentary before publishing its shortened progress note", async () => {
    const text = "Reading the profile before changing it. ".repeat(40);
    let calls = 0;
    const { host, events } = setup({
      modelHandle: {
        ...createScriptedAssistantModelHandle(),
        createModel: () => ({
          chatWithTools: (_messages, _tools, options) => {
            calls += 1;
            if (calls > 1) return Promise.resolve({ content: "Done." });
            options?.onStreamEvent?.({ type: "attempt_started", attempt: 1 });
            options?.onStreamEvent?.({ type: "text_delta", text });
            return Promise.resolve({
              content: text,
              toolCalls: [
                {
                  id: "read_profile_for_commentary",
                  type: "function",
                  function: { name: "read_profile", arguments: "{}" },
                },
              ],
            });
          },
        }),
      },
    });
    await sendAndWait(host, "Read my profile.");
    const index = events.findIndex(
      (event) => event.payload.type === "progress",
    );
    expect(index).toBeGreaterThan(0);
    expect(events[index]?.payload).toEqual({
      type: "progress",
      text: text.trim().slice(0, 1_000).trim(),
    });
    expect(events[index - 1]?.payload).toMatchObject({
      type: "text_delta",
      text: "",
    });
  });

  function reply(messages: readonly AssistantMessage[]): AssistantMessage {
    return messages.filter((message) => message.role === "assistant").at(-1)!;
  }

  it("applies a requested profile edit at once, with a change receipt and Undo", async () => {
    const { host, harness, events } = setup();
    const { conversationId } = await sendAndWait(
      host,
      "Change my headline to Staff platform designer",
    );
    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    expect(snapshot.profile.headline).toBe("Staff platform designer");
    const view = await host.readConversation({ conversationId });
    const last = reply(view.messages);
    const change = last.parts.find((part) => part.type === "change");
    expect(change).toMatchObject({
      type: "change",
      status: "applied",
      target: "profile",
    });
    const lastText = last.parts.find((part) => part.type === "text");
    expect(lastText?.type === "text" ? lastText.text : "").toContain(
      "Staff platform designer",
    );
    expect(events.some((event) => event.payload.type === "activity")).toBe(
      true,
    );
    // The revision log shows it as an assistant change.
    expect(
      snapshot.profileRevisions.at(-1)?.reason ??
        snapshot.profileRevisions[0]?.reason,
    ).toMatch(/Assistant change/u);

    const undo = await host.undoChange(
      conversationId,
      change!.type === "change" ? change!.receiptId : "",
    );
    expect(undo.receipt.status).toBe("undone");
    expect(
      (await harness.workspaceService.getWorkspaceSnapshot()).profile.headline,
    ).toBe("Senior systems designer");
  });

  it("undoes the middle of three changes and keeps the other two", async () => {
    const { host, harness } = setup();
    const first = await sendAndWait(
      host,
      "Change my headline to First headline",
    );
    await sendAndWait(
      host,
      "Change my summary to A new summary.",
      context(),
      first.conversationId,
    );
    await sendAndWait(
      host,
      "Add Figma to my skills",
      context(),
      first.conversationId,
    );
    const view = await host.readConversation({
      conversationId: first.conversationId,
    });
    const receipts = view.messages
      .flatMap((message) => message.parts)
      .flatMap((part) => (part.type === "change" ? [part.receiptId] : []));
    expect(receipts).toHaveLength(3);
    await host.undoChange(first.conversationId, receipts[1]!);
    const profile = (await harness.workspaceService.getWorkspaceSnapshot())
      .profile;
    expect(profile.headline).toBe("First headline");
    expect(profile.skills).toContain("Figma");
    expect(profile.professionalSummary.fullSummary).not.toBe("A new summary.");
  });

  it("refuses to undo a field changed again since, and names it", async () => {
    const { host, harness } = setup();
    const { conversationId } = await sendAndWait(
      host,
      "Change my headline to Assistant headline",
    );
    const view = await host.readConversation({ conversationId });
    const change = reply(view.messages).parts.find(
      (part) => part.type === "change",
    );
    const current = (await harness.workspaceService.getWorkspaceSnapshot())
      .profile;
    await harness.workspaceService.saveProfile({
      ...current,
      headline: "My own headline",
    });
    const undo = await host.undoChange(
      conversationId,
      change!.type === "change" ? change!.receiptId : "",
    );
    expect(undo.message).toMatch(/Headline/u);
    expect(
      (await harness.workspaceService.getWorkspaceSnapshot()).profile.headline,
    ).toBe("My own headline");
  });

  it("returns the accepted message for a repeated send", async () => {
    const { host } = setup();
    const input = {
      conversationId: null,
      clientMessageId: "client_same",
      text: "What is my headline?",
      context: context(),
    };
    const first = await host.sendMessage(input);
    const second = await host.sendMessage({
      ...input,
      conversationId: first.conversationId,
    });
    expect(second.message.id).toBe(first.message.id);
    await waitFor(
      () => host.readConversation({ conversationId: first.conversationId }),
      (view) => view.activeTurn === null,
    );
    const view = await host.readConversation({
      conversationId: first.conversationId,
    });
    expect(
      view.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("accepts a message while a turn runs and reads it before the next action", async () => {
    const { host } = setup({ delayMs: 150 });
    const first = await host.sendMessage({
      conversationId: null,
      clientMessageId: "c1",
      text: "Add Kotlin to my skills",
      context: context(),
    });
    const second = await host.sendMessage({
      conversationId: first.conversationId,
      clientMessageId: "c2",
      text: "What is my headline?",
      context: context(),
    });
    expect(second.steering).toBe(true);
    await waitFor(
      () => host.readConversation({ conversationId: first.conversationId }),
      (view) =>
        view.activeTurn === null &&
        view.pendingMessageIds.length === 0 &&
        view.messages.filter((message) => message.role === "assistant")
          .length >= 1,
      8_000,
    );
    const view = await host.readConversation({
      conversationId: first.conversationId,
    });
    const texts = view.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .flatMap((part) => (part.type === "text" ? [part.text] : []));
    expect(texts.join(" ")).toMatch(/headline/iu);
  });

  it("stops a running turn and fences later writes", async () => {
    const { host, harness, repository } = setup({ delayMs: 400 });
    const result = await host.sendMessage({
      conversationId: null,
      clientMessageId: "c_stop",
      text: "Change my headline to Should not land",
      context: context(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await host.stop(result.conversationId);
    const view = await waitFor(
      () => host.readConversation({ conversationId: result.conversationId }),
      (current) => current.activeTurn === null,
    );
    expect(reply(view.messages).parts[0]).toMatchObject({
      type: "notice",
      kind: "stopped",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (await harness.workspaceService.getWorkspaceSnapshot()).profile.headline,
    ).toBe("Senior systems designer");
    // The stopped request is closed in the history the next turn reads, so
    // a later message is not answered with the stopped work.
    const transcript = await repository.listTranscript(result.conversationId, {
      afterSeq: 0,
    });
    const closing = transcript.at(-1)?.message as {
      role: string;
      content: string;
    };
    expect(closing.role).toBe("assistant");
    expect(closing.content).toContain("request is closed");
  });

  it("starts a new chat from an archive and tells the model what the archive still holds", async () => {
    const { host, repository } = setup();
    const now = new Date().toISOString();
    await repository.upsertConversation(
      AssistantConversationSchema.parse({
        id: "assistant_archive_profile",
        title: "Profile chat (archived)",
        status: "archived",
        source: "profile_copilot_archive",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await repository.upsertMessage(
      AssistantMessageSchema.parse({
        id: "archived_message_1",
        conversationId: "assistant_archive_profile",
        role: "assistant",
        origin: "migrated",
        parts: [
          {
            type: "proposal",
            proposalId: "legacy_patch_group_1",
            kind: "profile_operations",
            summary: "Update headline",
            status: "pending",
            source: {
              store: "profile_copilot",
              patchGroupIds: ["legacy_patch_group_1"],
            },
          },
        ],
        createdAt: now,
      }),
    );
    const result = await sendAndWait(
      host,
      "What is my headline?",
      context(),
      "assistant_archive_profile",
    );
    expect(result.conversationId).not.toBe("assistant_archive_profile");
    const transcript = await repository.listTranscript(result.conversationId, {
      afterSeq: 0,
    });
    expect(JSON.stringify(transcript.map((item) => item.message))).toContain(
      'still has 1 suggestion(s) waiting for their Apply or Dismiss: \\"Update headline\\"',
    );
  });

  it("R3-007 releases the old lease and creates unrelated work without a lent tab", async () => {
    const { host, ports } = setup();
    const release = vi.fn(() => Promise.resolve());
    const inputs: (string | null)[] = [];
    ports.browser = {
      visibleTab: () => null,
      lease: (input) => {
        inputs.push(input.tabId);
        return Promise.resolve({
          leaseId: `lease_${inputs.length}`,
          tabId: input.tabId ?? "owned",
          borrowed: input.tabId !== null,
          isApplicationBound: () => Promise.resolve(false),
          revoked: new AbortController().signal,
          hands: {} as never,
          currentUrl: () => "http://127.0.0.1/",
          childTabIds: () => [],
          release,
        });
      },
    };
    const conversation = await host.createConversation();
    const session = (
      host as unknown as {
        detachedSession(
          id: string,
          messageId: string | null,
        ): AssistantTurnSession;
      }
    ).detachedSession(conversation.id, null);
    await session.browserLease({ tabId: "prepared" });
    await session.browserLease({
      openUrl: "http://127.0.0.1:47950/brindle/",
      newTab: true,
    });
    expect(inputs).toEqual(["prepared", null]);
    expect(release).toHaveBeenCalledWith("Switching browser tabs");
  });

  it("R3-169 waits for Browser to minimize before emitting the route", async () => {
    const { host, ports, events } = setup();
    let finish!: () => void;
    ports.prepareAppNavigation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const conversation = await host.createConversation();
    const session = (
      host as unknown as {
        detachedSession(
          id: string,
          messageId: string | null,
        ): AssistantTurnSession;
      }
    ).detachedSession(conversation.id, null);
    const pending = session.openInApp("/job-finder/applications");
    expect(events.some((event) => event.payload.type === "open_route")).toBe(
      false,
    );
    finish();
    await vi.waitFor(() =>
      expect(events.some((event) => event.payload.type === "open_route")).toBe(
        true,
      ),
    );
    const request = events.find(
      (event) => event.payload.type === "open_route",
    )!;
    if (request.payload.type !== "open_route") throw new Error("Missing route");
    host.acknowledgeNavigation({
      conversationId: conversation.id,
      navigationRequestId: request.payload.navigationRequestId!,
      displayedRoute: request.payload.route,
      section: null,
      overlay: "none",
      status: "displayed",
      reason: null,
    });
    expect(await pending).toMatchObject({ status: "displayed" });
    expect(events.some((event) => event.payload.type === "open_route")).toBe(
      true,
    );
  });

  it("does not lease a tab again after the person took it back", async () => {
    const { host, ports } = setup();
    const controllers: AbortController[] = [];
    ports.browser = {
      visibleTab: () => ({
        tabId: "tab_1",
        url: "http://127.0.0.1/",
        title: null,
      }),
      lease: () => {
        const controller = new AbortController();
        controllers.push(controller);
        return Promise.resolve({
          leaseId: `lease_${controllers.length}`,
          tabId: "tab_1",
          isApplicationBound: () => Promise.resolve(false),
          revoked: controller.signal,
          hands: {} as never,
          currentUrl: () => "http://127.0.0.1/",
          childTabIds: () => [],
          release: () => Promise.resolve(),
        });
      },
    };
    const conversation = await host.createConversation();
    const session = (
      host as unknown as {
        detachedSession: (
          id: string,
          messageId: string | null,
        ) => { browserLease: () => Promise<unknown> };
      }
    ).detachedSession(conversation.id, null);
    await session.browserLease();
    controllers[0]!.abort(
      new DOMException("You took this tab back.", "AbortError"),
    );
    await expect(session.browserLease()).rejects.toThrow(
      /Begin your reply with: You took this tab back/u,
    );
    expect(controllers).toHaveLength(1);
  });

  it("records a lent tab as handed back when the turn ends", async () => {
    const { host, repository } = setup();
    const conversation = await host.createConversation();
    await repository.upsertLease({
      id: "lease_done",
      conversationId: conversation.id,
      turnId: "turn_done",
      tabId: "tab_1",
      generation: 1,
      documentUrl: "http://127.0.0.1/",
      childTabIds: [],
      status: "active",
      revokedReason: null,
      createdAt: "2026-09-27T10:00:00.000Z",
    });
    let released = "";
    const live = {
      turn: { conversationId: conversation.id },
      lease: {
        leaseId: "lease_done",
        revoked: new AbortController().signal,
        release: (reason: string) => {
          released = reason;
          return Promise.resolve();
        },
      },
    };
    await (
      host as unknown as {
        releaseLease: (live: unknown, reason: string) => Promise<void>;
      }
    ).releaseLease(live, "turn ended");
    expect(released).toBe("turn ended");
    expect(live.lease).toBeNull();
    const [record] = await repository.listLeases({
      conversationId: conversation.id,
    });
    expect(record?.status).toBe("released");
  });

  it("closes a chat question when its Needs you step is answered on that screen", async () => {
    const { host, repository, harness } = setup();
    const conversation = await host.createConversation();
    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    // The step exists in the chat's question but is no longer waiting.
    const service = harness.workspaceService as unknown as {
      getWorkspaceSnapshot: () => Promise<typeof snapshot>;
    };
    service.getWorkspaceSnapshot = () =>
      Promise.resolve({
        ...snapshot,
        userActionRequests: [
          {
            ...(snapshot.userActionRequests[0] ?? {}),
            id: "step_consent",
            state: "resolved",
          } as (typeof snapshot.userActionRequests)[number],
        ],
      });
    harness.workspaceService.getWorkspaceProjection =
      service.getWorkspaceSnapshot;
    await repository.upsertMessage(
      AssistantMessageSchema.parse({
        id: "message_question",
        conversationId: conversation.id,
        role: "assistant",
        origin: "host",
        parts: [
          {
            type: "question",
            questionId: "question_consent",
            prompt: "Do you consent to a background check?",
            options: ["Yes", "No"],
            needsYouRequestId: "step_consent",
          },
        ],
        createdAt: "2026-09-28T09:00:00.000Z",
      }),
    );
    (
      host as unknown as {
        linkedQuestions: Map<string, unknown>;
      }
    ).linkedQuestions.set(`${conversation.id}:question_consent`, {
      conversationId: conversation.id,
      questionId: "question_consent",
      requestId: "step_consent",
    });

    await host.closeQuestionsAnsweredElsewhere();

    const { messages } = await repository.listMessages(conversation.id, {
      limit: 10,
    });
    const part = messages
      .flatMap((message) => message.parts)
      .find((entry) => entry.type === "question");
    expect(part).toMatchObject({
      status: "answered",
      answer: "Answered on the Needs you screen.",
    });
    const notes = (
      host as unknown as { answeredElsewhere: Map<string, string[]> }
    ).answeredElsewhere.get(conversation.id);
    expect(notes?.[0]).toContain(
      "is closed: Answered on the Needs you screen.",
    );
  });

  it("keeps stopped background work stopped across a restart", async () => {
    const { host, repository } = setup();
    const conversation = await host.createConversation();
    await repository.upsertOperation({
      id: "op_watch_search",
      conversationId: conversation.id,
      turnId: "turn_old",
      toolName: "watch_run",
      argumentsHash: "hash",
      status: "started",
      resultSummary: "Searching",
      receiptId: null,
      run: { kind: "discovery", id: "run_search_old" },
      startedAt: new Date().toISOString(),
      endedAt: null,
    });
    await host.stop(conversation.id);
    const operation = await repository.getOperation("op_watch_search");
    expect(operation?.status).toBe("cancelled");
    await host.recover();
    expect(
      (host as unknown as { watches: Map<string, unknown> }).watches.size,
    ).toBe(0);
  });

  it("marks the change card undone when the undo is asked for in the chat", async () => {
    const { host, repository } = setup();
    const { conversationId } = await sendAndWait(
      host,
      "Change my headline to Card sync check",
    );
    await sendAndWait(host, "Undo that", context(), conversationId);
    const view = await host.readConversation({ conversationId });
    const cards = view.messages.flatMap((message) =>
      message.parts.filter((part) => part.type === "change"),
    );
    expect(cards.length).toBeGreaterThan(0);
    expect(
      cards.every((part) => part.type === "change" && part.status === "undone"),
    ).toBe(true);
    // A card press is written into the model's record too.
    const card = cards[0]!;
    if (card.type !== "change") throw new Error("no card");
    const second = await sendAndWait(
      host,
      "Change my headline to Second card",
      context(),
      conversationId,
    );
    const latest = (await host.readConversation({ conversationId })).messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "change")
      .at(-1);
    if (latest?.type !== "change") throw new Error("no second card");
    await host.undoChange(second.conversationId, latest.receiptId);
    const transcript = await repository.listTranscript(conversationId, {
      afterSeq: 0,
    });
    expect(JSON.stringify(transcript.map((item) => item.message))).toContain(
      "The person pressed Undo",
    );
  });

  it("reports login once, follows human verification and filling, then reports its receipt once", async () => {
    const fixture = applicationHandoff();
    const chat = vi.fn(() =>
      Promise.resolve({ content: "Current application status recorded." }),
    );
    const { host, harness, ports, repository } = setup({
      seed: fixture.seed,
      modelHandle: {
        ...createScriptedAssistantModelHandle(),
        createModel: () => ({ chatWithTools: chat }),
      },
    });
    const conversation = await host.createConversation();
    await installApplicationWatch(host, conversation.id, {
      kind: "apply_batch",
      sourceMessageId: "message_original_apply",
    });
    await host.checkWatches();
    await waitFor(
      () => host.readConversation({ conversationId: conversation.id }),
      (view) => view.activeTurn === null,
    );
    expect(chat).toHaveBeenCalledTimes(1);
    const hostNotes = async () =>
      (await repository.listMessages(conversation.id, { limit: 100 })).messages
        .filter(
          (message) => message.role === "user" && message.origin === "host",
        )
        .flatMap((message) =>
          message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text),
        );
    expect((await hostNotes())[0]).toContain("waiting on the person");
    expect((await hostNotes())[0]).toContain("Sign in to continue");
    expect((await hostNotes())[0]).toContain("nothing has been sent");
    const snapshotReads = vi.fn(() =>
      harness.workspaceService.getWorkspaceSnapshot(),
    );
    harness.workspaceService.getWorkspaceProjection = snapshotReads;
    await Promise.all(Array.from({ length: 10 }, () => host.checkWatches()));
    expect(snapshotReads).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(
      (await repository.listOperations(conversation.id, { runOnly: true }))[0]
        ?.status,
    ).toBe("started");

    const verifying = userActionTransition(fixture.request, "verifying");
    await harness.repository.commitUserActionTransition(verifying);
    await installApplicationWatch(host, conversation.id, {
      kind: "apply_run",
      resumed: true,
      sourceMessageId: "message_answer",
    });
    await installApplicationWatch(host, conversation.id, {
      kind: "apply_run",
      resumed: true,
      sourceMessageId: "message_later_answer",
    });
    const watches = await repository.listOperations(conversation.id, {
      runOnly: true,
    });
    expect(watches).toHaveLength(1);
    expect(watches[0]?.receiptId).toBe("message_original_apply");
    await host.checkWatches();
    expect(chat).toHaveBeenCalledTimes(1);
    await harness.repository.upsertApplyJobResult({
      ...fixture.result,
      state: "filling",
    });
    await host.checkWatches();
    expect(chat).toHaveBeenCalledTimes(1);
    await harness.repository.commitUserActionTransition(
      userActionTransition(verifying.request, "resolved"),
    );
    await harness.repository.upsertApplyJobResult(
      submittedResult(fixture.result),
    );
    await Promise.all(Array.from({ length: 10 }, () => host.checkWatches()));
    await waitFor(
      () => host.readConversation({ conversationId: conversation.id }),
      (view) => view.activeTurn === null,
    );
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await hostNotes()).toHaveLength(2);
    expect((await hostNotes())[1]).toContain('"state":"submitted"');
    expect((await hostNotes())[1]).toContain('"outcome":"submitted"');
    await host.checkWatches();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(ports.started).toEqual([]);
    expect(ports.sent).toEqual([]);
    expect(
      (await repository.listOperations(conversation.id, { runOnly: true }))[0]
        ?.status,
    ).toBe("committed");
  });

  it("reports a new question handoff once after the login leg resumes", async () => {
    const fixture = applicationHandoff();
    const chat = vi.fn(() =>
      Promise.resolve({ content: "Current application status recorded." }),
    );
    const { host, harness, ports } = setup({
      seed: fixture.seed,
      modelHandle: {
        ...createScriptedAssistantModelHandle(),
        createModel: () => ({ chatWithTools: chat }),
      },
    });
    const conversation = await host.createConversation();
    await installApplicationWatch(host, conversation.id);
    await host.checkWatches();
    await waitFor(
      () => host.readConversation({ conversationId: conversation.id }),
      (view) => view.activeTurn === null,
    );
    const verifying = userActionTransition(fixture.request, "verifying");
    await harness.repository.commitUserActionTransition(verifying);
    await host.checkWatches();
    await harness.repository.upsertApplyJobResult({
      ...fixture.result,
      state: "filling",
    });
    await host.checkWatches();
    await harness.repository.commitUserActionTransition(
      userActionTransition(verifying.request, "resolved"),
    );
    await harness.repository.upsertApplyJobResult({
      ...fixture.result,
      blockerReason: "required_human_input",
      blockerSummary: "Answer the required availability question.",
    });
    await harness.repository.createUserActionRequest({
      ...fixture.request,
      id: "request_question",
      dedupeKey: "application-question",
      kind: "manual_answer",
      title: "Answer the required availability question",
      state: "pending",
    });
    await host.checkWatches();
    await waitFor(
      () => host.readConversation({ conversationId: conversation.id }),
      (view) => view.activeTurn === null,
    );
    expect(chat).toHaveBeenCalledTimes(2);
    await Promise.all(Array.from({ length: 10 }, () => host.checkWatches()));
    expect(chat).toHaveBeenCalledTimes(2);
    const view = await host.readConversation({
      conversationId: conversation.id,
    });
    expect(JSON.stringify(view.messages)).toContain(
      "Answer the required availability question",
    );
    expect(ports.started).toEqual([]);
  });

  it("keeps application watches and their sources separate between conversations", async () => {
    const fixture = applicationHandoff();
    const { host, repository } = setup({ seed: fixture.seed });
    const first = await host.createConversation();
    const second = await host.createConversation();
    await installApplicationWatch(host, first.id, {
      kind: "apply_batch",
      sourceMessageId: "message_first",
    });
    await installApplicationWatch(host, second.id, {
      kind: "apply_run",
      sourceMessageId: "message_second",
    });
    const firstOperations = await repository.listOperations(first.id, {
      runOnly: true,
    });
    const secondOperations = await repository.listOperations(second.id, {
      runOnly: true,
    });
    expect(firstOperations).toHaveLength(1);
    expect(secondOperations).toHaveLength(1);
    expect(firstOperations[0]?.receiptId).toBe("message_first");
    expect(secondOperations[0]?.receiptId).toBe("message_second");
    const active = (
      host as unknown as {
        watches: Map<
          string,
          { conversationId: string; sourceMessageId: string }
        >;
      }
    ).watches;
    expect(
      [...active.values()].map((watch) => [
        watch.conversationId,
        watch.sourceMessageId,
      ]),
    ).toEqual([
      [first.id, "message_first"],
      [second.id, "message_second"],
    ]);
    await host.checkWatches();
    await waitFor(
      () => host.readConversation({ conversationId: first.id }),
      (view) => view.activeTurn === null,
    );
    await waitFor(
      () => host.readConversation({ conversationId: second.id }),
      (view) => view.activeTurn === null,
    );
    expect(
      (await host.readConversation({ conversationId: first.id })).messages.some(
        (message) => message.role === "user" && message.origin === "host",
      ),
    ).toBe(true);
    expect(
      (
        await host.readConversation({ conversationId: second.id })
      ).messages.some(
        (message) => message.role === "user" && message.origin === "host",
      ),
    ).toBe(true);
  });

  it("recovers a dormant application handoff quietly, then follows the same application to submission", async () => {
    const fixture = applicationHandoff();
    const chat = vi.fn(() =>
      Promise.resolve({ content: "Current application status recorded." }),
    );
    const handle = {
      ...createScriptedAssistantModelHandle(),
      createModel: () => ({ chatWithTools: chat }),
    };
    const { host, harness, ports, repository } = setup({
      seed: fixture.seed,
      modelHandle: handle,
    });
    const conversation = await host.createConversation();
    await installApplicationWatch(host, conversation.id);
    await host.checkWatches();
    await waitFor(
      () => host.readConversation({ conversationId: conversation.id }),
      (view) => view.activeTurn === null,
    );
    expect(chat).toHaveBeenCalledTimes(1);
    await host.shutdown();
    const originalWatch = (
      await repository.listOperations(conversation.id, { runOnly: true })
    )[0]!;
    // A prior app version could persist both names for this same run.
    await repository.upsertOperation({
      ...originalWatch,
      id: "legacy_answer_watch",
      run: { kind: "apply_batch", id: fixture.run.id },
      startedAt: new Date(
        Date.parse(originalWatch.startedAt) + 1_000,
      ).toISOString(),
    });
    const reopened = new AssistantSessionHost({
      repository,
      service: harness.workspaceService,
      ports,
      resolveModel: () => ({ kind: "ready", handle }),
      publish: () => undefined,
      watchIntervalMs: 50,
      log: () => undefined,
    });
    hosts.push(reopened);
    await reopened.recover();
    expect((await repository.getOperation(originalWatch.id))?.status).toBe(
      "started",
    );
    expect((await repository.getOperation("legacy_answer_watch"))?.status).toBe(
      "committed",
    );
    await Promise.all(
      Array.from({ length: 10 }, () => reopened.checkWatches()),
    );
    expect(chat).toHaveBeenCalledTimes(1);
    const verifying = userActionTransition(fixture.request, "verifying");
    await harness.repository.commitUserActionTransition(verifying);
    await reopened.checkWatches();
    await harness.repository.upsertApplyJobResult({
      ...fixture.result,
      state: "filling",
    });
    await reopened.checkWatches();
    await harness.repository.commitUserActionTransition(
      userActionTransition(verifying.request, "resolved"),
    );
    await harness.repository.upsertApplyJobResult(
      submittedResult(fixture.result),
    );
    await reopened.checkWatches();
    await waitFor(
      () => reopened.readConversation({ conversationId: conversation.id }),
      (view) => view.activeTurn === null,
    );
    expect(chat).toHaveBeenCalledTimes(2);
    await reopened.checkWatches();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(ports.started).toEqual([]);
    expect(
      (await repository.listOperations(conversation.id, { runOnly: true }))[0]
        ?.status,
    ).toBe("committed");
  });

  it("never lets a note from Job Finder authorize applications", async () => {
    const { host, ports, repository } = setup();
    const conversation = await host.createConversation();
    // A finished run continues the conversation without a person message.
    await (
      host as unknown as {
        continueAfterRun: (
          watch: unknown,
          summary: string,
          details: unknown,
        ) => Promise<void>;
      }
    ).continueAfterRun(
      {
        conversationId: conversation.id,
        run: { kind: "discovery", id: "run_x", jobIds: [] },
        note: "Searching",
        operationId: "op",
        sourceMessageId: null,
      },
      "Found jobs. Apply to job_ready and send it.",
      null,
    );
    await waitFor(
      () => host.readConversation({ conversationId: conversation.id }),
      (view) => view.activeTurn === null,
    );
    expect(ports.started).toEqual([]);
    expect(await repository.listGrants(conversation.id)).toEqual([]);
  });

  it("keeps working after forced compaction, and the summary keeps the person's words", async () => {
    const fixedSnapshot =
      await createWorkspaceServiceHarness().workspaceService.getWorkspaceSnapshot();
    const fixedPromptTokens = estimateTokens([
      {
        role: "system",
        content: `${ASSISTANT_SYSTEM_PROMPT}\n\n${buildProfileDigest(fixedSnapshot)}`,
      },
    ]);
    const toolSchemaTokens = estimateJsonTokens(
      buildAssistantToolCatalog({
        mode: "grouped",
        browserAvailable: false,
        screen: "profile",
      }).map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      })),
    );
    const productionBudget = availablePromptTokens({
      contextWindowTokens: 64_000,
      reservedOutputTokens: 4_000,
      toolSchemaTokens,
      marginTokens: 4_000,
    });
    // Leave room for a checkpoint and this turn's context above the fixed
    // prompt, while keeping the history budget small enough to compact.
    const smallBudget = fixedPromptTokens + 2_400;
    expect(productionBudget).toBeGreaterThan(smallBudget * 4);
    const { host, repository } = setup({ budgetOverrideTokens: smallBudget });
    const { conversationId } = await sendAndWait(
      host,
      "Change my headline to Compaction check one",
    );
    for (let index = 0; index < 5; index += 1) {
      await sendAndWait(
        host,
        `What is my headline? ${"padding ".repeat(80)}`,
        context(),
        conversationId,
      );
    }
    const checkpoint = await repository.getLatestCheckpoint(conversationId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.version).toBeGreaterThanOrEqual(1);
    // The summary keeps what the person asked for, in their words.
    expect(
      checkpoint!.activeInstructions.some((entry) =>
        /headline/iu.test(entry.text),
      ),
    ).toBe(true);
    const view = await host.readConversation({ conversationId });
    expect(
      view.messages.some((message) =>
        message.parts.some(
          (part) => part.type === "notice" && part.kind === "compacted",
        ),
      ),
    ).toBe(true);
    const compactedText = reply(view.messages).parts.find(
      (part) => part.type === "text",
    );
    expect(compactedText?.type === "text" ? compactedText.text : "").toContain(
      "Compaction check one",
    );

    // Ordered lists survive compaction word for word: "the second one" is
    // the second item, not whatever the summary remembered.
    await repository.upsertResultSet({
      id: "rs_numbered",
      conversationId,
      kind: "jobs",
      label: "Numbered shortlist",
      itemIds: ["job_generating", "job_ready"],
      source: "tool_query",
      coverage: null,
      pageItems: [],
      pageUrl: null,
      createdAt: new Date().toISOString(),
    });
    const pinned = await (
      host as unknown as {
        describeOrderedLists: (id: string) => Promise<string | null>;
      }
    ).describeOrderedLists(conversationId);
    expect(pinned).toMatch(/1\. .*\[job_generating\]/u);
    expect(pinned).toMatch(/2\. .*\[job_ready\]/u);
    const assembled = await assembleModelInput({
      repository,
      conversationId,
      systemPrompt: "system",
      turnMessages: [],
      contextWindowTokens: 64_000,
      maxOutputTokens: 4_000,
      toolSchemaTokens: 0,
      calibrator: createTokenCalibrator(),
      summarize: null,
      onCompacted: () => Promise.resolve(),
      now: () => new Date().toISOString(),
      createId: (prefix) => `${prefix}_x`,
      pinnedAfterSummary: () => Promise.resolve(pinned),
    });
    const summaryMessage = assembled.find(
      (message) =>
        message.role === "user" &&
        message.content.startsWith("[Summary of the earlier part"),
    );
    expect(summaryMessage?.content).toContain("2. ");
    expect(summaryMessage?.content).toContain("[job_ready]");
  });

  it("marks a turn interrupted after a restart and keeps the conversation", async () => {
    const { repository, harness, ports } = setup();
    const conversation = {
      id: "c_restart",
      title: "Restart",
      status: "active" as const,
      source: "assistant" as const,
      jobId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
      messageCount: 0,
    };
    await repository.upsertConversation(conversation);
    await repository.upsertTurn({
      id: "turn_left_running",
      conversationId: "c_restart",
      trigger: "message",
      sourceMessageId: null,
      status: "running",
      generation: 1,
      startedAt: new Date().toISOString(),
      endedAt: null,
      model: null,
      usage: null,
      error: null,
      planId: null,
    });
    const restarted = new AssistantSessionHost({
      repository,
      service: harness.workspaceService,
      ports,
      resolveModel: () => ({
        kind: "ready",
        handle: createScriptedAssistantModelHandle(),
      }),
      publish: () => undefined,
      log: () => undefined,
    });
    hosts.push(restarted);
    await restarted.recover();
    expect((await repository.getTurn("turn_left_running"))?.status).toBe(
      "interrupted",
    );
    const view = await restarted.readConversation({
      conversationId: "c_restart",
    });
    expect(view.messages.at(-1)?.parts[0]).toMatchObject({
      type: "notice",
      kind: "interrupted",
    });
  });

  it("reports an unavailable model as an outage, never as setup", async () => {
    const harness = createWorkspaceServiceHarness();
    const repository = createAssistantRepository({ filePath: ":memory:" });
    const host = new AssistantSessionHost({
      repository,
      service: harness.workspaceService,
      ports: createPorts(),
      resolveModel: () => ({
        kind: "unavailable",
        detail: "The assistant's AI service is not reachable right now.",
      }),
      publish: () => undefined,
      log: () => undefined,
    });
    hosts.push(host);
    const { conversationId } = await sendAndWait(host, "Hello");
    const view = await host.readConversation({ conversationId });
    const notice = reply(view.messages).parts[0];
    expect(notice).toMatchObject({ type: "notice", kind: "outage" });
    expect(JSON.stringify(notice)).not.toMatch(/api key|configure|settings/iu);
  });

  it("R3-137 waits for the displayed Tracker and rejects wrong sections and covering overlays", async () => {
    const { host, events } = setup();
    const conversation = await host.createConversation();
    const session = (
      host as unknown as {
        detachedSession(
          id: string,
          messageId: string | null,
        ): AssistantTurnSession;
      }
    ).detachedSession(conversation.id, null);
    for (const display of [
      {
        displayedRoute: "/job-finder/review-queue/job_ready/resume",
        section: null,
        overlay: "none" as const,
      },
      {
        displayedRoute: "/job-finder/applications?view=tracker",
        section: null,
        overlay: "none" as const,
      },
      {
        displayedRoute: "/job-finder/applications?view=tracker",
        section: "tracker",
        overlay: "browser" as const,
      },
      {
        displayedRoute: "/job-finder/applications?view=tracker",
        section: "tracker",
        overlay: "none" as const,
      },
    ]) {
      const before = events.length;
      const pending = session.openInApp(
        "/job-finder/applications?view=tracker",
      );
      await vi.waitFor(() =>
        expect(
          events
            .slice(before)
            .some((event) => event.payload.type === "open_route"),
        ).toBe(true),
      );
      const event = events
        .slice(before)
        .find((event) => event.payload.type === "open_route")!;
      if (event.payload.type !== "open_route") throw new Error("Missing route");
      const ack = {
        conversationId: conversation.id,
        navigationRequestId: event.payload.navigationRequestId!,
        ...display,
        status: "displayed" as const,
        reason: null,
      };
      host.acknowledgeNavigation({
        ...ack,
        navigationRequestId: "stale_request",
      });
      host.acknowledgeNavigation(ack);
      expect(await pending).toMatchObject({
        status:
          display.section === "tracker" && display.overlay === "none"
            ? "displayed"
            : "blocked",
      });
    }
  });

  it("keeps later browser steps on the opened retained application during the same turn", async () => {
    const { host, ports } = setup();
    const release = vi.fn(() => Promise.resolve());
    const requests: unknown[] = [];
    ports.browser = {
      visibleTab: () => null,
      lease: (input) => {
        requests.push(input);
        return Promise.resolve({
          leaseId: "exact",
          tabId: "retained",
          applicationResultId: "prepared",
          isApplicationBound: () => Promise.resolve(true),
          revoked: new AbortController().signal,
          hands: {} as never,
          currentUrl: () => "https://example.test/form",
          childTabIds: () => [],
          release,
        });
      },
    };
    const conversation = await host.createConversation();
    const session = (
      host as unknown as {
        detachedSession(
          id: string,
          messageId: string | null,
        ): AssistantTurnSession;
      }
    ).detachedSession(conversation.id, null);
    const opened = await session.browserLease({
      applicationResultId: "prepared",
    });
    expect(await session.browserLease()).toBe(opened);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ applicationResultId: "prepared" });
    await session.releaseBrowserLease?.();
    expect(release).toHaveBeenCalledWith("Reviewing your send instruction");
  });

  it("continues a confirmation timeout with an unconfirmed send and no permission to retry", async () => {
    const fixture = applicationHandoff();
    const sent = submittedResult(fixture.result);
    const uncertain = ApplyJobResultSchema.parse({
      ...sent,
      state: "awaiting_review",
      summary: "Send attempted; confirmation timed out",
      detail: "Check the site before trying again.",
      privacyReceipt: {
        ...sent.privacyReceipt,
        finalSubmitOccurred: false,
        submissionOutcome: {
          ...sent.privacyReceipt!.submissionOutcome,
          outcome: "outcome_uncertain",
          verifiedAt: null,
          retry: { eligible: false, blockReason: "outcome_uncertain" },
        },
      },
    });
    fixture.seed.applyJobResults = [uncertain];
    fixture.seed.applyRuns = [
      ApplyRunSchema.parse({ ...fixture.run, state: "completed" }),
    ];
    fixture.seed.userActionRequests = [];
    const chat = vi.fn(() =>
      Promise.resolve({ content: "The send is unconfirmed. Check the site." }),
    );
    const { host, ports, repository } = setup({
      seed: fixture.seed,
      modelHandle: {
        ...createScriptedAssistantModelHandle(),
        createModel: () => ({ chatWithTools: chat }),
      },
    });
    const conversation = await host.createConversation();
    await installApplicationWatch(host, conversation.id);
    await host.checkWatches();
    await waitFor(
      () => host.readConversation({ conversationId: conversation.id }),
      (view) => view.activeTurn === null,
    );
    const notes = (
      await repository.listMessages(conversation.id, { limit: 100 })
    ).messages.filter((message) => message.origin === "host");
    const text = JSON.stringify(notes);
    expect(text).toContain("send unconfirmed");
    expect(text).toContain("blocked_until_person_checks_outcome");
    expect(text).toContain("Do not send again or change sending settings");
    expect(ports.sent).toEqual([]);
  });

  it("records a successful prepared-form field edit on the application", async () => {
    const seed = createSeed();
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "record_edit",
        jobId: "job_ready",
        title: "Designer",
        company: "Synthetic",
        status: "ready_for_review",
        lastUpdatedAt: "2026-10-05T10:00:00.000Z",
        lastActionLabel: "Prepared",
        nextActionLabel: "Review",
      }),
    ];
    const { host, ports, harness } = setup({ seed });
    let noteChange:
      | ((recordId: string, field: string) => Promise<void>)
      | undefined;
    ports.browser = {
      visibleTab: () => null,
      lease: (input) => {
        noteChange = input.onApplicationChange;
        return Promise.resolve({
          leaseId: "edit",
          tabId: "retained",
          applicationResultId: "prepared",
          isApplicationBound: () => Promise.resolve(true),
          revoked: new AbortController().signal,
          hands: {} as never,
          currentUrl: () => "https://example.test/form",
          childTabIds: () => [],
          release: () => Promise.resolve(),
        });
      },
    };
    const conversation = await host.createConversation();
    const session = (
      host as unknown as {
        detachedSession(
          id: string,
          messageId: string | null,
        ): AssistantTurnSession;
      }
    ).detachedSession(conversation.id, null);
    await session.browserLease({ applicationResultId: "prepared" });
    await noteChange!("record_edit", "Cover letter");
    const application = (
      await harness.workspaceService.getWorkspaceSnapshot()
    ).applicationRecords.find((record) => record.id === "record_edit")!;
    expect(application.crm?.notes[0]?.body).toBe(
      "Assistant changed Cover letter in the prepared form. Nothing was sent.",
    );
    expect(application.status).toBe("ready_for_review");
  });
});
