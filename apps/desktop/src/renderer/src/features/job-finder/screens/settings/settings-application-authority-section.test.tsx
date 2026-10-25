// @vitest-environment jsdom

import type {
  ApplicationAuthorityEnvelope,
  ApplicationAuthorityEnvelopeMutationResult,
  ApplicationAuthorityReadiness,
} from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationAuthorityIsoToLocalDateTimeInput,
  SettingsApplicationAuthoritySection,
} from "./settings-application-authority-section";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@renderer/components/ui/toast", () => ({
  useToast: () => ({ showToast }),
}));

const createdAt = "2026-08-27T09:00:00.000Z";
const origin = "https://jobs.example.com";

const readiness: ApplicationAuthorityReadiness = {
  generatedAt: createdAt,
  executionCapability: "prepare_only",
  elevatedExecutionAvailable: false,
  answerApprovalStatus: "missing_answers",
  currentAnswers: {
    sourceProfileRevision: 1,
    digest: null,
    entryCount: 0,
    kinds: [],
    missingRequiredKinds: [
      "work_authorization",
      "visa_sponsorship",
      "relocation",
      "travel",
      "notice_period",
      "availability",
      "salary_expectation",
      "self_intro",
      "career_transition",
    ],
  },
  approvedSnapshot: null,
  activeAuthority: null,
  blockers: [{ code: "no_reusable_answers", remediation: "profile" }],
};

function envelope(
  overrides: Partial<ApplicationAuthorityEnvelope> = {},
): ApplicationAuthorityEnvelope {
  return {
    accountCreationAuthorized: false,
    allowedOrigins: [origin],
    allowedResumeSha256: [],
    createdAt,
    decisionPolicy: null,
    expiresAt: null,
    id: "authority-1",
    intermediateMutationsAuthorized: false,
    maxApplicationsPerLocalDay: 2,
    maxApplicationsPerRun: 1,
    mode: "prepare_only",
    revision: 1,
    revokedAt: null,
    scope: { campaignId: null, jobIds: [] },
    status: "active",
    ...overrides,
  };
}

function applied(
  value: ApplicationAuthorityEnvelope,
): ApplicationAuthorityEnvelopeMutationResult {
  return { envelope: value, status: "applied" };
}

function installApi(overrides: Partial<Window["nestor"]["jobFinder"]> = {}) {
  const api = {
    getApplicationAuthorityReadiness: vi.fn(() => Promise.resolve(readiness)),
    approveCurrentApplicationAnswers: vi.fn(),
    createApplicationAuthorityEnvelope: vi.fn(() =>
      Promise.resolve(applied(envelope())),
    ),
    getApplicationAuthorityEnvelope: vi.fn(({ id }: { id: string }) =>
      Promise.resolve(id === "authority-1" ? envelope() : null),
    ),
    listApplicationAuthorityEnvelopes: vi.fn(() =>
      Promise.resolve([envelope()]),
    ),
    revokeApplicationAuthorityEnvelope: vi.fn(() =>
      Promise.resolve(
        applied(
          envelope({
            revision: 2,
            revokedAt: "2026-08-27T10:00:00.000Z",
            status: "revoked",
          }),
        ),
      ),
    ),
    updateApplicationAuthorityEnvelope: vi.fn(() =>
      Promise.resolve(applied(envelope({ revision: 2 }))),
    ),
    ...overrides,
  } as Window["nestor"]["jobFinder"];

  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: { jobFinder: api },
  });
  return api;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: undefined,
  });
});

describe("SettingsApplicationAuthoritySection", () => {
  it("requires an explicit second confirmation before approving current answers", async () => {
    const currentReadiness: ApplicationAuthorityReadiness = {
      ...readiness,
      answerApprovalStatus: "not_approved",
      currentAnswers: {
        ...readiness.currentAnswers,
        digest: "a".repeat(64),
        entryCount: 1,
        kinds: ["work_authorization"],
      },
      blockers: [
        { code: "no_approved_answer_snapshot", remediation: "settings" },
        { code: "elevated_execution_unavailable", remediation: "unavailable" },
      ],
    };
    const approvedReadiness: ApplicationAuthorityReadiness = {
      ...currentReadiness,
      answerApprovalStatus: "current",
      approvedSnapshot: {
        id: "answer_snapshot_1",
        revision: 1,
        digest: "a".repeat(64),
        sourceProfileRevision: 1,
        approvedAt: createdAt,
        entryCount: 1,
        kinds: ["work_authorization"],
      },
      blockers: [
        { code: "elevated_execution_unavailable", remediation: "unavailable" },
      ],
    };
    const api = installApi({
      getApplicationAuthorityReadiness: vi.fn(() =>
        Promise.resolve(currentReadiness),
      ),
      approveCurrentApplicationAnswers: vi.fn(() =>
        Promise.resolve({
          status: "created" as const,
          snapshot: approvedReadiness.approvedSnapshot!,
          readiness: approvedReadiness,
        }),
      ),
    });
    render(<SettingsApplicationAuthoritySection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Approve current answers" }),
    );
    expect(api.approveCurrentApplicationAnswers).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm and approve" }),
    );
    await waitFor(() =>
      expect(api.approveCurrentApplicationAnswers).toHaveBeenCalledWith({
        expectedProfileRevision: 1,
        confirmedCurrentAnswers: true,
      }),
    );
    expect(
      screen.getByText(/Final submission remains unavailable/i),
    ).toBeTruthy();
    // Stored identifiers never reach the screen.
    expect(screen.getByText("Work authorization")).toBeTruthy();
    expect(screen.queryByText(/work_authorization/)).toBeNull();
  });

  it("names missing answers in plain language instead of raw identifiers", async () => {
    installApi({
      getApplicationAuthorityReadiness: vi.fn(() =>
        Promise.resolve({
          ...readiness,
          blockers: [
            {
              code: "required_answer_missing" as const,
              remediation: "profile" as const,
            },
          ],
          currentAnswers: {
            ...readiness.currentAnswers,
            entryCount: 2,
            kinds: ["self_intro" as const, "notice_period" as const],
            missingRequiredKinds: ["work_authorization" as const],
          },
        }),
      ),
    });
    render(<SettingsApplicationAuthoritySection />);

    expect(
      await screen.findByText("Short self-introduction, Notice period"),
    ).toBeTruthy();
    expect(
      screen.getByText("Answer these in Profile first: Work authorization."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("self_intro");
  });

  it("loads the current revision and offers all three choices", async () => {
    const api = installApi();
    render(<SettingsApplicationAuthoritySection />);

    await waitFor(() =>
      expect(api.getApplicationAuthorityEnvelope).toHaveBeenCalledWith({
        id: "authority-1",
      }),
    );
    // Each choice is described by what happens, not by the name of a mode.
    expect(
      screen.getByRole("radio", { name: /Fill applications in and stop/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: /ask me before sending/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: /Fill them in and send them/i }),
    ).toBeTruthy();
    expect(screen.queryAllByText(/Not available yet/i)).toHaveLength(0);
    // Declarations only appear once a sending choice is made.
    expect(screen.queryByText(/Things forms ask you to declare/i)).toBeNull();
    expect(screen.getByDisplayValue(origin)).toBeTruthy();
  });

  it("round-trips an ISO expiry through the local datetime editor", () => {
    const originalTimeZone = process.env.TZ;
    process.env.TZ = "Europe/Belgrade";
    try {
      const iso = "2026-08-27T10:00:00.000Z";
      const local = applicationAuthorityIsoToLocalDateTimeInput(iso);
      expect(local).toBe("2026-08-27T12:00");
      expect(new Date(local).toISOString()).toBe(iso);
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    }
  });

  it("does not invent an origin or volume and sends only visible prepare-only policy", async () => {
    const api = installApi({
      listApplicationAuthorityEnvelopes: vi.fn(() => Promise.resolve([])),
    });
    render(<SettingsApplicationAuthoritySection />);

    await waitFor(() =>
      expect(screen.getByText(/Nothing saved yet/)).toBeTruthy(),
    );
    const create = screen.getByRole<HTMLButtonElement>("button", {
      name: "Save",
    });
    expect(create.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Website Job Finder may fill on/), {
      target: { value: origin },
    });
    fireEvent.change(screen.getByLabelText("Maximum applications per run"), {
      target: { value: "3" },
    });
    fireEvent.change(
      screen.getByLabelText("Maximum applications per local day"),
      { target: { value: "5" } },
    );
    expect(create.disabled).toBe(false);
    fireEvent.click(create);

    await waitFor(() =>
      expect(api.createApplicationAuthorityEnvelope).toHaveBeenCalledTimes(1),
    );
    expect(api.createApplicationAuthorityEnvelope).toHaveBeenCalledWith({
      allowedOrigins: [origin],
      allowedResumeSha256: [],
      expiresAt: null,
      intermediateMutationsAuthorized: false,
      maxApplicationsPerLocalDay: 5,
      maxApplicationsPerRun: 3,
      mode: "prepare_only",
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      scope: { campaignId: null, jobIds: [] },
    });
  });

  it("requires fresh answer approval and exact visible scope before requesting bounded ATS autosave", async () => {
    const currentReadiness: ApplicationAuthorityReadiness = {
      ...readiness,
      answerApprovalStatus: "current",
      currentAnswers: {
        sourceProfileRevision: 3,
        digest: "b".repeat(64),
        entryCount: 2,
        kinds: ["work_authorization", "visa_sponsorship"],
        missingRequiredKinds: [],
      },
      approvedSnapshot: {
        id: "answer_snapshot_2",
        revision: 2,
        digest: "b".repeat(64),
        sourceProfileRevision: 3,
        approvedAt: createdAt,
        entryCount: 2,
        kinds: ["work_authorization", "visa_sponsorship"],
      },
      blockers: [
        { code: "elevated_execution_unavailable", remediation: "unavailable" },
      ],
    };
    const api = installApi({
      getApplicationAuthorityReadiness: vi.fn(() =>
        Promise.resolve(currentReadiness),
      ),
      listApplicationAuthorityEnvelopes: vi.fn(() => Promise.resolve([])),
    });
    render(<SettingsApplicationAuthoritySection />);

    const autosave = await screen.findByRole("switch", {
      name: "Let the job site save answers as Job Finder fills them",
    });
    expect((autosave as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(autosave);

    fireEvent.change(screen.getByLabelText(/Website Job Finder may fill on/), {
      target: { value: origin },
    });
    fireEvent.change(screen.getByLabelText(/Resume file fingerprint/), {
      target: { value: "a".repeat(64) },
    });
    fireEvent.change(screen.getByLabelText(/Job IDs/), {
      target: { value: "job_1" },
    });
    fireEvent.change(screen.getByLabelText("Maximum applications per run"), {
      target: { value: "1" },
    });
    fireEvent.change(
      screen.getByLabelText("Maximum applications per local day"),
      { target: { value: "2" } },
    );
    fireEvent.change(screen.getByLabelText("Expires at"), {
      target: { value: "2026-08-28T12:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.createApplicationAuthorityEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedOrigins: [origin],
          allowedResumeSha256: ["a".repeat(64)],
          intermediateMutationsAuthorized: true,
          scope: { campaignId: null, jobIds: ["job_1"] },
        }),
      ),
    );
  });

  it("uses the loaded revision for updates and reloads a stale response", async () => {
    const current = envelope({ revision: 4, maxApplicationsPerRun: 9 });
    const staleResult: ApplicationAuthorityEnvelopeMutationResult = {
      current,
      status: "stale",
    };
    const api = installApi({
      updateApplicationAuthorityEnvelope: vi.fn(() =>
        Promise.resolve(staleResult),
      ),
    });
    render(<SettingsApplicationAuthoritySection />);
    await waitFor(() => expect(screen.getByDisplayValue("1")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Maximum applications per run"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateApplicationAuthorityEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({ id: "authority-1", expectedRevision: 1 }),
      ),
    );
    expect(
      await screen.findByText(
        /changed elsewhere.*current revision was reloaded/i,
      ),
    ).toBeTruthy();
  });

  it("revokes using the current revision and keeps the action out of submission APIs", async () => {
    const api = installApi();
    render(<SettingsApplicationAuthoritySection />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Go back to fill-and-stop" }),
      ).toBeTruthy(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Go back to fill-and-stop" }),
    );
    expect(api.revokeApplicationAuthorityEnvelope).not.toHaveBeenCalled();
    expect(
      screen.getByText(/go back to filling applications in and stopping/i),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Go back to fill-and-stop" }),
    );
    await waitFor(() =>
      expect(api.revokeApplicationAuthorityEnvelope).toHaveBeenCalledWith({
        expectedRevision: 1,
        id: "authority-1",
      }),
    );
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
  });

  it("keeps a permission that is no longer in force readable but not editable", async () => {
    // A permission the person already took back: still readable as history,
    // never editable, and never switched back on from here.
    const elevated = envelope({
      allowedResumeSha256: ["a".repeat(64)],
      expiresAt: "2026-08-28T09:00:00.000Z",
      mode: "autonomous_submit",
      revokedAt: "2026-08-27T12:00:00.000Z",
      scope: { campaignId: null, jobIds: ["job-1"] },
      status: "revoked",
    });
    const api = installApi({
      getApplicationAuthorityEnvelope: vi.fn(() => Promise.resolve(elevated)),
      listApplicationAuthorityEnvelopes: vi.fn(() =>
        Promise.resolve([elevated]),
      ),
    });
    render(<SettingsApplicationAuthoritySection />);

    // Nothing is active, so nothing is selected until the person opens it.
    fireEvent.click(
      await screen.findByRole("button", { name: /autonomous submit/i }),
    );

    expect(await screen.findByText(/no longer in force/i)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Editing unavailable",
      }).disabled,
    ).toBe(true);

    // Nothing here can switch it back on, and it cannot be taken back twice.
    expect(
      screen.queryByRole("button", { name: "Go back to fill-and-stop" }),
    ).toBeNull();
    expect(api.revokeApplicationAuthorityEnvelope).not.toHaveBeenCalled();
  });

  it("takes back an active permission to send, which is the kill switch", async () => {
    const sending = envelope({
      allowedResumeSha256: ["a".repeat(64)],
      expiresAt: "2026-08-28T09:00:00.000Z",
      mode: "autonomous_submit",
      scope: { campaignId: null, jobIds: ["job-1"] },
    });
    const api = installApi({
      getApplicationAuthorityEnvelope: vi.fn(() => Promise.resolve(sending)),
      listApplicationAuthorityEnvelopes: vi.fn(() =>
        Promise.resolve([sending]),
      ),
    });
    render(<SettingsApplicationAuthoritySection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Go back to fill-and-stop" }),
    );
    expect(
      screen.getByText(/go back to filling applications in and stopping/i),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Go back to fill-and-stop" }),
    );
    await waitFor(() =>
      expect(api.revokeApplicationAuthorityEnvelope).toHaveBeenCalledWith({
        expectedRevision: 1,
        id: "authority-1",
      }),
    );
  });

  it("offers the declaration and pay choices only once sending is chosen", async () => {
    installApi({
      getApplicationAuthorityEnvelope: vi.fn(() => Promise.resolve(null)),
      listApplicationAuthorityEnvelopes: vi.fn(() => Promise.resolve([])),
    });
    render(<SettingsApplicationAuthoritySection />);

    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: /Fill applications in and stop/i }),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/Things forms ask you to declare/i)).toBeNull();

    fireEvent.click(
      screen.getByRole("radio", { name: /Fill them in and send them/i }),
    );

    expect(screen.getByText(/Things forms ask you to declare/i)).toBeTruthy();
    // Equal-opportunity questions are offered, and off unless chosen.
    const selfIdentification = screen.getByRole<HTMLButtonElement>("switch", {
      name: /Equal-opportunity questions about you/i,
    });
    expect(selfIdentification.getAttribute("aria-checked")).toBe("false");
    const payChoice = screen.getByRole<HTMLButtonElement>("switch", {
      name: /answer expected and current pay questions/i,
    });
    expect(payChoice.getAttribute("aria-checked")).toBe("false");
  });

  it("states what a chosen mode will do and gives one button per missing prerequisite", async () => {
    installApi();
    render(<SettingsApplicationAuthoritySection />);

    await screen.findByRole("radio", { name: /Fill them in and send them/ });
    fireEvent.click(
      screen.getByRole("radio", { name: /Fill them in and send them/ }),
    );

    const outcome = await screen.findByTestId("application-automation-outcome");
    expect(outcome.textContent).toMatch(
      /Job Finder will fill applications in and send the ones that fall inside the limits below/,
    );

    // A dead end ("NOT APPROVED" with nothing to press) is what this replaces:
    // every missing prerequisite carries its own way forward.
    const prerequisites = await screen.findByTestId(
      "application-automation-prerequisites",
    );
    expect(prerequisites.textContent).toMatch(
      /lets Job Finder reuse exactly the answers you checked in Profile/,
    );
    expect(
      screen.getByRole("button", { name: "Approve your saved answers" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Set when this expires" }),
    ).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(
      /form state|safe advance|authority envelope|configured model/i,
    );
  });

  it("asks for a website only in the modes that send applications", async () => {
    installApi({
      listApplicationAuthorityEnvelopes: vi.fn(() => Promise.resolve([])),
    });
    render(<SettingsApplicationAuthoritySection />);

    // Fill-and-stop writes nothing on any site and prepares with no website
    // named, so there is no website step to be missing.
    await screen.findByTestId("application-automation-outcome");
    expect(screen.queryByRole("button", { name: "Add a website" })).toBeNull();

    fireEvent.click(
      screen.getByRole("radio", { name: /Fill them in and send them/ }),
    );
    expect(
      await screen.findByRole("button", { name: "Add a website" }),
    ).toBeTruthy();
    expect(
      screen.getByTestId("application-automation-prerequisites").textContent,
    ).toMatch(/Sending is limited to the sites you name here/);

    fireEvent.click(
      screen.getByRole("radio", { name: /ask me before sending/i }),
    );
    expect(
      await screen.findByRole("button", { name: "Add a website" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("radio", { name: /Fill applications in and stop/ }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Add a website" }),
      ).toBeNull();
    });
  });
});
