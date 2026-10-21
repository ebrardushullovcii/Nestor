// @vitest-environment jsdom

import { useForm } from "react-hook-form";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DiscoveryRunRecordSchema,
  JobSearchPreferencesSchema,
  type DiscoveryRunRecord,
  type SourceAccessPrompt,
  type SourceDebugRunDetails,
} from "@nestor/contracts";
import {
  createSearchPreferencesEditorValues,
  type SearchPreferencesEditorValues,
} from "../../lib/profile-editor";
import { buildJobSourceProgress } from "../../lib/profile-screen-view-model";
import {
  deriveEnabledSourceHealthCounts,
  deriveSourceHealthSignals,
} from "@nestor/job-finder/source-health";
import {
  JOB_SOURCES_PAGE_SIZE,
  parseJobSourceUrls,
  ProfileJobSourcesTab,
} from "./profile-job-sources-tab";
import { resetSourceCheckQueueForTests } from "../../lib/source-check-queue";
import {
  describeSourcesNeedingAttention,
  listSourcesNeedingAttention,
} from "../../lib/source-attention";
import { SourceCheckQueueRunner } from "../../lib/source-check-queue-runner";

type DiscoveryTarget =
  SearchPreferencesEditorValues["discoveryTargets"][number];

const scrollIntoViewMock = vi.fn();
let scrollIntoViewTargets: Element[] = [];

function getLastScrollIntoViewTarget(): Element | null {
  return scrollIntoViewTargets[scrollIntoViewTargets.length - 1] ?? null;
}

function createTarget(
  index: number,
  overrides: Partial<DiscoveryTarget> = {},
): DiscoveryTarget {
  return {
    id: `target_${index.toString().padStart(3, "0")}`,
    label: `Company ${index.toString().padStart(3, "0")}`,
    startingUrl: `https://jobs-${index}.example.com/openings`,
    enabled: index <= 4,
    adapterKind: "auto",
    customInstructions: "",
    instructionStatus: "missing",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
    ...overrides,
  };
}

function createTargets(count = 507): DiscoveryTarget[] {
  return Array.from({ length: count }, (_, index) =>
    createTarget(index + 1, index === 399 ? { label: "OpenAI" } : {}),
  );
}

function JobSourcesHarness(props: {
  accessPrompts?: readonly SourceAccessPrompt[];
  activeDiscoveryRun?: DiscoveryRunRecord | null;
  discoveryRuns?: readonly DiscoveryRunRecord[];
  isSourceDebugPending?: (targetId: string) => boolean;
  onRunSourceDebug?: (targetId: string) => void;
  requestedFilter?: string | null;
  targets?: DiscoveryTarget[];
}) {
  const preferences = JobSearchPreferencesSchema.parse({
    targetRoles: [],
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    discovery: { targets: [] },
  });
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: {
      ...createSearchPreferencesEditorValues(preferences),
      discoveryTargets: props.targets ?? createTargets(),
    },
  });

  return (
    <>
      <SourceCheckQueueRunner
        isSourceDebugPending={props.isSourceDebugPending ?? (() => false)}
        onRunSourceDebug={props.onRunSourceDebug ?? (() => undefined)}
        recentSourceDebugRuns={[]}
      />
      <ProfileJobSourcesTab
        requestedFilter={props.requestedFilter ?? null}
        activeDiscoveryRun={props.activeDiscoveryRun ?? null}
        discoveryRuns={props.discoveryRuns ?? []}
        isBrowserSessionPending={() => false}
        isSourceDebugPending={props.isSourceDebugPending ?? (() => false)}
        isSourceInstructionPending={() => false}
        isSourceInstructionVerifyPending={() => false}
        isTargetDiscoveryPending={() => false}
        onGetSourceDebugRunDetails={() =>
          Promise.reject<SourceDebugRunDetails>(
            new Error("No debug run in this fixture."),
          )
        }
        onOpenBrowserSessionForTarget={() => undefined}
        onRunDiscoveryForTarget={() => undefined}
        onRunSourceDebug={props.onRunSourceDebug ?? (() => undefined)}
        onSaveSourceInstructionArtifact={() => undefined}
        onVerifySourceInstructions={() => undefined}
        preferencesForm={preferencesForm}
        recentSourceDebugRuns={[]}
        sourceAccessPrompts={props.accessPrompts ?? []}
        sourceInstructionArtifacts={[]}
      />
    </>
  );
}

describe("ProfileJobSourcesTab", () => {
  it("opens on Needs attention from Home's line, with Home's count", () => {
    const targets = [
      createTarget(1, { id: "target_failing", staleReason: "HTTP 404" }),
      createTarget(2, { id: "target_fine" }),
      createTarget(3, {
        id: "target_off",
        enabled: false,
        staleReason: "HTTP 404",
      }),
    ];
    render(
      <JobSourcesHarness requestedFilter="needs_attention" targets={targets} />,
    );

    const homeCount = listSourcesNeedingAttention(
      targets,
      deriveSourceHealthSignals({}),
    ).length;
    expect(describeSourcesNeedingAttention(homeCount)).toBe(
      "1 job source needs attention.",
    );
    expect(
      screen
        .getByRole("button", { name: "Needs attention" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText(`${homeCount} of 3 sources`)).toBeTruthy();
  });

  it("normalizes newline and comma separated source URLs", () => {
    expect(
      parseJobSourceUrls(
        "jobs.example.com, https://company.example/careers\nnot a url\njobs.example.com",
      ),
    ).toEqual({
      urls: [
        "https://jobs.example.com/",
        "https://company.example/careers",
      ],
      invalid: ["not a url"],
    });
  });

  it("rejects literal spaces in addresses instead of saving a pasted list as a path", () => {
    expect(
      parseJobSourceUrls(
        "not a url\nhttps://not%20a%20url/jobs\nhttps://jobs.example.com/Job Openings?team=Design Systems",
      ),
    ).toEqual({
      urls: ["https://jobs.example.com/Job"],
      invalid: [
        "not a url",
        "https://not%20a%20url/jobs",
        "Openings?team=Design Systems",
      ],
    });
  });

  it("rejects whitespace hosts even when the renderer URL parser accepts them", () => {
    const NativeUrl = globalThis.URL;
    class PermissiveUrl extends NativeUrl {
      constructor(input: string | URL, base?: string | URL) {
        const acceptsWhitespaceHost = input === "https://not a url";
        super(acceptsWhitespaceHost ? "https://valid.example/" : input, base);
        if (acceptsWhitespaceHost) {
          Object.defineProperty(this, "hostname", { value: "not%20a%20url" });
        }
      }
    }
    vi.stubGlobal("URL", PermissiveUrl);
    try {
      expect(parseJobSourceUrls("not a url")).toEqual({
        urls: [],
        invalid: ["not a url"],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves case-sensitive paths and query values while deduplicating host casing", () => {
    expect(
      parseJobSourceUrls(
        "https://JOBS.example.com/Jobs?team=ABC\nhttps://jobs.example.com/Jobs?team=ABC\nhttps://jobs.example.com/jobs?team=ABC\nhttps://jobs.example.com/Jobs?team=abc",
      ),
    ).toEqual({
      urls: [
        "https://jobs.example.com/Jobs?team=ABC",
        "https://jobs.example.com/jobs?team=ABC",
        "https://jobs.example.com/Jobs?team=abc",
      ],
      invalid: [],
    });
  });

  it("shows distinct URLs beneath shared source labels", () => {
    const urls = [
      "https://jobs.example.com/openings?team=Design",
      "https://jobs.example.com/openings?team=Engineering",
    ];
    render(
      <JobSourcesHarness
        targets={urls.map((startingUrl, index) =>
          createTarget(index + 1, { label: "Company careers", startingUrl }),
        )}
      />,
    );
    expect(screen.getAllByRole("heading", { name: "Company careers" })).toHaveLength(2);
    for (const url of urls) expect(screen.getByText(url)).toBeTruthy();
  });

  it("adds case-distinct URLs beside an existing source", () => {
    render(
      <JobSourcesHarness
        targets={[
          createTarget(1, {
            startingUrl: "https://jobs.example.com/Jobs?team=ABC",
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add sources" }));
    fireEvent.change(screen.getByLabelText("Add sources"), {
      target: {
        value:
          "https://JOBS.example.com/Jobs?team=ABC\nhttps://jobs.example.com/jobs?team=ABC\nhttps://jobs.example.com/Jobs?team=abc",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 sources" }));
    expect(screen.getByText("3 sources")).toBeTruthy();
  });

  beforeAll(() => {
    Element.prototype.scrollIntoView = function scrollIntoViewTrackingStub(
      this: Element,
      ...args: Parameters<typeof Element.prototype.scrollIntoView>
    ) {
      scrollIntoViewTargets.push(this);
      scrollIntoViewMock.apply(this, args);
    };
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    resetSourceCheckQueueForTests();
    vi.clearAllMocks();
    scrollIntoViewTargets = [];
  });

  it("keeps a 507-source catalog bounded to one 25-row page", async () => {
    const targets = createTargets();
    const { container } = render(<JobSourcesHarness targets={targets} />);

    expect(buildJobSourceProgress(targets)).toEqual({
      filled: 4,
      percent: 1,
      required: { filled: 1, total: 1 },
      total: 507,
    });
    expect(container.querySelectorAll("[data-compact-source-id]")).toHaveLength(
      JOB_SOURCES_PAGE_SIZE,
    );
    expect(screen.getByText("1–25 of 507")).toBeTruthy();
    expect(screen.getByText("Company 001")).toBeTruthy();
    expect(screen.queryByText("Company 026")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("26–50 of 507")).toBeTruthy();
    expect(screen.getByText("Company 026")).toBeTruthy();
    expect(screen.queryByText("Company 001")).toBeNull();
    await waitFor(() =>
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: "auto",
        block: "start",
      }),
    );
    expect(getLastScrollIntoViewTarget()).toBe(
      document.getElementById("profile-job-sources-list-heading"),
    );
  });

  it("keeps a compact top source pager reachable beside the Source library heading", async () => {
    render(<JobSourcesHarness />);

    const topPager = screen.getByRole("navigation", {
      name: "Job source pages (top of list)",
    });
    const listHeading = screen.getByText("Source library");
    expect(listHeading.closest("article")?.contains(topPager)).toBe(true);
    expect(topPager.className).toContain("flex-wrap");
    expect(
      within(topPager).getByRole("button", {
        name: "Previous source page (top of list)",
      }),
    ).toHaveProperty("disabled", true);
    expect(within(topPager).getByText("Page 1 of 21")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Next" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Previous" })).toHaveLength(1);

    const bottomPager = screen.getByRole("navigation", {
      name: "Job source pages",
    });
    expect(bottomPager).not.toBe(topPager);
    expect(bottomPager.className).toContain("flex-wrap");

    fireEvent.click(
      within(topPager).getByRole("button", {
        name: "Next source page (top of list)",
      }),
    );

    expect(screen.getByText("26–50 of 507")).toBeTruthy();
    expect(screen.getByText("Company 026")).toBeTruthy();
    expect(screen.queryByText("Company 001")).toBeNull();
    expect(
      within(topPager).getByRole("button", {
        name: "Previous source page (top of list)",
      }),
    ).toHaveProperty("disabled", false);
    await waitFor(() =>
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: "auto",
        block: "start",
      }),
    );
    expect(getLastScrollIntoViewTarget()).toBe(
      document.getElementById("profile-job-sources-list-heading"),
    );
  });

  it("keeps top pager disabled states truthful at both pagination boundaries", () => {
    render(<JobSourcesHarness targets={createTargets(30)} />);
    const topPager = screen.getByRole("navigation", {
      name: "Job source pages (top of list)",
    });
    const topPrevious = () =>
      within(topPager).getByRole("button", {
        name: "Previous source page (top of list)",
      });
    const topNext = () =>
      within(topPager).getByRole("button", {
        name: "Next source page (top of list)",
      });

    expect(topPrevious()).toHaveProperty("disabled", true);
    expect(topNext()).toHaveProperty("disabled", false);

    fireEvent.click(topNext());

    expect(screen.getByText("26–30 of 30")).toBeTruthy();
    expect(screen.queryByText("Company 001")).toBeNull();
    expect(topNext()).toHaveProperty("disabled", true);
    expect(topPrevious()).toHaveProperty("disabled", false);
    expect(getLastScrollIntoViewTarget()).toBe(
      document.getElementById("profile-job-sources-list-heading"),
    );
    const writeCountAfterNext = scrollIntoViewTargets.length;

    fireEvent.click(topPrevious());

    expect(screen.getByText("1–25 of 30")).toBeTruthy();
    expect(topPrevious()).toHaveProperty("disabled", true);
    expect(topNext()).toHaveProperty("disabled", false);
    expect(scrollIntoViewTargets.length).toBe(writeCountAfterNext + 1);
    expect(getLastScrollIntoViewTarget()).toBe(
      document.getElementById("profile-job-sources-list-heading"),
    );
  });

  it("omits both pagers when every source fits one page", () => {
    render(<JobSourcesHarness targets={createTargets(3)} />);

    expect(
      screen.queryByRole("navigation", {
        name: "Job source pages (top of list)",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Job source pages" }),
    ).toBeNull();
    expect(screen.getByText("3 sources")).toBeTruthy();
  });

  it("searches the complete catalog and filters enabled or attention sources", async () => {
    const targets = createTargets();
    // Attention is scoped to enabled sources, so the prompted source must be
    // enabled to appear under the Needs attention view.
    const promptedIndex = targets.findIndex(
      (target) => target.id === "target_010",
    );
    targets[promptedIndex] = { ...targets[promptedIndex]!, enabled: true };
    const attentionPrompt: SourceAccessPrompt = {
      targetId: "target_010",
      targetLabel: "Company 010",
      targetUrl: "https://jobs-10.example.com/openings",
      state: "prompt_login_required",
      summary: "Sign in before retrying.",
      detail: null,
      actionLabel: "Open sign-in",
      rerunLabel: null,
      updatedAt: "2026-08-11T10:00:00.000Z",
    };
    const { container } = render(
      <JobSourcesHarness accessPrompts={[attentionPrompt]} targets={targets} />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a source" }), {
      target: { value: "openai" },
    });

    await waitFor(() => expect(screen.getByText("OpenAI")).toBeTruthy());
    expect(screen.getByText("1 of 507 sources")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    await waitFor(() =>
      expect(
        container.querySelectorAll("[data-compact-source-id]"),
      ).toHaveLength(0),
    );

    fireEvent.click(screen.getByRole("button", { name: "Show all sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    expect(container.querySelectorAll("[data-compact-source-id]")).toHaveLength(
      5,
    );
    expect(screen.getByText("5 of 507 sources")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    // Never-checked sources are fine to search; only the prompted Company 010
    // has something to look at.
    expect(container.querySelectorAll("[data-compact-source-id]")).toHaveLength(
      1,
    );
    expect(screen.getByText("Company 010")).toBeTruthy();
  });

  it("reports the same attention counts and labels as the Home projection across source states", () => {
    const verifiedAt = "2026-08-20T09:00:00.000Z";
    const targets: DiscoveryTarget[] = [
      createTarget(1, {
        id: "target_healthy",
        label: "Healthy source",
        instructionStatus: "validated",
        lastVerifiedAt: verifiedAt,
      }),
      // First-run default: enabled but never checked.
      createTarget(2, { id: "target_never_run", label: "Never run source" }),
      createTarget(3, {
        id: "target_failing",
        label: "Failing source",
        instructionStatus: "validated",
        lastVerifiedAt: verifiedAt,
        staleReason: "Starting page URL changed.",
      }),
      createTarget(4, {
        id: "target_unsupported",
        label: "Unsupported source",
        instructionStatus: "unsupported",
        lastVerifiedAt: verifiedAt,
      }),
      createTarget(5, {
        id: "target_login",
        label: "Login locked source",
        enabled: true,
        instructionStatus: "validated",
        lastVerifiedAt: verifiedAt,
      }),
      // Disabled sources must not inflate active health.
      createTarget(6, {
        id: "target_disabled_never_run",
        label: "Disabled never run",
        enabled: false,
      }),
      createTarget(7, {
        id: "target_disabled_failing",
        label: "Disabled failing",
        enabled: false,
        instructionStatus: "validated",
        lastVerifiedAt: verifiedAt,
        staleReason: "Verification failed.",
      }),
    ];
    const loginPrompt: SourceAccessPrompt = {
      targetId: "target_login",
      targetLabel: "Login locked source",
      targetUrl: "https://jobs-5.example.com/openings",
      state: "prompt_login_required",
      summary: "Sign in before retrying.",
      detail: null,
      actionLabel: "Open sign-in",
      rerunLabel: null,
      updatedAt: "2026-08-20T09:30:00.000Z",
    };
    const { container } = render(
      <JobSourcesHarness accessPrompts={[loginPrompt]} targets={targets} />,
    );

    // The Home dashboard derives identical numbers from the same workspace
    // state through the shared `@nestor/job-finder/source-health`
    // classifier; assert the rendered cards agree with it exactly.
    const expectedCounts = deriveEnabledSourceHealthCounts(
      targets,
      deriveSourceHealthSignals({ sourceAccessPrompts: [loginPrompt] }),
    );
    expect(expectedCounts).toEqual({
      healthy: 2,
      needsAttention: 3,
      running: 0,
      total: 5,
    });

    // The stat tiles are gone: the filter row and the list caption already
    // said the same four numbers, three times, above a short list.
    expect(
      screen.queryByRole("list", { name: "Job source summary" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));

    const visibleRows = Array.from(
      container.querySelectorAll("[data-compact-source-id]"),
    ).map((node) => node.getAttribute("data-compact-source-id"));
    expect(visibleRows).toEqual([
      "target_failing",
      "target_unsupported",
      "target_login",
    ]);

    for (const rowId of visibleRows) {
      const row = container.querySelector(
        `[data-compact-source-id="${rowId}"]`,
      ) as HTMLElement;
      expect(within(row).getByText("Needs attention")).toBeTruthy();
    }

    // Every attention row states its reason instead of an unexplained badge.
    expect(
      within(
        container.querySelector(
          '[data-compact-source-id="target_login"]',
        ) as HTMLElement,
      ).getByText("Blocked: waiting for you to sign in."),
    ).toBeTruthy();

    // Back on the full library view, disabled problem sources stay explicitly
    // labeled as disabled without an attention badge.
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    for (const disabledRowId of [
      "target_disabled_never_run",
      "target_disabled_failing",
    ]) {
      const row = container.querySelector(
        `[data-compact-source-id="${disabledRowId}"]`,
      ) as HTMLElement;
      expect(within(row).queryByText("Needs attention")).toBeNull();
      expect(within(row).queryByText("Disabled")).toBeNull();
    }
  });

  it("agrees with the Home badge when a never-verified source completed a run", () => {
    const targets = [
      createTarget(1, {
        id: "target_completed_run",
        label: "Wellfound",
        enabled: true,
        instructionStatus: "missing",
        lastVerifiedAt: null,
      }),
    ];
    const discoveryRuns = [
      DiscoveryRunRecordSchema.parse({
        id: "discovery_run_1",
        state: "completed",
        startedAt: "2026-09-02T09:00:00.000Z",
        completedAt: "2026-09-02T09:04:00.000Z",
        targetIds: ["target_completed_run"],
        targetExecutions: [
          {
            targetId: "target_completed_run",
            adapterKind: "auto",
            state: "completed",
            startedAt: "2026-09-02T09:00:00.000Z",
            completedAt: "2026-09-02T09:04:00.000Z",
            jobsFound: 12,
          },
        ],
      }),
    ];

    // Home derives its badge from the same classifier plus completed-run
    // evidence, so Profile must not contradict it with a red badge.
    expect(
      deriveEnabledSourceHealthCounts(targets, {
        succeededTargetIds: new Set(["target_completed_run"]),
      }),
    ).toEqual({ healthy: 1, needsAttention: 0, running: 0, total: 1 });

    const { container } = render(
      <JobSourcesHarness discoveryRuns={discoveryRuns} targets={targets} />,
    );

    const row = container.querySelector(
      '[data-compact-source-id="target_completed_run"]',
    ) as HTMLElement;
    expect(within(row).queryByText("Needs attention")).toBeNull();
    expect(within(row).queryByText("No guidance yet")).toBeNull();
    expect(
      within(row).getByText("Readable · 12 job cards found."),
    ).toBeTruthy();

    // Nothing in the list claims attention for a source that just completed
    // a run; the filter is the only place that count lives now.
    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(container.querySelectorAll("[data-compact-source-id]")).toHaveLength(
      0,
    );
  });

  it("does not flag a source whose search completed with no jobs", () => {
    const targets = [
      createTarget(1, {
        id: "target_empty_run",
        label: "We Work Remotely",
        enabled: true,
        instructionStatus: "validated",
        lastVerifiedAt: "2026-09-01T09:00:00.000Z",
      }),
    ];
    const discoveryRuns = [
      DiscoveryRunRecordSchema.parse({
        id: "discovery_run_empty",
        state: "completed",
        startedAt: "2026-09-02T09:00:00.000Z",
        completedAt: "2026-09-02T09:04:00.000Z",
        targetIds: ["target_empty_run"],
        targetExecutions: [
          {
            targetId: "target_empty_run",
            adapterKind: "auto",
            state: "completed",
            startedAt: "2026-09-02T09:00:00.000Z",
            completedAt: "2026-09-02T09:04:00.000Z",
            jobsFound: 0,
          },
        ],
      }),
    ];

    const { container } = render(
      <JobSourcesHarness discoveryRuns={discoveryRuns} targets={targets} />,
    );

    const row = container.querySelector(
      '[data-compact-source-id="target_empty_run"]',
    ) as HTMLElement;
    // An empty listing is not a broken source: the row says what happened and
    // carries no "Needs attention" badge (Home is neutral about it too).
    expect(within(row).queryByText("Needs attention")).toBeNull();
    expect(within(row).getByText("Completed, 0 jobs found.")).toBeTruthy();
  });

  it("names the unmatched query in the empty state and restores the full list", async () => {
    const { container } = render(
      <JobSourcesHarness targets={createTargets(3)} />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a source" }), {
      target: { value: "nonexistent" },
    });

    await waitFor(() =>
      expect(screen.getByText('No sources match "nonexistent"')).toBeTruthy(),
    );
    expect(
      screen.getAllByRole("status").map((node) => node.textContent),
    ).toContain('No sources match "nonexistent"');

    fireEvent.click(screen.getByRole("button", { name: "Show all sources" }));

    expect(screen.queryByText('No sources match "nonexistent"')).toBeNull();
    expect(container.querySelectorAll("[data-compact-source-id]")).toHaveLength(
      3,
    );
    expect(screen.getByText("3 sources")).toBeTruthy();
  });

  it("supports quick enablement and mounts the full editor only for the opened source", () => {
    const { container } = render(
      <JobSourcesHarness targets={createTargets(30)} />,
    );
    const companyFive = screen.getByText("Company 005").closest("article");

    expect(companyFive).toBeTruthy();
    fireEvent.click(
      within(companyFive as HTMLElement).getByRole("checkbox", {
        name: "Include Company 005 in searches",
      }),
    );
    // The checkbox is the state: no separate Enabled/Disabled badge repeats it.
    expect(
      within(companyFive as HTMLElement)
        .getByRole("checkbox", { name: "Include Company 005 in searches" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(companyFive as HTMLElement).queryByText("Enabled"),
    ).toBeNull();

    fireEvent.click(
      within(companyFive as HTMLElement).getByRole("button", {
        name: "Edit Company 005",
      }),
    );

    expect(
      container.querySelectorAll("[data-expanded-source-id]"),
    ).toHaveLength(1);
    expect(container.querySelectorAll("[data-compact-source-id]")).toHaveLength(
      JOB_SOURCES_PAGE_SIZE - 1,
    );
    expect(screen.getByDisplayValue("Company 005")).toBeTruthy();
    expect(
      screen.getByDisplayValue("https://jobs-5.example.com/openings"),
    ).toBeTruthy();
  });

  it("turns a newly added source on, and still offers a way to turn it off", () => {
    render(<JobSourcesHarness targets={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Add sources" }));
    fireEvent.change(screen.getByLabelText("Add sources"), {
      target: { value: "https://gamma.example/careers" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add 1 source" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit gamma.example/careers" }));

    const includeToggle = screen.getByRole("checkbox", {
      name: "Include this source in searches",
    });
    expect(includeToggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(includeToggle);

    expect(
      screen
        .getByRole("checkbox", { name: "Include this source in searches" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("adds many sources in one form update and turns them on", () => {
    render(<JobSourcesHarness targets={[createTarget(1)]} />);

    fireEvent.click(screen.getByRole("button", { name: "Add sources" }));
    fireEvent.change(screen.getByLabelText("Add sources"), {
      target: {
        value:
          "https://alpha.example/careers\nbeta.example/jobs, https://jobs-1.example.com/openings",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add 2 sources" }));

    expect(screen.getByText("Added and turned on 2 sources.")).toBeTruthy();
    expect(screen.getByText("3 sources")).toBeTruthy();
    expect(screen.getByText("alpha.example/careers")).toBeTruthy();
    expect(screen.getByText("https://alpha.example/careers")).toBeTruthy();
    expect(screen.getByText("beta.example/jobs")).toBeTruthy();
    expect(screen.getByText("https://beta.example/jobs")).toBeTruthy();
  });

  it("checks every listed source one at a time and stops on request", () => {
    const onRunSourceDebug = vi.fn<(targetId: string) => void>();
    const pending = new Set<string>();
    const targets = [
      createTarget(1),
      createTarget(2),
      createTarget(3),
      createTarget(4, { enabled: false }),
    ];
    const view = render(
      <JobSourcesHarness
        isSourceDebugPending={(targetId) => pending.has(targetId)}
        onRunSourceDebug={onRunSourceDebug}
        targets={targets}
      />,
    );
    const rerender = () =>
      view.rerender(
        <JobSourcesHarness
          isSourceDebugPending={(targetId) => pending.has(targetId)}
          onRunSourceDebug={onRunSourceDebug}
          targets={targets}
        />,
      );

    // Only sources that are on can be checked, so the off one is not counted.
    fireEvent.click(
      screen.getByRole("button", { name: "Check all 3 sources" }),
    );
    expect(onRunSourceDebug).toHaveBeenCalledTimes(1);
    expect(onRunSourceDebug).toHaveBeenLastCalledWith("target_001");

    // While the first check is in flight nothing else starts.
    pending.add("target_001");
    rerender();
    expect(
      screen.getByRole("button", { name: /Checking 1 of 3 · Company 001/ }),
    ).toBeTruthy();
    expect(onRunSourceDebug).toHaveBeenCalledTimes(1);

    // When it finishes, the next one starts on its own.
    pending.delete("target_001");
    rerender();
    expect(onRunSourceDebug).toHaveBeenCalledTimes(2);
    expect(onRunSourceDebug).toHaveBeenLastCalledWith("target_002");

    // Stop clears what is still waiting; the running check is left alone.
    pending.add("target_002");
    rerender();
    fireEvent.click(
      screen.getByRole("button", { name: /Checking 2 of 3 · Company 002/ }),
    );
    pending.delete("target_002");
    rerender();
    expect(onRunSourceDebug).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: "Check all 3 sources" }),
    ).toBeTruthy();
  });

  it("truncates long source names in rows while exposing the complete name", () => {
    const longName = "SourceNameWithoutAnyWordBreaksAtAll";
    const { container } = render(
      <JobSourcesHarness targets={[createTarget(1, { label: longName })]} />,
    );

    const title = container.querySelector("h4");
    expect(title?.textContent).toBe(longName);
    expect(title?.className).toContain("min-w-0");
    expect(title?.className).toContain("max-w-full");
    expect(title?.className).toContain("truncate");
    expect(title?.getAttribute("title")).toBe(longName);
  });
});

it("parses a list supplied without a paste event and refuses malformed mixed input", () => {
  expect(
    parseJobSourceUrls("https://one.example/careers https://two.example/jobs"),
  ).toEqual({
    urls: ["https://one.example/careers", "https://two.example/jobs"],
    invalid: [],
  });
  expect(
    parseJobSourceUrls(
      "https://one.example/careers not a web address https://two.example/jobs",
    ).invalid,
  ).toEqual(["not a web address"]);
});
