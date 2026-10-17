// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ApplicationRecordSchema,
  UserActionRequestSchema,
  type UserActionCommandInput,
} from "@nestor/contracts";
import { countNeedsYouItems } from "../../lib/needs-you-count";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActionsScreen,
  getUserActionContextRoute,
  toActionableInstructions,
} from "./actions-screen";

afterEach(cleanup);

function createRequest(input: {
  actionUrl?: string | null;
  applicationRecordId?: string | null;
  id: string;
  scope: "application" | "discovery_source";
  attemptCount?: number;
  state?: "pending" | "still_blocked" | "verifying" | "resolved";
}) {
  const applicationScope = {
    type: "application" as const,
    runId: "run_1",
    jobId: "job_1",
    applicationRecordId: input.applicationRecordId ?? null,
    resultId: null,
    replayCheckpointId: null,
    source: "target_site" as const,
  };
  const discoveryScope = {
    type: "discovery_source" as const,
    targetId: "target_1",
    source: "target_site" as const,
    sourceDebugRunId: null,
    sourceDebugAttemptId: null,
  };

  return UserActionRequestSchema.parse({
    id: input.id,
    dedupeKey: `dedupe_${input.id}`,
    revision: 1,
    kind: "login",
    state: input.state ?? "pending",
    scope: input.scope === "application" ? applicationScope : discoveryScope,
    verification:
      input.scope === "application"
        ? { type: "page_blocker_absent", blockerFingerprint: "blocker_1" }
        : {
            type: "source_access",
            targetId: "target_1",
            blockerFingerprint: "blocker_1",
          },
    title:
      input.scope === "application"
        ? "Finish application sign-in"
        : "Sign in to source",
    summary: "Use the Job Finder browser, then return here.",
    actionUrl:
      input.actionUrl === undefined
        ? "https://jobs.example.com/login"
        : input.actionUrl,
    displayOrigin: "https://jobs.example.com/",
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
    attemptCount: input.attemptCount ?? 0,
    maxAttempts: 3,
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
    resolvedAt: input.state === "resolved" ? "2026-07-30T08:01:00.000Z" : null,
  });
}

describe("ActionsScreen", () => {
  it("opens the exact scoped application among sibling records", () => {
    const applicationRequest = createRequest({
      applicationRecordId: "application-target",
      id: "application-target",
      scope: "application",
    });
    const sourceRequest = createRequest({
      id: "source-target",
      scope: "discovery_source",
    });
    const applicationRecords = [
      { id: "application-sibling", jobId: "job_1" },
      { id: "application-target", jobId: "job_1" },
    ] as unknown as Parameters<typeof getUserActionContextRoute>[1];

    expect(
      getUserActionContextRoute(applicationRequest, applicationRecords),
    ).toBe(
      "/job-finder/applications?applicationRecordId=application-target&jobId=job_1",
    );
    expect(getUserActionContextRoute(sourceRequest, applicationRecords)).toBe(
      "/job-finder/discovery?targetId=target_1",
    );
  });

  it("keeps exact identity for downstream job validation and fails legacy ambiguity closed", () => {
    const wrongJobRequest = createRequest({
      applicationRecordId: "application-wrong-job",
      id: "wrong-job",
      scope: "application",
    });
    const records = [
      { id: "application-wrong-job", jobId: "job_2" },
      { id: "application-first", jobId: "job_1" },
      { id: "application-second", jobId: "job_1" },
    ] as unknown as Parameters<typeof getUserActionContextRoute>[1];

    expect(getUserActionContextRoute(wrongJobRequest, records)).toBe(
      "/job-finder/applications?applicationRecordId=application-wrong-job&jobId=job_1",
    );
    expect(
      getUserActionContextRoute(
        createRequest({ id: "legacy", scope: "application" }),
        records,
      ),
    ).toBe("/job-finder/applications?jobId=job_1");
  });

  it("resolves a legacy scope only when its job has exactly one record", () => {
    expect(
      getUserActionContextRoute(
        createRequest({ id: "legacy", scope: "application" }),
        [{ id: "application-only", jobId: "job_1" }] as unknown as Parameters<
          typeof getUserActionContextRoute
        >[1],
      ),
    ).toBe(
      "/job-finder/applications?applicationRecordId=application-only&jobId=job_1",
    );
  });

  it("shows safeguard recovery instead of an empty state and clears after dismissal", () => {
    const onNavigate = vi.fn();
    const props = {
      discoveryJobs: [],
      requests: [],
      isPending: () => false,
      onCommand: vi.fn(),
      onNavigate,
    };
    const { rerender } = render(
      <ActionsScreen
        {...props}
        safeguardPauses={[
          {
            id: "pause",
            campaignId: "plan",
            planName: "My search",
            title: "Paused after repeated failures (37.5% failed)",
            explanation: "Review the failed searches.",
            route: "/job-finder/safeguards",
          },
        ]}
      />,
    );
    expect(screen.queryByText("Nothing needs you right now")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Safeguards" }));
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/safeguards");
    rerender(<ActionsScreen {...props} safeguardPauses={[]} />);
    expect(screen.getByText("Nothing needs you right now")).toBeTruthy();
  });

  it("renders the shared page header grammar with a normalized body gap", () => {
    const { container, getByRole } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        // Search chrome only appears once the list is long enough to need
        // it, so this layout check renders a searchable-size list.
        requests={Array.from({ length: 5 }, (_, index) =>
          createRequest({ id: `application_${index}`, scope: "application" }),
        )}
      />,
    );

    const page = container.querySelector("section.grid");
    expect(page?.className).toContain("gap-5");
    expect(page?.className).not.toContain("gap-8");

    expect(getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(
      container.querySelectorAll("[data-page-header-divider]"),
    ).toHaveLength(1);
    expect(
      container.querySelector("[data-page-header-stack]")?.className,
    ).toContain("mb-(--gap-page-header-body)");

    const searchField = getByRole("searchbox").parentElement;
    const toolbar = searchField?.parentElement?.parentElement;
    expect(toolbar?.className).not.toContain("border-y");
    expect(toolbar?.className).not.toContain("px-0");
  });

  it("groups unresolved application and source actions and excludes terminal requests", () => {
    const { getByRole, getByText, queryByText } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[
          createRequest({ id: "application", scope: "application" }),
          createRequest({ id: "source", scope: "discovery_source" }),
          createRequest({
            id: "resolved",
            scope: "application",
            state: "resolved",
          }),
        ]}
      />,
    );

    expect(getByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(getByRole("heading", { name: "Job sources" })).toBeTruthy();
    expect(getByText("Finish application sign-in")).toBeTruthy();
    expect(getByText("Sign in to source")).toBeTruthy();
    expect(queryByText("resolved")).toBeNull();
    // Sign-in steps are trimmed to heading, sentence, host and two buttons;
    // the boundary line belongs to the kinds that still carry guidance.
    expect(
      queryByText(/cannot create an account or submit an application/i),
    ).toBeNull();
  });

  it("exposes keyboard-native Open, Done, and Cancel commands with hard safety fields", () => {
    const onCommand = vi.fn<(command: UserActionCommandInput) => void>();
    const request = createRequest({ id: "application", scope: "application" });
    const { getByRole, queryAllByRole } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={onCommand}
        onNavigate={vi.fn()}
        requests={[request]}
      />,
    );

    // "Skip" and "Cancel" were peers with the same outcome and no stated
    // difference, so one named dismissal is offered.
    expect(queryAllByRole("button", { name: /^Skip$/ })).toHaveLength(0);
    for (const name of [
      "Open the Job Finder browser",
      "Check whether this step is done",
      "Cancel this step",
    ]) {
      const button = getByRole("button", { name: new RegExp(name, "i") });
      expect(button.getAttribute("tabindex")).not.toBe("-1");
      fireEvent.click(button);
    }

    expect(onCommand.mock.calls.map(([command]) => command.action)).toEqual([
      "open_page",
      "confirm_done",
      "cancel",
    ]);
    for (const [command] of onCommand.mock.calls) {
      expect(command).toMatchObject({
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      });
    }
  });

  it("offers an explicit one-task credential command only for an exact application login", () => {
    const onCommand = vi.fn<(command: UserActionCommandInput) => void>();
    const exactApplicationLogin = UserActionRequestSchema.parse({
      ...createRequest({ id: "application-login", scope: "application" }),
      scope: {
        type: "application",
        runId: "run_1",
        jobId: "job_1",
        applicationRecordId: "application_1",
        resultId: "result_1",
        replayCheckpointId: "checkpoint_1",
        source: "target_site",
      },
    });
    const { getByLabelText, getByRole, rerender } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={onCommand}
        onNavigate={vi.fn()}
        requests={[exactApplicationLogin]}
      />,
    );

    fireEvent.change(getByLabelText("Account email or username"), {
      target: { value: " fixture-person@example.test " },
    });
    const passwordInput = getByLabelText("Password") as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: "test-password" } });
    fireEvent.click(getByRole("button", { name: "Sign in once and continue" }));

    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "submit_task_local_credentials",
        requestId: exactApplicationLogin.id,
        expectedRevision: exactApplicationLogin.revision,
        identifier: "fixture-person@example.test",
        password: "test-password",
        taskLocalUseAuthorized: true,
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    );
    expect(passwordInput.value).toBe("");

    rerender(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={onCommand}
        onNavigate={vi.fn()}
        requests={[
          createRequest({ id: "source-login", scope: "discovery_source" }),
        ]}
      />,
    );
    expect(screen.queryByText("Use credentials for this task")).toBeNull();
  });

  it("keeps a blocked action retryable until the bounded attempt cap", () => {
    const onCommand = vi.fn<(command: UserActionCommandInput) => void>();
    const { getByRole, rerender } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={onCommand}
        onNavigate={vi.fn()}
        requests={[
          createRequest({
            id: "blocked",
            scope: "discovery_source",
            state: "still_blocked",
            attemptCount: 2,
          }),
        ]}
      />,
    );

    fireEvent.click(
      getByRole("button", { name: "Check whether this step is done" }),
    );
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: "confirm_done" }),
    );

    rerender(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={onCommand}
        onNavigate={vi.fn()}
        requests={[
          createRequest({
            id: "blocked",
            scope: "discovery_source",
            state: "still_blocked",
            attemptCount: 3,
          }),
        ]}
      />,
    );

    expect(getByRole("button", { name: "Attempts exhausted" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(getByRole("status").textContent).toContain(
      "Job Finder checked 3 times and still saw the same page",
    );
    expect(
      getByRole("button", { name: "Open the Job Finder browser" }),
    ).toHaveProperty("disabled", false);
    expect(getByRole("button", { name: "Cancel this step" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("explains that a pending browser action is bounded", () => {
    const { getByRole } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => true}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[createRequest({ id: "pending", scope: "discovery_source" })]}
      />,
    );

    expect(getByRole("status").textContent).toContain(
      "This step is time-limited",
    );
  });
  it("shows verifying as a disabled non-success state", () => {
    const { getByRole } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[
          createRequest({
            id: "verifying",
            scope: "application",
            state: "verifying",
          }),
        ]}
      />,
    );

    expect(getByRole("button", { name: "Verifying" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("says Job Finder is checking a step, not that the person should go do it", () => {
    const { getByText, queryByText } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[
          {
            ...createRequest({
              id: "checking",
              scope: "application",
              state: "verifying",
            }),
            updatedAt: new Date().toISOString(),
            instructions: [
              "Return to Needs you and confirm completion only after the browser step is complete.",
            ],
          },
        ]}
      />,
    );

    expect(
      getByText(/Job Finder is checking this step and carries on by itself/),
    ).toBeTruthy();
    expect(
      queryByText("Use the Job Finder browser, then return here."),
    ).toBeNull();
    expect(queryByText(/confirm completion only after/)).toBeNull();
  });

  it("a check that never finished says so and offers one press to prepare it again", () => {
    const onStartOver = vi.fn();
    const startedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const request = {
      ...createRequest({
        id: "lost-check",
        scope: "application",
        state: "verifying",
        applicationRecordId: "application_1",
      }),
      updatedAt: startedAt,
    };
    const { getByTestId, getByText } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        onStartOver={onStartOver}
        requests={[request]}
      />,
    );

    expect(getByText(/has not finished after 20 minutes/)).toBeTruthy();
    fireEvent.click(getByTestId("needs-you-start-over"));
    expect(onStartOver).toHaveBeenCalledWith(
      expect.objectContaining({ id: "lost-check" }),
      expect.objectContaining({ action: "cancel", requestId: "lost-check" }),
    );
  });

  it("a check still waiting its turn says why, without a start-over press", () => {
    const request = {
      ...createRequest({
        id: "slow-check",
        scope: "application",
        state: "verifying",
      }),
      updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    };
    const { getByText, queryByTestId } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        onStartOver={vi.fn()}
        requests={[request]}
      />,
    );

    expect(getByText(/Still checking after 5 minutes/)).toBeTruthy();
    expect(queryByTestId("needs-you-start-over")).toBeNull();
  });

  it("gives the empty inbox one clear next action toward discovery", () => {
    const onNavigate = vi.fn();
    const { getByRole } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={onNavigate}
        requests={[]}
      />,
    );

    expect(
      getByRole("heading", { name: "Nothing needs you right now" }),
    ).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Find jobs" }));
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/discovery");
  });

  it("offers a clear recovery route when the browser link is unavailable", () => {
    const onCommand = vi.fn<(command: UserActionCommandInput) => void>();
    const onNavigate = vi.fn();
    const { getByRole, getByText, queryByRole } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={onCommand}
        onNavigate={onNavigate}
        requests={[
          createRequest({
            actionUrl: null,
            id: "missing-link",
            scope: "application",
          }),
        ]}
      />,
    );

    expect(
      queryByRole("button", { name: "Open the Job Finder browser" }),
    ).toBeNull();
    expect(getByText(/saved browser link is unavailable/i)).toBeTruthy();
    const recoveryButton = getByRole("button", {
      name: "Review application",
    });
    expect(recoveryButton.getAttribute("aria-describedby")).toContain(
      "missing-link-missing-browser-link",
    );
    fireEvent.click(recoveryButton);
    expect(onNavigate).toHaveBeenCalledWith(
      "/job-finder/applications?jobId=job_1",
    );
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("names the concrete blocker on an unclassified step without an Other badge or repeated credential copy", () => {
    const blockerReason =
      "The application page could not safely save a prepared field. The application site tried to save 'Work authorization' while it was being prepared, but this run did not have permission for that external save.";
    const request = UserActionRequestSchema.parse({
      id: "other-step",
      dedupeKey: "dedupe_other-step",
      revision: 1,
      kind: "other",
      state: "pending",
      scope: {
        type: "application",
        runId: "run_1",
        jobId: "job_1",
        applicationRecordId: "record_1",
        resultId: "result_1",
        replayCheckpointId: "checkpoint_1",
        source: "target_site",
      },
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: "blocker_other",
      },
      title: "Complete the browser step to continue the Example application",
      summary: `${blockerReason} Complete this manual step in the Job Finder browser, then return so Job Finder can verify the exact blocker no longer appears.`,
      instructions: ["Finish this step yourself in the Job Finder browser."],
      actionUrl: "https://jobs.example.com/apply/1",
      displayOrigin: "https://jobs.example.com/",
      createdAt: "2026-07-30T10:00:00.000Z",
      updatedAt: "2026-07-30T10:00:00.000Z",
    });
    const { container, getByText, queryByText } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[request]}
      />,
    );

    // The card says what the step is, not just that a step exists.
    expect(getByText(new RegExp(blockerReason.slice(0, 60)))).toBeTruthy();
    // "Other" names nothing, so it earns no category badge; requirement and
    // state badges remain.
    expect(queryByText("Other")).toBeNull();
    // Every card in a queue called "Needs you" is required, so a REQUIRED
    // chip on all of them carried no information; only "Optional" earns one.
    expect(queryByText("required")).toBeNull();
    expect(queryByText("Optional")).toBeNull();
    // Cancelling now states its consequence instead of being an unexplained
    // peer of the confirm action.
    expect(
      getByText(/Cancelling closes this step without doing it/i),
    ).toBeTruthy();
    expect(getByText("pending")).toBeTruthy();
    // The credentials boundary is stated once, in the page header, rather
    // than once per instruction and once more per card footer.
    const boundaryMatches = (container.textContent ?? "").match(
      /passwords and security codes|credentials/gi,
    );
    expect(boundaryMatches).toHaveLength(1);
    expect(
      getByText(/cannot create an account or submit an application/i),
    ).toBeTruthy();
  });

  it("hides the search toolbar until the list is long enough to need it", () => {
    // A search field and a "1 result" counter above a single card is dead
    // chrome in the first viewport.
    const { queryByRole, rerender } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[createRequest({ id: "only", scope: "application" })]}
      />,
    );

    expect(queryByRole("searchbox")).toBeNull();

    rerender(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={Array.from({ length: 5 }, (_, index) =>
          createRequest({ id: `many_${index}`, scope: "application" }),
        )}
      />,
    );

    expect(queryByRole("searchbox")).toBeTruthy();
  });

  it("shows the exact page an action opens instead of a bare origin", () => {
    const { getByText, queryByText } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[createRequest({ id: "page", scope: "application" })]}
      />,
    );

    // The host, never the full link with its query string.
    expect(getByText("On: jobs.example.com")).toBeTruthy();
    expect(queryByText(/^Page:/)).toBeNull();
    expect(queryByText(/^Browser:/)).toBeNull();
  });

  it("keeps the numbered steps to what the user does, with one safety sentence", () => {
    const request = UserActionRequestSchema.parse({
      ...createRequest({ id: "instructions", scope: "discovery_source" }),
      kind: "manual_upload",
      instructions: [
        "Complete sign-in in the Job Finder browser. Job Finder never receives or stores your credentials.",
        "Return to the action inbox and confirm completion only after the browser step is complete.",
        "After confirmation, Job Finder runs one exact prepare-only retry to verify the blocker and stops before final submission.",
      ],
    });

    const { container, getAllByRole } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[request]}
      />,
    );

    const steps = getAllByRole("listitem").map((item) =>
      item.textContent?.trim(),
    );
    expect(steps).toEqual([
      "Complete sign-in in the Job Finder browser.",
      "Return to the action inbox and confirm completion only after the browser step is complete.",
    ]);

    // Exactly one safety sentence survives, and it is the card footer's.
    const text = container.textContent ?? "";
    expect(text.split("stops before final submission").length - 1).toBe(0);
    expect(
      text.split("cannot create an account or submit an application").length -
        1,
    ).toBe(1);
  });

  it("leads with the plain step and hides the recorded request line behind Technical details", () => {
    const request = UserActionRequestSchema.parse({
      ...createRequest({ id: "blocked", scope: "application" }),
      kind: "manual_upload",
      summary:
        "The application page needs manual review. Blocked: xhr POST https://example.test/cdn-cgi/rum?req=1.",
      instructions: [
        "Choose the next application step manually in the Job Finder browser. Blocked: xhr POST https://example.test/cdn-cgi/rum?req=1.",
      ],
    });

    const { container, getAllByRole, getByText } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[request]}
      />,
    );

    expect(
      getAllByRole("listitem").map((item) => item.textContent?.trim()),
    ).toContain(
      "Choose the next application step manually in the Job Finder browser.",
    );
    expect(getByText("The application page needs manual review.")).toBeTruthy();

    // The blocked attempt is still recorded, one level down.
    const disclosure = container.querySelector("details");
    expect(disclosure?.querySelector("summary")?.textContent).toBe(
      "Technical details",
    );
    expect(disclosure?.textContent).toContain(
      "Blocked: xhr POST https://example.test/cdn-cgi/rum?req=1.",
    );
  });

  it("lists an application the Applications screen badges Needs you", () => {
    // "Needs you: 0 unresolved" beside an application badged NEEDS YOU:
    // one population, two answers. The badge count and this page now read
    // the same selector, so the page can never be empty while it counts.
    const record = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Principal Designer",
      company: "Acme",
      status: "ready_for_review",
      lastAttemptState: "paused",
      consentSummary: { status: "requested", pendingCount: 1 },
      lastActionLabel: "Paused on the job site.",
      nextActionLabel: "Finish the sign-in step on the job site.",
      lastUpdatedAt: "2026-03-20T10:00:00.000Z",
    });
    const onNavigate = vi.fn();

    render(
      <ActionsScreen
        applicationRecords={[record]}
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={onNavigate}
        requests={[]}
      />,
    );

    expect(
      countNeedsYouItems({ applicationRecords: [record], requests: [] }),
    ).toBe(1);
    expect(screen.queryByText("Nothing needs you right now")).toBeNull();
    // One Applications group holds live steps and paused applications alike.
    expect(screen.getByRole("heading", { name: "Applications" })).toBeTruthy();
    expect(screen.queryByText("Applications waiting on you")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Open this application/ }),
    );
    expect(onNavigate).toHaveBeenCalledWith(
      expect.stringContaining("/job-finder/applications"),
    );
  });

  it("does not repeat an application a live browser step already represents", () => {
    const record = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Principal Designer",
      company: "Acme",
      status: "ready_for_review",
      lastAttemptState: "paused",
      consentSummary: { status: "requested", pendingCount: 1 },
      lastActionLabel: "Paused on the job site.",
      nextActionLabel: "Finish the sign-in step on the job site.",
      lastUpdatedAt: "2026-03-20T10:00:00.000Z",
    });
    const request = createRequest({
      id: "request_1",
      scope: "application",
      applicationRecordId: "application_1",
    });

    expect(
      countNeedsYouItems({
        applicationRecords: [record],
        requests: [request],
      }),
    ).toBe(1);
  });

  it("trims safety-only instructions without dropping actionable steps", () => {
    expect(
      toActionableInstructions([
        "Complete the described step yourself in the Job Finder browser. Do not enter credentials or security answers anywhere except the browser page.",
        "  ",
        "Return to the action inbox and choose Done only after the browser step is complete.",
        "After access verification, Job Finder retries this exact application once and stops before final submission.",
      ]),
    ).toEqual([
      "Complete the described step yourself in the Job Finder browser.",
      "Return to the action inbox and choose Done only after the browser step is complete.",
    ]);
  });
});
