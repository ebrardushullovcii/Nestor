import { randomUUID } from "node:crypto";
import {
  AiBehaviorPreferenceSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplicationCrmDataSchema,
  ApplicationRecordSchema,
  ListingActivitySchema,
  type ApplicationRecord,
  AssistantResultSetSchema,
  AssistantMessageSchema,
  type RawApplyPage,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createSeed,
  createBrowserRuntime,
  createWorkspaceServiceHarness,
} from "../../workspace-service.test-support";
import type { AssistantBrowserLease, AssistantHostPorts } from "../ports";
import { ASSISTANT_SYSTEM_PROMPT } from "../prompt";
import type { AssistantTurnSession } from "../tool-kit";
import {
  continueApplicationTool,
  recordInstructionTool,
  listApplicationsTool,
  getApplicationTool,
} from "./application-tools";
import {
  browserOpenTool,
  browserUseApplicationTool,
  browserTools,
} from "./browser-tools";
import {
  assessJobListingTool,
  shortlistResultSetTool,
  shortlistJobsTool,
} from "./jobs-tools";
import { editProfileTool, PROFILE_EDITING_RULES } from "./profile-tools";
import {
  setDefaultResumeLevelTool,
  updateAiBehaviorTool,
  updateApplySettingsTool,
} from "./settings-tools";
import {
  getWorkspaceSummaryTool,
  listNeedsYouTool,
  openInAppTool,
} from "./workspace-tools";
import { interviewForModel } from "./format";

function world() {
  const { workspaceService: service } = createWorkspaceServiceHarness();
  // Test cases substitute canonical snapshots below; display reads see the
  // same synthetic substitutions rather than the repository behind the spy.
  service.getWorkspaceProjection = () => service.getWorkspaceSnapshot();
  const changes: unknown[] = [];
  const openInApp = vi.fn(() => Promise.resolve());
  const publishWorkspaceUpdate = vi.fn();
  const session = {
    conversationId: randomUUID(),
    turnId: randomUUID(),
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    now: () => "2026-10-04T12:00:00.000Z",
    createId: () => randomUUID(),
    context: null,
    openInApp,
    recordChange: vi.fn(
      (change: Parameters<AssistantTurnSession["recordChange"]>[0]) => {
        changes.push(change);
        return Promise.resolve({
          receipt: {
            id: randomUUID(),
            fieldLabels: change.entries.map((entry) => entry.label),
          },
          part: { type: "notice", kind: "info", text: "Saved" },
        });
      },
    ),
    createResultSet: (
      input: Parameters<AssistantTurnSession["createResultSet"]>[0],
    ) =>
      Promise.resolve(
        AssistantResultSetSchema.parse({
          ...input,
          id: randomUUID(),
          conversationId: "conversation",
          createdAt: "2026-10-04T12:00:00.000Z",
        }),
      ),
  } as unknown as AssistantTurnSession;
  const ports = {
    publishWorkspaceUpdate,
  } as unknown as AssistantHostPorts;
  return {
    service,
    session,
    ports,
    changes,
    openInApp,
    publishWorkspaceUpdate,
  };
}

function application(): ApplicationRecord {
  return ApplicationRecordSchema.parse({
    id: "record",
    jobId: "job_ready",
    title: "Synthetic Engineer",
    company: "Synthetic",
    status: "submitted",
    lastAttemptState: "submitted",
    lastUpdatedAt: "2026-10-04T12:00:00.000Z",
    latestBlocker: null,
    crm: ApplicationCrmDataSchema.parse({
      stage: "applied",
      stageChangedAt: "2026-10-04T12:00:00.000Z",
    }),
    lastActionLabel: "Application sent",
    nextActionLabel: null,
  });
}

function page(url = "http://127.0.0.1:47950/brindle/jobs/50"): RawApplyPage {
  return {
    url,
    title: "Synthetic job",
    bodyText: "Synthetic job",
    headings: [],
    controls: [],
    actions: [],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
  };
}
function lease(raw = page()): AssistantBrowserLease {
  return {
    leaseId: "lease",
    tabId: "retained_form",
    borrowed: true,
    isApplicationBound: () => Promise.resolve(true),
    revoked: new AbortController().signal,
    currentUrl: () => raw.url!,
    childTabIds: () => [],
    release: () => Promise.resolve(),
    hands: {
      readPage: () => Promise.resolve(raw),
      navigate: vi.fn(),
    } as unknown as AssistantBrowserLease["hands"],
  };
}

describe("R3 assistant safety findings", () => {
  it("R3-007 opens an unrelated lookup in a new tab and never navigates the lent form", async () => {
    const ctx = world();
    const tab = lease();
    ctx.ports.browser = { visibleTab: () => null, lease: vi.fn() };
    const browserLease = vi.fn(() => Promise.resolve(tab));
    ctx.session.browserLease = browserLease;
    const result = await browserOpenTool.execute({ url: page().url! }, ctx);
    expect(browserLease).toHaveBeenCalledWith({
      openUrl: page().url,
      newTab: true,
    });
    expect(tab.hands.navigate).not.toHaveBeenCalled();
    expect(result.summary).toContain("new tab shows");
    await expect(
      browserTools
        .find((tool) => tool.name === "browser_navigate")!
        .execute({ url: "http://127.0.0.1:47950/brindle/" }, ctx),
    ).rejects.toThrow("This tab holds a prepared application");
    await expect(
      browserTools
        .find((tool) => tool.name === "browser_go_back")!
        .execute({}, ctx),
    ).rejects.toThrow("This tab holds a prepared application");
    for (const name of [
      "browser_follow_link",
      "browser_click",
      "browser_press_key",
      "browser_type",
      "browser_select",
      "browser_set_checkbox",
    ]) {
      await expect(
        browserTools
          .find((tool) => tool.name === name)!
          .execute({ ref: "unrelated", key: "Control+Enter" }, ctx),
      ).rejects.toThrow("This tab holds a prepared application");
    }
    expect(tab.hands.navigate).not.toHaveBeenCalled();
  });

  it("an ordinary lent tab accepts click, type and navigate", async () => {
    const ctx = world();
    const raw = page();
    raw.clickables = [
      {
        index: 0,
        label: "Expand details",
        role: "button",
        tagName: "div",
        visible: true,
        topOffset: 0,
      },
    ];
    const tab = lease(raw);
    tab.isApplicationBound = () => Promise.resolve(false);
    const click = vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "Expanded" }),
    );
    const type = vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "Synthetic" }),
    );
    const navigate = vi.fn(() =>
      Promise.resolve({ ok: true as const, url: raw.url! }),
    );
    tab.hands.clickElement = click;
    tab.hands.fillText = type;
    tab.hands.navigate = navigate;
    ctx.ports.browser = { visibleTab: () => null, lease: vi.fn() };
    ctx.session.browserLease = () => Promise.resolve(tab);
    for (const [name, input] of [
      ["browser_click", { ref: "e0" }],
      ["browser_type", { ref: "c0", text: "Synthetic" }],
      ["browser_navigate", { url: raw.url! }],
    ] as const) {
      await browserTools
        .find((tool) => tool.name === name)!
        .execute(input, ctx);
    }
    expect(click).toHaveBeenCalledWith("e0");
    expect(type).toHaveBeenCalledWith("c0", "Synthetic");
    expect(navigate).toHaveBeenCalledWith(raw.url);
  });

  it.each([false, true])(
    "final send stays refused on a lent tab (application bound: %s)",
    async (bound) => {
      const ctx = world();
      const raw = page();
      raw.actions = [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ];
      const tab = lease(raw);
      tab.isApplicationBound = () => Promise.resolve(bound);
      const click = vi.fn();
      const key = vi.fn();
      tab.hands.clickElement = click;
      tab.hands.pressKey = key;
      ctx.ports.browser = { visibleTab: () => null, lease: vi.fn() };
      ctx.session.browserLease = () => Promise.resolve(tab);
      for (const [name, input] of [
        ["browser_click", { ref: "a0" }],
        ["browser_press_key", { key: "Control+Enter" }],
      ] as const) {
        const result = browserTools
          .find((tool) => tool.name === name)!
          .execute(input, ctx);
        if (bound)
          await expect(result).rejects.toThrow(
            "This tab holds a prepared application",
          );
        else expect((await result).status).toBe("refused");
      }
      expect(click).not.toHaveBeenCalled();
      expect(key).not.toHaveBeenCalled();
    },
  );

  it("R3-016 inspects the saved binding without person handoff or a visible-tab lease", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    snapshot.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result",
        jobId: "job_ready",
        runId: "run",
        applicationRecordId: "record",
        state: "awaiting_review",
        summary: "Ready",
        detail: "Filled synthetic form",
        startedAt: "2026-10-04T12:00:00.000Z",
        updatedAt: "2026-10-04T12:00:00.000Z",
      }),
    ];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
    const inspect = vi
      .spyOn(ctx.service, "inspectPreparedApplicationPage")
      .mockResolvedValue(page("http://127.0.0.1:47950/spruce/apply/1"));
    const focus = vi.spyOn(ctx.service, "focusPreparedApplicationPage");
    const visibleTab = vi.fn(() => ({
      tabId: "unrelated",
      url: page().url!,
      title: "Unrelated",
    }));
    ctx.ports.browser = { visibleTab, lease: vi.fn() };
    const browserLease = vi.fn();
    ctx.session.browserLease = browserLease;
    const observed = await browserUseApplicationTool.execute(
      { jobId: "job_ready" },
      ctx,
    );
    expect(inspect).toHaveBeenCalledWith({
      jobId: "job_ready",
      runId: "run",
      resultId: "result",
      applicationRecordId: "record",
    });
    expect(focus).not.toHaveBeenCalled();
    expect(visibleTab).not.toHaveBeenCalled();
    expect(browserLease).not.toHaveBeenCalled();
    expect(observed.summary).toContain("read-only");
    snapshot.applyJobResults = [];
    await expect(
      browserUseApplicationTool.execute({ jobId: "job_ready" }, ctx),
    ).rejects.toThrow("Nothing was opened or restored");
  });

  it("inspection closes all form/submit windows before reading the exact saved application", async () => {
    const seed = createSeed();
    const record = {
      ...application(),
      status: "ready_for_review" as const,
      lastAttemptState: "ready" as const,
      crm: null,
    };
    seed.applicationRecords = [record];
    const job = seed.savedJobs.find((job) => job.id === record.jobId)!;
    const result = ApplyJobResultSchema.parse({
      id: "bound_result",
      runId: "bound_run",
      jobId: job.id,
      applicationRecordId: record.id,
      state: "awaiting_review",
      summary: "Ready",
      detail: "Filled synthetic form",
      startedAt: "2026-10-04T12:00:00.000Z",
      updatedAt: "2026-10-04T12:00:00.000Z",
    });
    seed.applyJobResults = [result];
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: result.runId,
        state: "completed",
        summary: "Ready",
        detail: "Synthetic preparation",
        jobIds: [job.id],
        createdAt: result.updatedAt,
        updatedAt: result.updatedAt,
      }),
    ];
    const runtime = createBrowserRuntime();
    const order: string[] = [];
    runtime.closeApplicationFormAction = vi.fn(() => {
      order.push("close");
      return Promise.resolve();
    });
    const readBinding = vi.fn(() => {
      order.push("read");
      return Promise.resolve(page());
    });
    runtime.readApplicationPageBinding = readBinding;
    const handToPerson = vi.fn();
    const focusBinding = vi.fn();
    runtime.handApplicationPageToPerson = handToPerson;
    runtime.focusApplicationPageBinding = focusBinding;
    const service = createWorkspaceServiceHarness({
      seed,
      browserRuntime: runtime,
    }).workspaceService;
    const input = {
      jobId: job.id,
      runId: result.runId,
      resultId: result.id,
      applicationRecordId: record.id,
    };
    await service.inspectPreparedApplicationPage(input);
    expect(order).toEqual(["close", "read"]);
    expect(readBinding).toHaveBeenCalledWith(job.source, result.id);
    expect(handToPerson).not.toHaveBeenCalled();
    expect(focusBinding).not.toHaveBeenCalled();
    await expect(
      service.inspectPreparedApplicationPage({
        ...input,
        applicationRecordId: "wrong",
      }),
    ).rejects.toThrow("no longer matches");
    const close = vi.fn(() => Promise.reject(new Error("guard unavailable")));
    runtime.closeApplicationFormAction = close;
    await expect(service.inspectPreparedApplicationPage(input)).rejects.toThrow(
      "guard unavailable",
    );
    expect(order).toEqual(["close", "read"]);
  });

  it("R3-008 preserves every source across separate remote and budget changes", async () => {
    const ctx = world();
    const before = await ctx.service.getWorkspaceSnapshot();
    expect(before.searchPreferences.discovery.targets.length).toBeGreaterThan(
      0,
    );
    const behavior = AiBehaviorPreferenceSchema.parse(
      before.settings.aiBehavior ?? {},
    );
    await updateAiBehaviorTool.execute(
      updateAiBehaviorTool.input.parse({
        aiBehavior: {
          ...behavior,
          jobSearch: {
            ...behavior.jobSearch,
            remoteCountsAsAnyLocation: false,
          },
        },
      }),
      ctx,
    );
    await editProfileTool.execute(
      {
        summary: "Search budget",
        mode: "apply",
        operations: [
          {
            operation: "replace_search_preferences_fields",
            value: { discovery: { runJobBudget: 120 } },
          },
        ],
      },
      ctx,
    );
    const after = await ctx.service.getWorkspaceSnapshot();
    expect(after.searchPreferences.discovery.targets).toEqual(
      before.searchPreferences.discovery.targets,
    );
    expect(after.searchPreferences.discovery.runJobBudget).toBe(120);
    await editProfileTool.execute(
      {
        summary: "Two narrow budget updates",
        mode: "apply",
        operations: [
          {
            operation: "replace_search_preferences_fields",
            value: { discovery: { runJobBudget: 121 } },
          },
          {
            operation: "replace_search_preferences_fields",
            value: { discovery: { historyLimit: 4 } },
          },
        ],
      },
      ctx,
    );
    const combined = await ctx.service.getWorkspaceSnapshot();
    expect(combined.searchPreferences.discovery.runJobBudget).toBe(121);
    expect(combined.searchPreferences.discovery.targets).toEqual(
      before.searchPreferences.discovery.targets,
    );
    expect(JSON.stringify(ctx.changes)).not.toContain('"field":"targets"');
    expect(JSON.stringify(ctx.changes)).not.toContain(
      '"label":"Removed targets"',
    );
  });

  it("R3-056 refuses an invisible full-name-only save and returns the saved Basics name", async () => {
    const ctx = world();
    await expect(
      editProfileTool.execute(
        {
          summary: "Name",
          mode: "apply",
          operations: [
            {
              operation: "replace_identity_fields",
              value: { fullName: "Sam Okoro" },
            },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow("firstName");
    const result = await editProfileTool.execute(
      {
        summary: "Name",
        mode: "apply",
        operations: [
          {
            operation: "replace_identity_fields",
            value: {
              fullName: "Sam Okoro",
              firstName: "Sam",
              lastName: "Okoro",
            },
          },
        ],
      },
      ctx,
    );
    expect(result.data).toMatchObject({
      savedIdentity: {
        fullName: "Sam Okoro",
        firstName: "Sam",
        lastName: "Okoro",
      },
    });
    expect((await ctx.service.getWorkspaceSnapshot()).profile).toMatchObject({
      firstName: "Sam",
      lastName: "Okoro",
    });
  });

  it("R3-151 saves and reads both supported language records rather than crediting an import count", async () => {
    const ctx = world();
    const result = await editProfileTool.execute(
      {
        summary: "Languages from the supplied resume",
        mode: "apply",
        operations: [
          {
            operation: "upsert_language_record",
            record: { language: "English", proficiency: "native" },
          },
          {
            operation: "upsert_language_record",
            record: { language: "French", proficiency: "intermediate" },
          },
        ],
      },
      ctx,
    );
    expect(result.data).toMatchObject({
      savedLanguages: [
        expect.objectContaining({ language: "English", proficiency: "native" }),
        expect.objectContaining({
          language: "French",
          proficiency: "intermediate",
        }),
      ],
    });
    expect(PROFILE_EDITING_RULES).toContain(
      "compare work history, education, skills, links and spoken languages",
    );
  });

  it("R3-123 sets the new-job default to Tailored and reads it back", async () => {
    const ctx = world();
    await setDefaultResumeLevelTool.execute({ level: "light" }, ctx);
    const result = await setDefaultResumeLevelTool.execute(
      { level: "tailored" },
      ctx,
    );
    expect(result.data).toMatchObject({ defaultResumeLevel: "tailored" });
    expect(
      (await ctx.service.getWorkspaceSnapshot()).searchPreferences
        .tailoringMode,
    ).toBe("balanced");
    // Reset the selected seed job to a discovered job before shortlisting under the saved default.
    const seed = createSeed();
    seed.savedJobs = [
      {
        ...seed.savedJobs[0]!,
        status: "discovered",
        resumeTailoringMode: null,
        resumeApplicationMode: null,
      },
    ];
    const fresh = createWorkspaceServiceHarness({ seed }).workspaceService;
    await setDefaultResumeLevelTool.execute(
      { level: "light" },
      { ...ctx, service: fresh },
    );
    await setDefaultResumeLevelTool.execute(
      { level: "tailored" },
      { ...ctx, service: fresh },
    );
    const shortlisted = await fresh.queueJobForReview(seed.savedJobs[0]!.id);
    expect(
      shortlisted.reviewQueue.find(
        (item) => item.jobId === seed.savedJobs[0]!.id,
      )?.resumeTailoringMode,
    ).toBe("balanced");
  });

  it("R3-137 / R3-119 opens Background and rejects a resume destination masquerading as Applications", async () => {
    const ctx = world();
    const result = await openInAppTool.execute(
      { screen: "profile", section: "background" },
      ctx,
    );
    expect(ctx.openInApp).toHaveBeenCalledWith(
      "/job-finder/profile?section=background",
    );
    expect(result.summary).toContain("not confirmed");
    await expect(
      openInAppTool.execute(
        { screen: "applications", resume: true, jobId: "job_ready" },
        ctx,
      ),
    ).rejects.toThrow("Choose one destination");
    await openInAppTool.execute(
      { screen: "tracker", applicationRecordId: "record" },
      ctx,
    );
    expect(ctx.openInApp).toHaveBeenLastCalledWith(
      "/job-finder/applications?view=tracker&applicationRecordId=record",
    );
    await openInAppTool.execute(
      { screen: "applications", applicationRecordId: "record" },
      ctx,
    );
    expect(ctx.openInApp).toHaveBeenLastCalledWith(
      "/job-finder/applications?applicationRecordId=record",
    );
  });

  it("R3-126 changes letters and Ask before sending while preserving the resume approach", async () => {
    const ctx = world();
    const before = await ctx.service.getWorkspaceSnapshot();
    const behavior = AiBehaviorPreferenceSchema.parse(
      before.settings.aiBehavior ?? {},
    );
    await updateAiBehaviorTool.execute(
      updateAiBehaviorTool.input.parse({
        aiBehavior: {
          ...behavior,
          applying: {
            ...behavior.applying,
            coverLetterPolicy: "when_possible",
          },
        },
      }),
      ctx,
    );
    const result = await updateApplySettingsTool.execute(
      updateApplySettingsTool.input.parse({
        applicationAutomationMode: "confirm_before_submit",
      }),
      ctx,
    );
    const after = await ctx.service.getWorkspaceSnapshot();
    expect(result.data).toMatchObject({
      savedSettings: { applicationAutomationMode: "confirm_before_submit" },
    });
    expect(after.settings.aiBehavior?.applying.coverLetterPolicy).toBe(
      "when_possible",
    );
    expect(after.searchPreferences.tailoringMode).toBe(
      before.searchPreferences.tailoringMode,
    );
    expect(after.settings.resumeApplicationMode).toBe(
      before.settings.resumeApplicationMode,
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "'Always ask me before sending' means confirm_before_submit",
    );
  });

  it("R3-045 finds only unanswered applications older than 21 days from their sent dates", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    const base = application();
    snapshot.applicationRecords = [
      {
        ...base,
        id: "old",
        crm: {
          ...base.crm!,
          stage: "applied",
          appliedAt: "2026-09-01T12:00:00.000Z",
          lastEmployerActivityAt: null,
        },
      },
      {
        ...base,
        id: "recent",
        crm: {
          ...base.crm!,
          stage: "applied",
          appliedAt: "2026-10-01T12:00:00.000Z",
          lastEmployerActivityAt: null,
        },
      },
      {
        ...base,
        id: "responded",
        crm: {
          ...base.crm!,
          stage: "interview",
          appliedAt: "2026-09-01T12:00:00.000Z",
          lastEmployerActivityAt: "2026-09-20T12:00:00.000Z",
        },
      },
      {
        ...base,
        id: "unknown",
        crm: { ...base.crm!, stage: "applied", appliedAt: null },
      },
    ];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
    const result = await listApplicationsTool.execute(
      listApplicationsTool.input.parse({
        olderThanDays: 21,
        unansweredOnly: true,
        show: false,
      }),
      ctx,
    );
    expect(result.data).toMatchObject({
      applications: [{ id: "old", appliedAt: "2026-09-01T12:00:00.000Z" }],
      missingAppliedDateCount: 1,
    });
  });

  it("R3-046 returns 9am EDT for 13:00Z in New York, including completed interviews", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    const record = application();
    snapshot.applicationRecords = [record];
    record.crm!.interviews = [
      {
        id: "debrief",
        title: "Recruiter debrief",
        startsAt: "2026-10-03T13:00:00.000Z",
        timeZone: "America/New_York",
        status: "completed",
      } as NonNullable<typeof record.crm>["interviews"][number],
    ];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
    const result = await getApplicationTool.execute(
      { jobId: record.jobId },
      ctx,
    );
    expect(result.data).toMatchObject({
      tracking: {
        interviews: [
          expect.objectContaining({
            localTime: "Oct 3, 2026, 9:00 AM EDT",
            startsAt: "2026-10-03T13:00:00.000Z",
          }),
        ],
      },
    });
    expect(
      interviewForModel({ ...record.crm!.interviews[0]!, timeZone: "invalid" })
        .localTime,
    ).toContain("UTC");
  });

  it("R3-048 lists unapproved resumes and final sends even without a browser question", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    snapshot.userActionRequests = [];
    snapshot.applicationRecords = [
      {
        ...application(),
        jobId: "other",
        status: "ready_for_review",
        lastAttemptState: "ready",
        crm: null,
      },
    ];
    snapshot.applyJobResults = [];
    snapshot.reviewQueue = [
      {
        ...snapshot.reviewQueue[0]!,
        jobId: "review",
        resumeReview: { status: "needs_review" },
        resumeApplicationMode: "tailored_per_job",
      },
    ];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
    const result = await listNeedsYouTool.execute({}, ctx);
    expect(result.data).toMatchObject({
      needsYou: { count: 0 },
      resumeReviews: [expect.objectContaining({ kind: "resume_review" })],
      readyToSend: [expect.objectContaining({ kind: "application_send" })],
    });
    const summary = await getWorkspaceSummaryTool.execute({}, ctx);
    expect(summary.data).toMatchObject({
      needsYou: 0,
      readyToSend: 1,
      resumeReviews: 1,
    });
  });

  it("R3-068 / R3-057 gives known privacy controls without inventing a current-pay switch", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Settings > Delete everything > Reset everything",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Applications > tracker offers CSV/JSON export",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "AI features send relevant resume/profile text",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Provider retention and training policies depend",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Settings > Applying");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "expected and current pay questions",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain(
      "does not expose that pay control",
    );
  });

  it("R3-035 shortlists the whole result set in one call, preserving existing selections", async () => {
    const ctx = world();
    const seed = createSeed();
    seed.savedJobs = Array.from({ length: 33 }, (_, index) => ({
      ...seed.savedJobs[0]!,
      id: `bulk_${index}`,
      sourceJobId: `source_${index}`,
      status: "discovered" as const,
      canonicalUrl: `https://example.test/jobs/${index}`,
    }));
    seed.tailoredAssets = [];
    seed.applicationRecords = [];
    const service = createWorkspaceServiceHarness({ seed }).workspaceService;
    await service.queueJobForReview("bulk_0");
    await service.queueJobForReview("bulk_1");
    const set = AssistantResultSetSchema.parse({
      id: "all",
      kind: "jobs",
      label: "All jobs",
      itemIds: seed.savedJobs.map((job) => job.id),
      source: "tool_query",
      conversationId: "conversation",
      createdAt: ctx.session.now(),
    });
    ctx.session.getResultSet = () => Promise.resolve(set);
    const result = await shortlistResultSetTool.execute(
      { resultSetId: "all", limit: 30, evenIfExcludedOrApplied: false },
      { ...ctx, service },
    );
    expect(result.summary).toContain("Shortlisted 30 jobs");
    expect((await service.getWorkspaceSnapshot()).reviewQueue).toHaveLength(32);
  });

  it("R3-035 keeps exact partial progress when selection stops", async () => {
    const ctx = world();
    delete ctx.service.queueJobsForReview;
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    const job = {
      ...snapshot.discoveryJobs[0]!,
      status: "discovered" as const,
      listingActivity: { status: "unknown" as const },
      company: "Synthetic",
    };
    snapshot.applicationRecords = [];
    snapshot.discoveryJobs = [1, 2, 3].map((index) => ({
      ...job,
      id: `stop_${index}`,
    }));
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
    const controller = new AbortController();
    ctx.session.signal = controller.signal;
    vi.spyOn(ctx.service, "queueJobForReview").mockImplementation(() => {
      controller.abort();
      return Promise.resolve(snapshot);
    });
    const result = await shortlistJobsTool.execute(
      {
        jobIds: ["stop_1", "stop_2", "stop_3"],
        evenIfExcludedOrApplied: false,
      },
      ctx,
    );
    expect(result.summary).toContain("Shortlisted 1 job of 3; 2 not started");
  });

  it("R3-037 runs the detail button's assessment action and returns its saved evidence", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    const assess = vi
      .spyOn(ctx.service, "assessJobListing")
      .mockResolvedValue(snapshot);
    const result = await assessJobListingTool.execute(
      { jobId: snapshot.discoveryJobs[0]!.id },
      ctx,
    );
    expect(assess).toHaveBeenCalledWith(snapshot.discoveryJobs[0]!.id);
    expect(ctx.publishWorkspaceUpdate).toHaveBeenCalled();
    expect(result.data).toMatchObject({ id: snapshot.discoveryJobs[0]!.id });
  });
});

it("partial AI settings never restore withdrawn declaration approvals", async () => {
  const ctx = world();
  const before = await ctx.service.getWorkspaceSnapshot();
  await ctx.service.updateAiBehavior({
    aiBehavior: {
      applying: { preApprovedDeclarations: [] },
      profileAssistant: { replyStyle: "conversational" },
    },
  });
  const saved = await ctx.service.getWorkspaceSnapshot();
  const patch = updateAiBehaviorTool.input.parse({
    aiBehavior: { applying: { coverLetterPolicy: "when_possible" } },
  });
  expect(patch.aiBehavior?.applying).not.toHaveProperty(
    "preApprovedDeclarations",
  );
  await updateAiBehaviorTool.execute(patch, ctx);
  const after = await ctx.service.getWorkspaceSnapshot();
  expect(after.settings.aiBehavior?.applying.preApprovedDeclarations).toEqual(
    [],
  );
  expect(after.settings.aiBehavior?.applying.coverLetterPolicy).toBe(
    "when_possible",
  );
  expect(after.settings.aiBehavior?.profileAssistant).toEqual(
    saved.settings.aiBehavior?.profileAssistant,
  );
  expect(after.settings.aiBehavior?.jobSearch).toEqual(
    saved.settings.aiBehavior?.jobSearch,
  );
  expect(after.searchPreferences.tailoringMode).toBe(
    before.searchPreferences.tailoringMode,
  );
  await ctx.service.updateAiBehavior({
    aiBehavior: { jobSearch: { selectivity: "wide_net" } },
  });
  expect(
    (await ctx.service.getWorkspaceSnapshot()).settings.aiBehavior?.applying
      .preApprovedDeclarations,
  ).toEqual([]);
});

it("chat uses the shared Needs you projection for paused records without live requests", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  snapshot.userActionRequests = [];
  snapshot.applyJobResults = [];
  snapshot.reviewQueue = [];
  snapshot.applicationRecords = [
    {
      ...application(),
      status: "drafting",
      lastAttemptState: "paused",
      crm: null,
      nextActionLabel: "Answer relocation",
      consentSummary: { status: "requested", pendingCount: 1 },
    },
  ];
  vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
  expect((await listNeedsYouTool.execute({}, ctx)).data).toMatchObject({
    needsYou: {
      count: 1,
      applications: [expect.objectContaining({ reason: "Answer relocation" })],
    },
  });
  expect((await getWorkspaceSummaryTool.execute({}, ctx)).data).toMatchObject({
    needsYou: 1,
  });
});

it("bulk selection submits eligible jobs once and preserves held-back outcomes", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  snapshot.applicationRecords = [];
  const job = snapshot.discoveryJobs[0]!;
  snapshot.discoveryJobs = Array.from({ length: 50 }, (_, index) => ({
    ...job,
    id: `batch_${index}`,
    status: "discovered",
    listingActivity:
      index === 49
        ? ListingActivitySchema.parse({
            status: "closed",
            observedAt: new Date().toISOString(),
            signalId: "synthetic_closed",
            provenance: "system",
            explanation: "The listing is closed.",
            detail: null,
            confidence: 1,
          })
        : { status: "unknown" },
  }));
  vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
  const single = vi.spyOn(ctx.service, "queueJobForReview");
  const batch = vi.fn<(jobIds: readonly string[]) => Promise<void>>(() =>
    Promise.resolve(),
  );
  ctx.service.queueJobsForReview = batch;
  const result = await shortlistJobsTool.execute(
    {
      jobIds: snapshot.discoveryJobs.map((job) => job.id),
      evenIfExcludedOrApplied: false,
    },
    ctx,
  );
  expect(batch).toHaveBeenCalledOnce();
  expect(batch.mock.calls[0]?.[0]).toHaveLength(49);
  expect(single).not.toHaveBeenCalled();
  expect(result.summary).toContain("Shortlisted 49 jobs of 50");
  expect(result.data).toContainEqual({
    jobId: "batch_49",
    outcome: "refused: the listing says it is closed",
  });
});

it("bulk selection starts at most three slow reads and retains out-of-order outcomes on Stop", async () => {
  const ctx = world();
  delete ctx.service.queueJobsForReview;
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  snapshot.applicationRecords = [];
  const job = snapshot.discoveryJobs[0]!;
  snapshot.discoveryJobs = Array.from({ length: 5 }, (_, index) => ({
    ...job,
    id: `parallel_${index}`,
    status: "discovered",
    listingActivity: { status: "unknown" },
  }));
  vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
  const controller = new AbortController();
  ctx.session.signal = controller.signal;
  const finish = new Map<string, () => void>();
  const queue = vi
    .spyOn(ctx.service, "queueJobForReview")
    .mockImplementation(
      (id) => new Promise((resolve) => finish.set(id, () => resolve(snapshot))),
    );
  const pending = shortlistJobsTool.execute(
    {
      jobIds: snapshot.discoveryJobs.map((job) => job.id),
      evenIfExcludedOrApplied: false,
    },
    ctx,
  );
  await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(3));
  controller.abort();
  finish.get("parallel_2")!();
  finish.get("parallel_0")!();
  finish.get("parallel_1")!();
  const result = await pending;
  expect(queue).toHaveBeenCalledTimes(3);
  expect(result.data).toEqual(
    snapshot.discoveryJobs.map((job, index) => ({
      jobId: job.id,
      outcome: index < 3 ? "shortlisted" : "not started: stopped",
    })),
  );
});

it("chat and the queue retain existing display rules for a legacy quoted question", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  const record = {
    ...application(),
    status: "drafting" as const,
    lastAttemptState: "paused" as const,
    crm: null,
  };
  snapshot.applicationRecords = [record];
  snapshot.userActionRequests = [];
  snapshot.reviewQueue = [];
  snapshot.applyJobResults = [
    ApplyJobResultSchema.parse({
      id: "legacy_result",
      runId: "run",
      jobId: record.jobId,
      applicationRecordId: record.id,
      state: "awaiting_review",
      blockerReason: "required_human_input",
      summary: "A question needs your answer",
      detail: 'Only you can answer "Can you relocate to this city?"',
      startedAt: "2026-10-04T12:00:00.000Z",
      updatedAt: "2026-10-04T12:00:00.000Z",
    }),
  ];
  vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
  expect((await listNeedsYouTool.execute({}, ctx)).data).toMatchObject({
    needsYou: {
      count: 1,
      applications: [expect.objectContaining({ id: record.id })],
    },
    readyToSend: [],
  });
});

describe("opening a retained application", () => {
  it("shows the browser and lends the exact retained result for subsequent browser tools", async () => {
    const ctx = world();
    const snapshot = await ctx.service.getWorkspaceSnapshot();
    snapshot.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result",
        jobId: "job_ready",
        runId: "run",
        applicationRecordId: "record",
        state: "awaiting_review",
        summary: "Ready",
        detail: "Synthetic form",
        startedAt: "2026-10-04T12:00:00.000Z",
        updatedAt: "2026-10-04T12:00:00.000Z",
      }),
    ];
    snapshot.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "record",
        jobId: "job_ready",
        status: "approved",
        lastActionLabel: "Prepared",
        nextActionLabel: "Send",
        company: "Synthetic",
        title: "Analyst",
        lastUpdatedAt: "2026-10-04T12:00:00.000Z",
      }),
    ];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
    const order: string[] = [];
    vi.spyOn(ctx.service, "inspectPreparedApplicationPage").mockResolvedValue(
      page(),
    );
    const browserLease = vi.fn(() => {
      order.push("lease");
      return Promise.resolve({} as AssistantBrowserLease);
    });
    ctx.session.browserLease = browserLease;
    vi.spyOn(ctx.service, "focusPreparedApplicationPage").mockImplementation(
      () => {
        order.push("focus");
        return Promise.resolve(snapshot);
      },
    );
    const show = vi.fn(() => {
      order.push("show");
      return Promise.resolve();
    });
    const lease = vi.fn();
    ctx.ports.browser = { show, visibleTab: vi.fn(() => null), lease };
    const outcome = await continueApplicationTool.execute(
      { jobId: "job_ready", openPage: true },
      ctx,
    );
    expect(order).toEqual(["focus", "lease", "show"]);
    expect(browserLease).toHaveBeenCalledWith({
      applicationResultId: "result",
    });
    expect(lease).not.toHaveBeenCalled();
    expect(outcome.summary).toContain("Browser tools now use this filled form");
    show.mockRejectedValueOnce(new Error("Browser could not open"));
    await expect(
      continueApplicationTool.execute(
        { jobId: "job_ready", openPage: true },
        ctx,
      ),
    ).rejects.toThrow("Browser could not open");
  });
});

it("chat send cards name the result rather than claiming failed or unconfirmed sends were SENT", async () => {
  const { sendApplicationsTool } = await import("./application-tools");
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  snapshot.applicationRecords = [application()];
  vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
  ctx.session.grants = {
    list: () =>
      Promise.resolve([
        {
          id: "grant",
          jobIds: ["job_ready"],
          status: "active",
          action: "prepare_and_send",
        },
      ] as never),
    save: vi.fn(),
  };
  ctx.ports.sendPreparedApplications = vi.fn(() =>
    Promise.resolve({
      sentJobIds: [],
      failed: [{ jobId: "job_ready", reason: "Waiting for approval" }],
    }),
  );
  const result = await sendApplicationsTool.execute(
    { jobIds: ["job_ready"] },
    ctx,
  );
  expect(result.parts?.[0]).toMatchObject({
    type: "records",
    title: "Sending results",
  });
  expect(result.summary).toContain("0 applications");
  expect(result.summary).toContain("1 not sent");
  snapshot.applyJobResults = [1, 2].map(
    (index) =>
      ({
        jobId: "job_ready",
        updatedAt: `2026-10-04T12:00:0${index}.000Z`,
        privacyReceipt: { submissionOutcome: { outcome: "outcome_uncertain" } },
      }) as unknown as (typeof snapshot.applyJobResults)[number],
  );
  const uncertain = await sendApplicationsTool.execute(
    { jobIds: ["job_ready"] },
    ctx,
  );
  expect(uncertain.summary).toContain("1 send unconfirmed");
  expect(uncertain.summary).not.toContain("not sent");
});

it("refuses unmentioned jobs in second person without echoing internal ids", async () => {
  const ctx = world();
  ctx.session.sourceMessage = AssistantMessageSchema.parse({
    id: "message",
    conversationId: "conversation",
    role: "user",
    origin: "sidebar",
    createdAt: "2026-10-05T12:00:00Z",
    parts: [{ type: "text", text: "Send these" }],
  });
  ctx.session.listResultSets = () => Promise.resolve([]);
  await expect(
    recordInstructionTool.execute(
      {
        action: "prepare_and_send",
        jobIds: ["job_target_site_27"],
        quote: "Send these",
        constraints: [],
      },
      ctx,
    ),
  ).rejects.toThrow("None of those jobs were in your message");
});
