// @vitest-environment jsdom

import type {
  CandidateProfile,
  JobSearchPreferences,
  ProfileSetupState,
  ResumeImportFieldCandidateSummary,
} from "@nestor/contracts";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  ResumeImportFieldCandidateSummarySchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ToastProvider } from "@renderer/components/ui/toast";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileScreen } from "./profile-screen";

vi.mock("@renderer/features/job-lists/use-site-page", () => {
  const page = {
    rows: [],
    total: 0,
    selected: 0,
    enabledTotal: 0,
    nextCursor: null,
    counts: { all: 0, enabled: 0, disabled: 0, needs_attention: 0 },
    loading: false,
    error: null,
    pageIndex: 0,
    refresh: () => {},
    previous: () => {},
    next: () => {},
  };
  return { useSitePage: () => page };
});

const profile = CandidateProfileSchema.parse({
  id: "candidate_ready",
  firstName: "Ready",
  lastName: "Candidate",
  fullName: "Ready Candidate",
  headline: "Principal systems designer",
  summary: "Builds workflow platforms.",
  currentLocation: "Prishtina",
  yearsExperience: 10,
  baseResume: {
    id: "resume_ready",
    fileName: "resume.pdf",
    uploadedAt: new Date(0).toISOString(),
    textContent: "Experienced designer.",
    extractionStatus: "needs_text",
  },
  workEligibility: {},
  professionalSummary: {},
  targetRoles: [],
  locations: [],
  skills: [],
  experiences: [
    {
      id: "exp_1",
      companyName: "Original Co",
      title: "Designer",
      startDate: "2018-01",
      isCurrent: true,
    },
  ],
  education: [],
  certifications: [],
  links: [],
  projects: [],
  spokenLanguages: [],
});

const searchPreferences = JobSearchPreferencesSchema.parse({
  workModes: ["remote"],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
});

const profileSetupState: ProfileSetupState = {
  status: "completed",
  currentStep: "ready_check",
  completedAt: "2026-08-01T00:00:00.000Z",
  reviewItems: [],
  lastResumedAt: null,
};

type ProfileScreenProps = React.ComponentProps<typeof ProfileScreen>;

function buildProfileScreenProps(
  overrides: {
    onSaveAll?: ProfileScreenProps["onSaveAll"];
    profile?: CandidateProfile;
    searchPreferences?: JobSearchPreferences;
  } = {},
): ProfileScreenProps {
  const props: ProfileScreenProps = {
    actionState: { message: null },
    importResumeGuardMessage: null,
    latestResumeImportReviewCandidates:
      [] as readonly ResumeImportFieldCandidateSummary[],
    latestResumeImportRun: null,
    onApplyProfileSetupReviewAction: vi.fn(),
    onApplyResumeTimelineRepairAction: async () => {},
    onAnalyzeProfileFromResume: vi.fn(),
    onImportResume: vi.fn(),
    onProfileSurfaceDirtyChange: vi.fn(),
    onResumeProfileSetup: vi.fn(),
    onRunSourceDebug: vi.fn(),
    onSaveAll: vi.fn(),
    onSaveSourceInstructionArtifact: vi.fn(),
    pendingActions: {
      analyzeProfile: false,
      importResume: false,
      profileCopilotBusy: false,
      profileMutation: false,
      profileSetup: false,
      profileReviewItem: () => false,
      sourceDebug: () => false,
      sourceInstruction: () => false,
    },
    profile,
    profileSetupState,
    resumeImportProgress: null,
    searchPreferences: overrides.searchPreferences ?? searchPreferences,
    sourceInstructionArtifacts: [],
  };

  if (overrides.onSaveAll) {
    props.onSaveAll = overrides.onSaveAll;
  }

  if (overrides.profile) {
    props.profile = overrides.profile;
  }

  return props;
}

function renderProfileScreen(
  overrides: {
    initialEntry?: string;
    onSaveAll?: ProfileScreenProps["onSaveAll"];
    profile?: CandidateProfile;
    searchPreferences?: JobSearchPreferences;
  } = {},
): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <MemoryRouter
        initialEntries={[overrides.initialEntry ?? "/job-finder/profile"]}
      >
        <ProfileScreen {...buildProfileScreenProps(overrides)} />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("ProfileScreen ready-state density and save-bar footprint", () => {
  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    window.localStorage.removeItem("nestor.profile-ready-banner-dismissed-v1");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("R2-050 shows a running import after returning with no local pending action", () => {
    const props = buildProfileScreenProps();
    props.latestResumeImportRun = ResumeImportRunSchema.parse({
      id: "synthetic_import",
      sourceResumeId: profile.baseResume.id,
      sourceResumeFileName: "synthetic.txt",
      trigger: "import",
      status: "extracting",
      startedAt: "2026-10-02T10:00:00.000Z",
    });
    const view = render(
      <MemoryRouter>
        <ProfileScreen {...props} />
      </MemoryRouter>,
    );
    expect(screen.queryAllByText("Importing").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Import interrupted/i)).toBeNull();
    expect(
      screen
        .getAllByRole("button", { name: /Replace resume/i })
        .every((button) => button.getAttribute("aria-disabled") === "true"),
    ).toBe(true);
    fireEvent.click(
      screen.getAllByRole("button", { name: /Replace resume/i })[0]!,
    );
    expect(props.onImportResume).not.toHaveBeenCalled();
    view.rerender(
      <ToastProvider>
        <MemoryRouter>
          <ProfileScreen
            {...props}
            latestResumeImportRun={{
              ...props.latestResumeImportRun,
              status: "applied",
              completedAt: "2026-10-02T10:01:00.000Z",
            }}
          />
        </MemoryRouter>
      </ToastProvider>,
    );
    expect(screen.queryAllByText("Importing")).toHaveLength(0);
    expect(
      screen
        .getAllByRole("button", { name: /Replace resume/i })
        .every((button) => button.getAttribute("aria-disabled") === "true"),
    ).toBe(false);
  });

  it.each(["running_role", "active_workflow"])(
    "holds autosave during deferred vision (%s) then saves the preserved draft",
    async (source) => {
      const props = buildProfileScreenProps();
      props.pendingActions.importResume = source === "active_workflow";
      const run = ResumeImportRunSchema.parse({
        id: "deferred",
        sourceResumeId: profile.baseResume.id,
        sourceResumeFileName: "long.pdf",
        trigger: "import",
        status: "applied",
        startedAt: "2026-10-29T00:00:00Z",
        modelRoles: {
          vision: {
            status: source === "running_role" ? "running" : "completed",
          },
        },
      });
      const view = render(
        <MemoryRouter>
          <ProfileScreen {...props} latestResumeImportRun={run} />
        </MemoryRouter>,
      );
      fireEvent.change(screen.getByLabelText("Headline"), {
        target: { value: "My preserved headline" },
      });
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(props.onSaveAll).not.toHaveBeenCalled();
      props.pendingActions.importResume = false;
      view.rerender(
        <MemoryRouter>
          <ProfileScreen
            {...props}
            latestResumeImportRun={ResumeImportRunSchema.parse({
              ...run,
              modelRoles: { vision: { status: "completed" } },
            })}
          />
        </MemoryRouter>,
      );
      await waitFor(() => expect(props.onSaveAll).toHaveBeenCalledOnce());
      expect(screen.getByLabelText("Headline")).toHaveProperty(
        "value",
        "My preserved headline",
      );
    },
  );

  it("keeps the full-Profile route state and draft when switching tabs before setup", () => {
    const props = buildProfileScreenProps();
    props.profileSetupState = {
      ...props.profileSetupState,
      status: "not_started",
    };
    function LocationProbe() {
      const location = useLocation();
      return (
        <output data-testid="profile-route-state">
          {JSON.stringify(location.state)}
        </output>
      );
    }
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/job-finder/profile",
            state: { forceFullProfile: true },
          },
        ]}
      >
        <ProfileScreen {...props} />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Headline"), {
      target: { value: "Unsaved profile headline" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /Work history/ }));
    expect(screen.getByTestId("profile-route-state").textContent).toBe(
      '{"forceFullProfile":true}',
    );
    fireEvent.click(screen.getByRole("tab", { name: /Basics/ }));
    expect(screen.getByLabelText("Headline")).toHaveProperty(
      "value",
      "Unsaved profile headline",
    );
  });

  it.each(["experience", "education"] as const)(
    "reviews imported %s within a completed Profile without reopening setup",
    (section) => {
      const props = buildProfileScreenProps();
      const value =
        section === "experience"
          ? {
              ...profile.experiences[0],
              achievements: ["Handled 40 requests per shift."],
            }
          : {
              schoolName: "Example College",
              degree: "Certificate",
              endDate: "2019",
            };
      const candidate = ResumeImportFieldCandidateSummarySchema.parse({
        id: "imported_record",
        target: { section, key: "record", recordId: "imported_record" },
        label: "Updated background",
        value,
        confidence: 0.95,
        resolution: "needs_review",
      });
      props.profile = CandidateProfileSchema.parse({
        ...profile,
        education: [
          {
            id: "saved_school",
            schoolName: "Example College",
            degree: "Certificate",
          },
        ],
      });
      props.latestResumeImportReviewCandidates = [candidate];
      props.profileSetupState = {
        ...profileSetupState,
        reviewItems: [
          {
            id: "review_record",
            step: "background",
            target: {
              domain: section,
              key: "record",
              recordId: "imported_record",
            },
            label: "Updated background",
            reason: "New resume details need review.",
            severity: "recommended",
            status: "pending",
            proposedValue: JSON.stringify(value),
            sourceSnippet: null,
            sourceCandidateId: candidate.id,
            sourceRunId: "import_run",
            createdAt: "2026-09-26T00:00:00.000Z",
            resolvedAt: null,
          },
        ],
      };
      render(
        <MemoryRouter>
          <ProfileScreen {...props} />
        </MemoryRouter>,
      );
      const action =
        section === "experience"
          ? /Review in Experience:/
          : /Review in Background:/;
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(screen.getByText("Currently saved")).toBeTruthy();
      expect(
        screen.getByText("Currently saved").parentElement?.textContent,
      ).not.toContain("Is draft");
      expect(screen.getByText("Suggested value")).toBeTruthy();
      const row = document.getElementById(
        "profile-import-review-imported_record",
      );
      expect(row?.textContent).toContain(
        section === "experience" ? "Handled 40 requests per shift." : "2019",
      );
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
      expect(props.onApplyProfileSetupReviewAction).toHaveBeenCalledWith(
        "review_record",
        "confirm",
        undefined,
      );
      expect(props.onResumeProfileSetup).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("heading", { name: "Guided setup" }),
      ).toBeNull();
    },
  );

  it("blocks imported review actions while Profile has unsaved edits or a pending update", () => {
    const props = buildProfileScreenProps();
    const candidate = ResumeImportFieldCandidateSummarySchema.parse({
      id: "imported_headline",
      target: { section: "identity", key: "headline" },
      label: "Headline",
      value: "New headline",
      confidence: 0.95,
      resolution: "needs_review",
    });
    props.latestResumeImportReviewCandidates = [candidate];
    props.profileSetupState = {
      ...profileSetupState,
      reviewItems: [
        {
          id: "review_headline",
          step: "essentials",
          target: { domain: "identity", key: "headline", recordId: null },
          label: "Headline",
          reason: "Different headline.",
          severity: "recommended",
          status: "pending",
          proposedValue: "New headline",
          sourceSnippet: null,
          sourceCandidateId: candidate.id,
          sourceRunId: "import_run",
          createdAt: "2026-09-26T00:00:00.000Z",
          resolvedAt: null,
        },
      ],
    };
    const rendered = render(
      <MemoryRouter>
        <ProfileScreen {...props} />
      </MemoryRouter>,
    );
    expect(
      screen
        .getByRole("button", {
          name: "Confirm",
        })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Edited" },
    });
    expect(
      screen
        .getByRole("button", {
          name: "Confirm",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(
        "Save your profile changes before reviewing imported suggestions.",
      ),
    ).toBeTruthy();
    rendered.unmount();
    props.pendingActions.profileReviewItem = () => true;
    render(
      <MemoryRouter>
        <ProfileScreen {...props} />
      </MemoryRouter>,
    );
    expect(
      screen
        .getByRole("button", {
          name: "Confirm",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(props.onApplyProfileSetupReviewAction).not.toHaveBeenCalled();
  });

  it("raises the resume identity choice as soon as the Basics name changes", () => {
    const onSaveAll = vi.fn();
    renderProfileScreen({
      onSaveAll,
      profile: CandidateProfileSchema.parse({
        ...profile,
        firstName: "Casey",
        lastName: "Rowan",
        fullName: "Casey Rowan",
        baseResume: {
          ...profile.baseResume,
          textContent: "CASEY ROWAN\nMarketing Manager",
        },
      }),
    });

    expect(screen.queryByTestId("resume-identity-choice")).toBeNull();
    fireEvent.change(screen.getByLabelText("First name"), {
      target: { value: "Jordan" },
    });
    fireEvent.change(screen.getByLabelText("Last name"), {
      target: { value: "Vance" },
    });

    expect(screen.getByTestId("resume-identity-choice").textContent).toContain(
      "Your imported resume says “CASEY ROWAN” and your profile says “Jordan Vance”. Resumes use your profile name.",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Got it",
      }),
    );
    expect(onSaveAll).toHaveBeenCalledTimes(1);
    expect(onSaveAll.mock.calls[0]?.[0]).toMatchObject({
      fullName: "Jordan Vance",
      resumeIdentityOwnership: {
        acknowledgedSourceFullName: "CASEY ROWAN",
      },
    });
  });

  it("keeps reusable form-answer controls out of Profile Preferences", () => {
    const saved = CandidateProfileSchema.parse({
      ...profile,
    });
    const view = renderProfileScreen({
      initialEntry: "/job-finder/profile?section=preferences",
      profile: saved,
    });
    expect(
      screen.queryByRole("tab", { name: /Preferences.*to confirm/ }),
    ).toBeNull();
    expect(view.container.querySelector("#answer-record-review")).toBeNull();
    expect(screen.queryByText("Reusable screener answers")).toBeNull();
    expect(screen.queryByText("Custom answer library")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Confirm this is my answer" }),
    ).toBeNull();
  });

  it("splits semicolon roles in Profile and wraps chips within their column", () => {
    renderProfileScreen({
      initialEntry: "/job-finder/profile?section=preferences",
    });
    const field = screen.getByRole("textbox", { name: "Target roles" });
    fireEvent.change(field, {
      target: {
        value:
          "Junior Data Analyst; Junior Data Scientist; Working Student Data Analytics",
      },
    });
    fireEvent.keyDown(field, { key: "Enter" });
    for (const role of [
      "Junior Data Analyst",
      "Junior Data Scientist",
      "Working Student Data Analytics",
    ]) {
      const chip = screen.getByText(role);
      expect(chip.className).toContain("whitespace-normal");
      expect(chip.closest("section")?.className).toContain("min-w-0");
    }
  });

  it("marks the section panel scroller as the single locked pane scroll region", () => {
    renderProfileScreen();

    const regions = document.querySelectorAll(
      "[data-locked-pane-scroll-region]",
    );
    expect(regions).toHaveLength(1);

    const scrollArea = document.getElementById("profile-section-scroll-area");
    expect(scrollArea).not.toBeNull();
    expect(regions[0]).toBe(scrollArea);
    expect(scrollArea?.className).toContain("overflow-y-auto");
  });

  it("allows changing sections after arriving through a focused deep link", () => {
    renderProfileScreen({
      initialEntry: "/job-finder/profile?section=sources&focus=job-sources",
    });

    fireEvent.click(screen.getByRole("tab", { name: /Preferences/ }));

    expect(
      screen
        .getByRole("tab", { name: /Preferences/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("textbox", { name: "Target roles" })).toBeTruthy();
  });

  it("keeps non-Basics tabs above a compact resume summary instead of the full review surface", () => {
    renderProfileScreen({
      initialEntry: "/job-finder/profile?section=experience",
    });

    const summary = document.querySelector("[data-profile-resume-summary]");
    expect(summary).toBeTruthy();
    expect(summary?.parentElement?.className).not.toContain("pb-[4.5rem]");
    expect(
      screen
        .getByRole("tab", { name: /Work history/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getAllByText("Work history").length).toBeGreaterThan(0);
    expect(screen.queryByText("Imported details")).toBeNull();
    expect(screen.queryByText("Optional review")).toBeNull();
  });

  it("puts the editable Basics content before the detailed resume review surface", () => {
    renderProfileScreen({
      initialEntry: "/job-finder/profile?section=basics",
    });

    expect(
      document.querySelector("[data-profile-resume-summary]"),
    ).toBeTruthy();
    expect(document.querySelector("[data-profile-resume-review]")).toBeTruthy();
    expect(screen.getByText("Imported details")).toBeTruthy();

    const summary = document.querySelector("[data-profile-resume-summary]");
    const basicsEditor = document.querySelector(
      '[aria-labelledby="basics-tab"][role="tabpanel"]',
    );
    const detailedReview = document.querySelector(
      "[data-profile-resume-review]",
    );

    expect(summary).toBeTruthy();
    expect(basicsEditor).toBeTruthy();
    expect(detailedReview).toBeTruthy();
    if (!basicsEditor || !detailedReview) {
      throw new Error(
        "Expected the Basics editor and detailed resume review surface to render.",
      );
    }
    expect(
      basicsEditor.compareDocumentPosition(detailedReview) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
