import { assistantTestReads } from "../store-reads.test-support";
import { randomUUID } from "node:crypto";
import {
  AiBehaviorPreferenceSchema,
  AssistantResultSetSchema,
  AssistantMessageSchema,
  type RawApplyPage,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../../workspace-service.test-support";
import type { AssistantBrowserLease, AssistantHostPorts } from "../ports";
import { ASSISTANT_SYSTEM_PROMPT } from "../prompt";
import type { AssistantTurnSession } from "../tool-kit";
import { recordInstructionTool } from "./application-tools";
import {
  browserOpenTool,
  browserUseApplicationTool,
  browserTools,
} from "./browser-tools";
import { editProfileTool, PROFILE_EDITING_RULES } from "./profile-tools";
import {
  setDefaultResumeLevelTool,
  updateAiBehaviorTool,
  updateApplySettingsTool,
} from "./settings-tools";
import { openInAppTool } from "./workspace-tools";

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
    ...assistantTestReads(service),
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
      // Typing now waits once to check the field kept its answer.
      wait: () => Promise.resolve(),
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

  it.each(["ready", "stopped"] as const)(
    "reads a %s application's exact retained form without leasing, showing or focusing a tab",
    async (state) => {
      const ctx = world();
      ctx.ports.readCommand = vi.fn(() =>
        Promise.resolve([{ id: 7, attempt: 2, state }]),
      ) as unknown as AssistantHostPorts["readCommand"];
      const visibleTab = vi.fn();
      const inspectApplication = vi.fn(() =>
        Promise.resolve(page("http://127.0.0.1:47950/spruce/apply/1")),
      );
      const leaseTab = vi.fn();
      ctx.ports.browser = { visibleTab, lease: leaseTab, inspectApplication };
      const browserLease = vi.fn();
      ctx.session.browserLease = browserLease;
      const observed = await browserUseApplicationTool.execute(
        { jobId: "3" },
        ctx,
      );
      expect(inspectApplication).toHaveBeenCalledWith(
        "application_7_attempt_2",
      );
      expect(browserLease).not.toHaveBeenCalled();
      expect(leaseTab).not.toHaveBeenCalled();
      expect(visibleTab).not.toHaveBeenCalled();
      expect(observed.data).toMatchObject({
        url: "http://127.0.0.1:47950/spruce/apply/1",
      });
      expect(observed.summary).toContain("nothing was sent");
    },
  );

  it("refuses to inspect an application being sent or already sent", async () => {
    const ctx = world();
    for (const state of ["submitting", "submitted"]) {
      ctx.ports.readCommand = vi.fn(() =>
        Promise.resolve([{ id: 7, attempt: 2, state }]),
      ) as unknown as AssistantHostPorts["readCommand"];
      const inspectApplication = vi.fn();
      ctx.ports.browser = {
        visibleTab: vi.fn(),
        lease: vi.fn(),
        inspectApplication,
      };
      await expect(
        browserUseApplicationTool.execute({ jobId: "3" }, ctx),
      ).rejects.toThrow("no prepared form");
      expect(inspectApplication).not.toHaveBeenCalled();
    }
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
      {
        ...ctx,
        service: fresh,
        ports: { ...ctx.ports, ...assistantTestReads(fresh) },
      },
    );
    await setDefaultResumeLevelTool.execute(
      { level: "tailored" },
      {
        ...ctx,
        service: fresh,
        ports: { ...ctx.ports, ...assistantTestReads(fresh) },
      },
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
        { screen: "applications", resume: true, jobId: 7 },
        ctx,
      ),
    ).rejects.toThrow("Choose one destination");
    await openInAppTool.execute({ screen: "applications" }, ctx);
    expect(ctx.openInApp).toHaveBeenLastCalledWith("/job-finder/applications");
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

  it("R3-068 / R3-057 gives known privacy controls without inventing a current-pay switch", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Settings > Delete everything > Reset everything",
    );
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      "Applications offers CSV export for its current filter",
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
