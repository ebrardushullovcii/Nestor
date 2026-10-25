// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  ApplicationRecord,
  CompanyEntity,
  CompanyIntelligenceMutationInput,
  ListingActivity,
  SavedJob,
} from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyDetailScreen } from "./company-detail-screen";
import { describeCompanySalaryOfferEvidence } from "./company-presentation";

afterEach(cleanup);

const now = "2026-08-15T10:00:00.000Z";

function makeCompany(overrides: Partial<CompanyEntity> = {}): CompanyEntity {
  return {
    id: "company_1",
    canonicalName: "Acme Inc",
    aliases: [],
    domains: [],
    preference: "neutral",
    preferenceReason: null,
    mergeReviewCandidates: [],
    contacts: [],
    notes: [],
    salaryOfferEvidence: [],
    sourceHistory: [],
    jobIds: ["job_1"],
    applicationRecordIds: ["app_1"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * The option values of a select. R10 put a stored record id inside the
 * option's own text ("… (job_target_site_…_click)"); these tests therefore
 * identify options by their value, which is storage, not copy.
 */
function optionValues(select: HTMLElement): string[] {
  return [...select.querySelectorAll("option")].map((option) => option.value);
}

function makeJob(
  id: string,
  overrides: Partial<SavedJob> & { listingActivity?: ListingActivity } = {},
): SavedJob {
  return {
    id,
    source: "target_site",
    sourceJobId: `source_${id}`,
    discoveryMethod: "catalog_seed",
    canonicalUrl: `https://jobs.example.com/${id}`,
    applicationUrl: null,
    title: "Engineer",
    company: "Acme Inc",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: null,
    postedAtText: null,
    providerUpdatedAt: null,
    discoveredAt: now,
    firstSeenAt: null,
    lastSeenAt: null,
    lastVerifiedActiveAt: null,
    salaryText: null,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    },
    summary: null,
    description: "A job.",
    keySkills: [],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    screeningHints: {},
    keywordSignals: [],
    benefits: [],
    status: "ready_for_review",
    matchAssessment: { score: 80, reasons: [], gaps: [] },
    provenance: [],
    discoveryFeedback: null,
    resumeApplicationMode: null,
    latestMatchAssessmentAudit: null,
    ...overrides,
  } as SavedJob;
}

function makeRecord(
  id: string,
  overrides: Partial<ApplicationRecord> = {},
): ApplicationRecord {
  return {
    id,
    jobId: "job_1",
    title: "Engineer",
    company: "Acme Inc",
    status: "submitted",
    lastActionLabel: "Submitted",
    nextActionLabel: null,
    lastUpdatedAt: now,
    lastAttemptState: "submitted",
    questionSummary: {
      total: 0,
      required: 0,
      answered: 0,
      unansweredRequired: 0,
    },
    latestBlocker: null,
    consentSummary: { status: "none", pendingCount: 0 },
    replaySummary: {
      sourceInstructionArtifactId: null,
      lastUrl: null,
      checkpointCount: 0,
      evidenceCount: 0,
    },
    events: [],
    crm: null,
    automationMode: "prepare_only" as const,
    ...overrides,
  };
}

function renderDetail(
  overrides: {
    actionMessage?: string | null;
    applicationRecords?: readonly ApplicationRecord[];
    company?: CompanyEntity;
    companies?: readonly CompanyEntity[];
    discoveryJobs?: readonly SavedJob[];
    isMergePending?: () => boolean;
    onMutate?: ReturnType<typeof vi.fn>;
    onReviewMerge?: ReturnType<typeof vi.fn>;
    onSetPreference?: ReturnType<typeof vi.fn>;
    onOpenJob?: ReturnType<typeof vi.fn>;
    onOpenApplication?: ReturnType<typeof vi.fn>;
    selectedJobId?: string;
    selectedApplicationRecordId?: string;
  } = {},
) {
  const company = overrides.company ?? makeCompany();
  const onMutate = overrides.onMutate ?? vi.fn(async () => {});
  const onReviewMerge = overrides.onReviewMerge ?? vi.fn(async () => {});
  const onSetPreference = overrides.onSetPreference ?? vi.fn(async () => {});
  const onOpenJob = overrides.onOpenJob ?? vi.fn();
  const onOpenApplication = overrides.onOpenApplication ?? vi.fn();
  const view = render(
    <CompanyDetailScreen
      actionMessage={overrides.actionMessage ?? null}
      applicationRecords={overrides.applicationRecords ?? [makeRecord("app_1")]}
      companies={overrides.companies ?? [company]}
      company={company}
      companyId={company.id}
      discoveryJobs={overrides.discoveryJobs ?? [makeJob("job_1")]}
      isMergePending={overrides.isMergePending ?? (() => false)}
      isMutationPending={() => false}
      isPreferencePending={() => false}
      onBack={vi.fn()}
      onMutateCompanyIntelligence={onMutate}
      onNavigate={vi.fn()}
      onOpenApplication={onOpenApplication}
      onOpenJob={onOpenJob}
      onReviewCompanyMerge={onReviewMerge}
      onSetCompanyPreference={onSetPreference}
      {...(overrides.selectedJobId
        ? { selectedJobId: overrides.selectedJobId }
        : {})}
      {...(overrides.selectedApplicationRecordId
        ? { selectedApplicationRecordId: overrides.selectedApplicationRecordId }
        : {})}
    />,
  );
  return {
    container: view.container,
    onMutate,
    onOpenApplication,
    onOpenJob,
    onReviewMerge,
    onSetPreference,
    unmount: view.unmount,
  };
}

describe("CompanyDetailScreen", () => {
  it("opens the selected late opening and application on their own pages", () => {
    const jobs = Array.from({ length: 123 }, (_, index) =>
      makeJob(`job_${String(index).padStart(3, "0")}`, {
        title: `Role ${index}`,
      }),
    );
    const records = jobs.map((job, index) =>
      makeRecord(`app_${String(index).padStart(3, "0")}`, {
        jobId: job.id,
        title: `Application ${index}`,
      }),
    );
    const { onOpenJob, onOpenApplication } = renderDetail({
      company: makeCompany({
        jobIds: jobs.map((job) => job.id),
        applicationRecordIds: records.map((record) => record.id),
      }),
      discoveryJobs: jobs,
      applicationRecords: records,
      selectedJobId: "job_122",
      selectedApplicationRecordId: "app_122",
    });
    const openings = screen.getByRole("list", {
      name: "openings needing verification",
    });
    const applications = screen.getByRole("list", {
      name: "company applications",
    });
    expect(openings.querySelectorAll("li")).toHaveLength(23);
    expect(applications.querySelectorAll("li")).toHaveLength(23);
    const job = within(openings).getByText("Role 122").closest("li")!;
    fireEvent.click(within(job).getByRole("button"));
    expect(onOpenJob).toHaveBeenCalledWith("job_122");
    const record = within(applications)
      .getByText("Application 122")
      .closest("li")!;
    fireEvent.click(within(record).getByRole("button"));
    expect(onOpenApplication).toHaveBeenCalledWith("app_122");
    expect(screen.getAllByText("Page 3 of 3")).toHaveLength(2);
  });

  it("keeps every evidence job reachable and preserves the selected job and unfinished note while paging", () => {
    const jobs = Array.from({ length: 123 }, (_, index) =>
      makeJob(`job_${index}`, { title: `Role ${index}` }),
    );
    renderDetail({
      company: makeCompany({ jobIds: jobs.map((job) => job.id) }),
      discoveryJobs: jobs,
    });
    fireEvent.change(screen.getByLabelText("New note"), {
      target: { value: "Unfinished note" },
    });
    const select = screen.getByLabelText<HTMLSelectElement>("Evidence job");
    fireEvent.change(select, { target: { value: "job_1" } });
    const pagination = screen.getByRole("navigation", {
      name: "evidence jobs pagination",
    });
    const seen = new Set<string>();
    for (;;) {
      optionValues(select)
        .filter(Boolean)
        .forEach((id) => seen.add(id));
      expect(select.options.length).toBeLessThanOrEqual(51);
      expect(select.value).toBe("job_1");
      const next = within(pagination).getByRole<HTMLButtonElement>("button", {
        name: "Next page",
      });
      if (next.disabled) break;
      fireEvent.click(next);
    }
    expect(seen.size).toBe(jobs.length);
    expect(seen.has("job_99")).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("New note").value).toBe(
      "Unfinished note",
    );
    expect(
      within(pagination).getByRole("button", { name: "Previous page" }),
    ).toHaveProperty("disabled", false);
  });

  it("bounds company contacts and notes while preserving a contact draft", () => {
    const contacts = Array.from({ length: 123 }, (_, index) => ({
      id: `contact_${index}`,
      name: `Person ${index}`,
      role: null,
      email: null,
      phone: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
    }));
    const notes = contacts.map((contact, index) => ({
      id: `note_${index}`,
      body: `Note ${index}`,
      createdAt: now,
      updatedAt: now,
    }));
    renderDetail({ company: makeCompany({ contacts, notes }) });
    expect(
      screen.getByRole("list", { name: "contacts" }).querySelectorAll("li"),
    ).toHaveLength(50);
    expect(
      screen.getByRole("list", { name: "notes" }).querySelectorAll("li"),
    ).toHaveLength(50);
    const first = within(screen.getByRole("list", { name: "contacts" }))
      .getByText("Person 0")
      .closest("li")!;
    fireEvent.click(within(first).getByRole("button", { name: "Edit" }));
    const name = screen.getByLabelText<HTMLInputElement>("Name");
    fireEvent.change(name, { target: { value: "Unfinished edit" } });
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "contacts pagination" }),
      ).getByRole("button", { name: "Next page" }),
    );
    expect(name.value).toBe("Unfinished edit");
    expect(screen.getByRole("button", { name: "Save contact" })).toBeTruthy();
  });

  it("bounds duplicate jobs, source history, merge reviews and salary evidence independently", () => {
    const jobs = Array.from({ length: 246 }, (_, index) =>
      makeJob(`duplicate_${index}`, {
        title: `Role ${index}`,
        canonicalUrl: `https://jobs.example.com/pair_${Math.floor(index / 2)}`,
      }),
    );
    const company = makeCompany({
      jobIds: jobs.map((job) => job.id),
      sourceHistory: Array.from({ length: 123 }, (_, index) => ({
        id: `source_${index}`,
        sourceId: `Source ${index}`,
        firstSeenAt: now,
        lastSeenAt: now,
        applicationRecordIds: [],
      })),
      mergeReviewCandidates: Array.from({ length: 123 }, (_, index) => ({
        candidateCompanyId: `company_candidate_${index}`,
        reason: `Review candidate ${index}`,
        decision: "pending",
        decidedAt: null,
        requiresUserDecision: true,
      })),
      salaryOfferEvidence: Array.from({ length: 123 }, (_, index) => ({
        id: `evidence_${index}`,
        kind: "note",
        summary: `Evidence ${index}`,
        currency: null,
        minimum: null,
        maximum: null,
        period: null,
        offerStatus: null,
        jobId: null,
        applicationRecordId: null,
        source: "manual",
        recordedAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    });
    renderDetail({ company, discoveryJobs: jobs });
    for (const label of [
      "duplicate jobs",
      "source history",
      "duplicate employers",
      "salary / offer evidence",
    ]) {
      const list = screen.getByRole("list", { name: label });
      expect(list.children).toHaveLength(50);
      const pagination = screen.getByRole("navigation", {
        name: `${label} pagination`,
      });
      fireEvent.click(
        within(pagination).getByRole("button", { name: "Next page" }),
      );
      fireEvent.click(
        within(pagination).getByRole("button", { name: "Next page" }),
      );
      expect(list.children).toHaveLength(23);
      expect(within(pagination).getByText("Page 3 of 3")).toBeTruthy();
    }
    expect(screen.getByText("Evidence 122", { exact: false })).toBeTruthy();
    expect(screen.getByText("Review candidate 122")).toBeTruthy();
    expect(screen.getByText("Source 122")).toBeTruthy();
  });

  it("keeps every evidence application reachable while the chosen record stays selected", () => {
    const records = Array.from({ length: 123 }, (_, index) =>
      makeRecord(`app_${index}`, { title: `Application ${index}` }),
    );
    renderDetail({
      company: makeCompany({
        applicationRecordIds: records.map((record) => record.id),
      }),
      applicationRecords: records,
    });
    fireEvent.change(screen.getByLabelText("Evidence job"), {
      target: { value: "job_1" },
    });
    const select = screen.getByLabelText<HTMLSelectElement>(
      "Evidence application record",
    );
    fireEvent.change(select, { target: { value: "app_1" } });
    const navigation = screen.getByRole("navigation", {
      name: "evidence application records pagination",
    });
    const seen = new Set<string>();
    for (;;) {
      optionValues(select)
        .filter(Boolean)
        .forEach((id) => seen.add(id));
      expect(select.value).toBe("app_1");
      expect(select.options.length).toBeLessThanOrEqual(51);
      const next = within(navigation).getByRole<HTMLButtonElement>("button", {
        name: "Next page",
      });
      if (next.disabled) break;
      fireEvent.click(next);
    }
    expect(seen.size).toBe(records.length);
    expect(seen.has("app_99")).toBe(true);
  });

  it.each([3000, 10000])(
    "bounds %i company openings and applications",
    (count) => {
      const jobs = Array.from({ length: count }, (_, index) =>
        makeJob(`job_${String(index).padStart(5, "0")}`, {
          title: `Scale role ${index}`,
          listingActivity:
            index % 3 === 0
              ? { status: "active", observedAt: now, evidence: "last_seen_at" }
              : index % 3 === 1
                ? { status: "unknown" }
                : {
                    status: "closed",
                    observedAt: now,
                    detail: null,
                    confidence: 1,
                    provenance: "provider",
                    explanation: "The provider reported it closed.",
                    signalId: `closed_${index}`,
                  },
        }),
      );
      const records = jobs.map((job, index) =>
        makeRecord(`app_${String(index).padStart(5, "0")}`, {
          jobId: job.id,
          title: job.title,
        }),
      );
      const { container } = renderDetail({
        company: makeCompany({
          jobIds: jobs.map((job) => job.id),
          applicationRecordIds: records.map((record) => record.id),
        }),
        discoveryJobs: jobs,
        applicationRecords: records,
      });
      const mounted = container.querySelectorAll("li").length;
      for (const label of [
        "last seen available openings",
        "openings needing verification",
        "reported closed openings",
        "company applications",
      ]) {
        expect(
          container.querySelector(`ul[aria-label="${label}"]`)?.children.length,
        ).toBe(50);
      }
      const options = container
        .querySelector('select[aria-label="Evidence job"]')
        ?.querySelectorAll("option").length;
      console.info(
        JSON.stringify({
          probe: "company details",
          count,
          mounted,
          options,
          nodes: container.querySelectorAll("*").length,
        }),
      );
      expect(mounted).toBeLessThanOrEqual(200);
      expect(options).toBeLessThanOrEqual(51);
    },
    60000,
  );

  it("aggregates current openings, application history, and links to each record", () => {
    const { onOpenJob, onOpenApplication } = renderDetail();

    expect(screen.getByText("Acme Inc")).toBeTruthy();
    expect(screen.getByText("Openings (1)")).toBeTruthy();
    expect(screen.getByText("Applications (1)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open job" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open application" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open job" }));
    expect(onOpenJob).toHaveBeenCalledWith("job_1");

    fireEvent.click(screen.getByRole("button", { name: "Open application" }));
    expect(onOpenApplication).toHaveBeenCalledWith("app_1");
  });

  it("presents internal source history identifiers as user-facing labels", () => {
    renderDetail({
      company: makeCompany({
        sourceHistory: [
          {
            id: "source_ref_1",
            sourceId: "target_site",
            firstSeenAt: now,
            lastSeenAt: now,
            applicationRecordIds: ["app_1"],
          },
        ],
      }),
    });

    expect(screen.getByText("Job source")).toBeTruthy();
    expect(screen.queryByText("target_site")).toBeNull();
  });

  it("labels provider-only listing freshness as updated", () => {
    renderDetail({
      discoveryJobs: [
        makeJob("job_1", {
          providerUpdatedAt: "2026-08-15T10:00:00.000Z",
        }),
      ],
    });

    expect(screen.getByText(/Updated 15 Aug 2026/)).toBeTruthy();
    expect(screen.queryByText(/Posted 15 Aug 2026/)).toBeNull();
  });

  it("groups all activity states independently from workflow and keeps evidence readable", () => {
    const company = makeCompany({
      jobIds: ["active", "inactive", "stale", "closed", "unknown"],
    });
    renderDetail({
      company,
      discoveryJobs: [
        makeJob("active", {
          title: "Active but rejected workflow",
          status: "rejected",
          listingActivity: {
            status: "active",
            observedAt: "2026-08-15T10:00:00.000Z",
            evidence: "last_seen_at",
          },
        }),
        makeJob("inactive", {
          title: "Inactive but discovered workflow",
          status: "discovered",
          listingActivity: {
            status: "inactive",
            observedAt: "2026-08-14T10:00:00.000Z",
            ledgerEntryId: "ledger_1",
            provenance: "discovery_ledger",
            explanation: "Missing from a complete source refresh.",
          },
        }),
        makeJob("stale", {
          title: "Stale role",
          listingActivity: {
            status: "stale",
            observedAt: "2026-08-13T10:00:00.000Z",
            signalId: "signal_stale",
            provenance: "browser",
            explanation: "The source displayed an expiry warning.",
            detail:
              "This deliberately long evidence detail remains wrapped and readable without truncation.",
            confidence: 0.8,
          },
        }),
        makeJob("closed", {
          title: "Closed but shortlisted workflow",
          status: "shortlisted",
          listingActivity: {
            status: "closed",
            observedAt: "2026-08-12T10:00:00.000Z",
            signalId: "signal_closed",
            provenance: "provider",
            explanation: "The provider marked the posting closed.",
            detail: null,
            confidence: 1,
          },
        }),
        makeJob("unknown", {
          title: "Unknown role",
          listingActivity: { status: "unknown" },
        }),
      ],
    });

    expect(screen.getByText("Last seen available")).toBeTruthy();
    expect(screen.getByText("Needs verification")).toBeTruthy();
    expect(screen.getByText("Reported closed")).toBeTruthy();
    expect(screen.getByText("Active but rejected workflow")).toBeTruthy();
    expect(screen.getByText(/· Rejected/)).toBeTruthy();
    expect(screen.getByText("Closed but shortlisted workflow")).toBeTruthy();
    expect(screen.getAllByText(/· Shortlisted/).length).toBeGreaterThan(0);
    expect(screen.getByText("Listing availability is unknown.")).toBeTruthy();
    expect(
      screen.getByText(
        /This deliberately long evidence detail remains wrapped/,
      ),
    ).toBeTruthy();
  });

  it("detects duplicate postings and distinguishes exact from possible matches", () => {
    const company = makeCompany({
      jobIds: ["job_a", "job_b", "job_c"],
    });
    renderDetail({
      company,
      discoveryJobs: [
        makeJob("job_a", {
          title: "Engineer",
          location: "Remote",
          sourceJobId: "posting_1",
          canonicalUrl: "https://jobs.example.com/a",
        }),
        // Same source posting id: exact duplicate.
        makeJob("job_b", {
          title: "Engineer",
          location: "Remote",
          sourceJobId: "posting_1",
          canonicalUrl: "https://jobs.example.com/b",
        }),
        makeJob("job_c", {
          title: "Designer",
          location: "London",
          sourceJobId: "posting_3",
          canonicalUrl: "https://jobs.example.com/c",
        }),
      ],
    });

    expect(screen.getByText("Duplicate jobs (1)")).toBeTruthy();
    expect(screen.getByText("Exact match")).toBeTruthy();
  });

  it("records contacts, notes, and salary/offer evidence through typed local mutations", () => {
    const company = makeCompany({
      contacts: [
        {
          id: "contact_1",
          name: "Ada",
          role: null,
          email: null,
          phone: null,
          notes: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      notes: [
        {
          id: "note_1",
          body: "First call went well",
          createdAt: now,
          updatedAt: now,
        },
      ],
      salaryOfferEvidence: [
        {
          id: "evidence_1",
          kind: "offer",
          summary: "Verbal offer 190k",
          currency: "USD",
          minimum: 190000,
          maximum: 190000,
          period: "year",
          offerStatus: "active",
          jobId: null,
          applicationRecordId: null,
          source: "manual",
          recordedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const { onMutate } = renderDetail({ company });

    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("First call went well")).toBeTruthy();
    expect(screen.getByText(/Verbal offer 190k/)).toBeTruthy();

    // Add a note through the visible form.
    fireEvent.change(screen.getByLabelText("New note"), {
      target: { value: "Second call scheduled" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const noteCommand = onMutate.mock.calls[0]?.[0] as {
      companyId: string;
      expectedUpdatedAt: string;
      mutation: { type: string; note: { body: string } };
    };
    expect(noteCommand.companyId).toBe("company_1");
    expect(noteCommand.expectedUpdatedAt).toBe(now);
    expect(noteCommand.mutation.type).toBe("add_note");
    expect(noteCommand.mutation.note.body).toBe("Second call scheduled");
    expect(noteCommand).not.toHaveProperty("mutation.submitAuthorized");

    // Remove the contact.
    fireEvent.click(screen.getByRole("button", { name: "Remove contact Ada" }));
    const removeCommand = onMutate.mock.calls[1]?.[0] as {
      mutation: { type: string; contactId: string };
    };
    expect(removeCommand.mutation.type).toBe("remove_contact");
    expect(removeCommand.mutation.contactId).toBe("contact_1");

    // Remove the evidence record.
    fireEvent.click(screen.getByRole("button", { name: /Remove Offer/ }));
    const removeEvidence = onMutate.mock.calls[2]?.[0] as {
      mutation: { type: string; evidenceId: string };
    };
    expect(removeEvidence.mutation.type).toBe("remove_salary_offer_evidence");
    expect(removeEvidence.mutation.evidenceId).toBe("evidence_1");
  });

  it("retains an evidence edit after a failed save and resets only after retry succeeds", async () => {
    const company = makeCompany({
      salaryOfferEvidence: [
        {
          id: "evidence_1",
          kind: "offer",
          summary: "Verbal offer 190k",
          currency: "USD",
          minimum: 190000,
          maximum: null,
          period: "year",
          offerStatus: "active",
          jobId: "job_1",
          applicationRecordId: "app_1",
          source: "manual",
          recordedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const onMutate = vi
      .fn()
      .mockRejectedValueOnce(new Error("Evidence save failed"))
      .mockResolvedValueOnce(undefined);
    renderDetail({ company, onMutate });

    fireEvent.click(screen.getByRole("button", { name: /Edit Offer/ }));
    const summary =
      screen.getByPlaceholderText<HTMLInputElement>(/Verbal offer/);
    fireEvent.change(summary, { target: { value: "Revised offer 200k" } });
    fireEvent.click(screen.getByRole("button", { name: "Save evidence" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Evidence save failed",
    );
    expect(summary.value).toBe("Revised offer 200k");
    expect(screen.getByLabelText<HTMLSelectElement>("Evidence job").value).toBe(
      "job_1",
    );
    expect(
      screen.getByLabelText<HTMLSelectElement>("Evidence application record")
        .value,
    ).toBe("app_1");
    expect(screen.getByRole("button", { name: "Save evidence" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save evidence" }));
    await waitFor(() => expect(onMutate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(summary.value).toBe(""));
    expect(screen.getByRole("button", { name: "Add evidence" })).toBeTruthy();
  });

  it("formats known salary periods unchanged and labels a missing period unknown", () => {
    const evidence = {
      id: "evidence_1",
      kind: "listed_salary" as const,
      summary: "Listed range",
      currency: "USD",
      minimum: 100,
      maximum: null,
      period: null,
      offerStatus: null,
      jobId: "job_1",
      applicationRecordId: null,
      source: "manual" as const,
      recordedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    expect(describeCompanySalaryOfferEvidence(evidence)).toBe(
      "$100 · Period unknown",
    );
    expect(
      describeCompanySalaryOfferEvidence({ ...evidence, period: "hour" }),
    ).toBe("$100/hr");
    expect(
      describeCompanySalaryOfferEvidence({ ...evidence, period: "month" }),
    ).toBe("$100/mo");
    expect(
      describeCompanySalaryOfferEvidence({ ...evidence, period: "year" }),
    ).toBe("$100/yr");
  });

  it("keeps an evidence edit intact when delete fails and allows one retry", async () => {
    const company = makeCompany({
      salaryOfferEvidence: [
        {
          id: "evidence_1",
          kind: "listed_salary",
          summary: "Published range",
          currency: "USD",
          minimum: 180000,
          maximum: 220000,
          period: "year",
          offerStatus: null,
          jobId: "job_1",
          applicationRecordId: null,
          source: "manual",
          recordedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const onMutate = vi
      .fn()
      .mockRejectedValueOnce(new Error("Evidence delete failed"))
      .mockResolvedValueOnce(undefined);
    renderDetail({ company, onMutate });

    fireEvent.click(screen.getByRole("button", { name: /Edit Listed salary/ }));
    const summary =
      screen.getByPlaceholderText<HTMLInputElement>(/Verbal offer/);
    fireEvent.change(summary, { target: { value: "Draft remains" } });
    const remove = screen.getByRole("button", {
      name: /Remove Listed salary/,
    });
    fireEvent.click(remove);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Evidence delete failed",
    );
    expect(summary.value).toBe("Draft remains");
    expect(screen.getByRole("button", { name: "Save evidence" })).toBeTruthy();

    fireEvent.click(remove);
    await waitFor(() => expect(onMutate).toHaveBeenCalledTimes(2));
  });

  it("gives evidence actions unique record-specific accessible names", () => {
    const evidence = (id: string, summary: string, minimum: number) => ({
      id,
      kind: "listed_salary" as const,
      summary,
      currency: "USD",
      minimum,
      maximum: null,
      period: "year" as const,
      offerStatus: null,
      jobId: "job_1",
      applicationRecordId: null,
      source: "manual" as const,
      recordedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    renderDetail({
      company: makeCompany({
        salaryOfferEvidence: [
          evidence("evidence_1", "Initial range", 180000),
          evidence("evidence_2", "Updated range", 200000),
        ],
      }),
      discoveryJobs: [makeJob("job_1", { title: "Platform Engineer" })],
    });

    const editNames = screen
      .getAllByRole("button", { name: /Edit Listed salary/ })
      .map((button) => button.getAttribute("aria-label"));
    const removeNames = screen
      .getAllByRole("button", { name: /Remove Listed salary/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(new Set(editNames).size).toBe(2);
    expect(new Set(removeNames).size).toBe(2);
    expect(editNames[0]).toContain(
      'Listed salary "Initial range" for Acme Inc, Platform Engineer; $180,000/yr; recorded 2026-08-15',
    );
  });

  it("requires an explicit application choice for offers without preselecting siblings", () => {
    const company = makeCompany({ applicationRecordIds: ["app_1", "app_2"] });
    const { onMutate } = renderDetail({
      company,
      applicationRecords: [makeRecord("app_1"), makeRecord("app_2")],
    });

    fireEvent.change(screen.getByLabelText("Evidence job"), {
      target: { value: "job_1" },
    });
    fireEvent.change(screen.getByText("Kind").nextElementSibling!, {
      target: { value: "offer" },
    });
    const application = screen.getByLabelText<HTMLSelectElement>(
      "Evidence application record",
    );
    expect(application.value).toBe("");
    expect(within(application).getByText(/Job only/)).toBeTruthy();
    expect(optionValues(application)).toContain("app_1");
    expect(optionValues(application)).toContain("app_2");

    fireEvent.change(screen.getByPlaceholderText(/Verbal offer/), {
      target: { value: "Offer 200k" },
    });
    expect(
      screen
        .getByRole("button", { name: "Add evidence" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(application, { target: { value: "app_2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
    const offerCommand = onMutate.mock.calls[0]?.[0] as
      | CompanyIntelligenceMutationInput
      | undefined;
    expect(offerCommand).toMatchObject({
      mutation: {
        type: "upsert_salary_offer_evidence",
        evidence: {
          kind: "offer",
          jobId: "job_1",
          applicationRecordId: "app_2",
        },
      },
    });
  });

  it("allows job-scoped listed salary when the job has no application", () => {
    const { onMutate } = renderDetail({
      company: makeCompany({ applicationRecordIds: [] }),
      applicationRecords: [],
    });
    fireEvent.change(screen.getByText("Kind").nextElementSibling!, {
      target: { value: "listed_salary" },
    });
    fireEvent.change(screen.getByLabelText("Evidence job"), {
      target: { value: "job_1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Verbal offer/), {
      target: { value: "Listed range" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add evidence" }));
    const salaryCommand = onMutate.mock.calls[0]?.[0] as
      | CompanyIntelligenceMutationInput
      | undefined;
    expect(salaryCommand).toMatchObject({
      mutation: {
        type: "upsert_salary_offer_evidence",
        evidence: {
          kind: "listed_salary",
          jobId: "job_1",
          applicationRecordId: null,
        },
      },
    });
  });

  it("omits stale jobs but keeps an exact name match on a shared ATS domain", () => {
    const acme = makeCompany({
      id: "acme",
      canonicalName: "Acme Inc",
      jobIds: ["job_stale", "job_ambiguous"],
      domains: [{ domain: "shared.example", primary: true, verifiedAt: null }],
    });
    const other = makeCompany({
      id: "other",
      canonicalName: "Other Inc",
      jobIds: ["job_stale"],
      domains: [
        { domain: "other.example", primary: true, verifiedAt: null },
        { domain: "shared.example", primary: false, verifiedAt: null },
      ],
    });
    renderDetail({
      company: acme,
      companies: [acme, other],
      discoveryJobs: [
        makeJob("job_stale", {
          company: "Other Inc",
          employerDomain: "other.example",
        }),
        makeJob("job_ambiguous", {
          company: "Acme Inc",
          employerDomain: "shared.example",
        }),
      ],
    });

    const jobSelect = screen.getByLabelText("Evidence job");
    expect(optionValues(jobSelect)).not.toContain("job_stale");
    expect(optionValues(jobSelect)).toContain("job_ambiguous");
    // The option names the job, never its stored id.
    expect(jobSelect.textContent).not.toContain("job_ambiguous");
    expect(jobSelect.textContent).toContain("Engineer · Acme Inc");
  });

  it("accepts only user-approved aliases as evidence job owners", () => {
    const company = makeCompany({
      jobIds: ["job_legacy", "job_approved"],
      aliases: [
        {
          alias: "Legacy Acme",
          normalized: "legacy acme",
          confidence: 1,
          identityAuthority: "unknown",
        },
        {
          alias: "Approved Acme",
          normalized: "approved acme",
          confidence: 1,
          identityAuthority: "user_approved_merge",
        },
      ],
    });
    renderDetail({
      company,
      discoveryJobs: [
        makeJob("job_legacy", { company: "Legacy Acme" }),
        makeJob("job_approved", { company: "Approved Acme" }),
      ],
    });

    const jobSelect = screen.getByLabelText("Evidence job");
    expect(within(jobSelect).queryByText(/job_legacy/)).toBeNull();
    expect(optionValues(jobSelect)).toContain("job_approved");
  });

  it("does not use a unique domain as a fallback when the company name is missing", () => {
    const company = makeCompany({
      jobIds: ["job_domain", "job_missing", "job_generic"],
      domains: [{ domain: "acme.example", primary: true, verifiedAt: null }],
    });
    renderDetail({
      company,
      discoveryJobs: [
        makeJob("job_domain", {
          company: "Different Company",
          employerDomain: "acme.example",
        }),
        makeJob("job_missing", {
          company: "",
          employerDomain: "acme.example",
        }),
        makeJob("job_generic", {
          company: "Confidential Employer",
          employerDomain: "acme.example",
        }),
      ],
    });

    const jobSelect = screen.getByLabelText("Evidence job");
    expect(within(jobSelect).queryByText(/job_domain/)).toBeNull();
    expect(within(jobSelect).queryByText(/job_missing/)).toBeNull();
    expect(within(jobSelect).queryByText(/job_generic/)).toBeNull();
  });

  it("keeps an acquisition name separate until its alias is approved", () => {
    const acquired = makeCompany({
      id: "acquired",
      canonicalName: "Old Name",
      jobIds: ["job_new_name"],
      aliases: [
        {
          alias: "New Name",
          normalized: "new name",
          confidence: 1,
          identityAuthority: "unknown",
        },
      ],
    });
    const newCompany = makeCompany({
      id: "new_company",
      canonicalName: "New Name",
      jobIds: ["job_new_name"],
    });
    renderDetail({
      company: acquired,
      companies: [acquired, newCompany],
      discoveryJobs: [makeJob("job_new_name", { company: "New Name" })],
    });

    expect(optionValues(screen.getByLabelText("Evidence job"))).not.toContain(
      "job_new_name",
    );
  });

  it("uses service-parity C++ and C# identity normalization for evidence candidates", () => {
    const cpp = makeCompany({
      id: "cpp",
      canonicalName: "C++ Labs",
      jobIds: ["job_cpp"],
    });
    const csharp = makeCompany({
      id: "csharp",
      canonicalName: "C# Labs",
      jobIds: ["job_csharp"],
    });
    renderDetail({
      company: cpp,
      companies: [cpp, csharp],
      discoveryJobs: [
        makeJob("job_cpp", { company: "C ++ Labs" }),
        makeJob("job_csharp", { company: "C # Labs" }),
      ],
    });

    const jobSelect = screen.getByLabelText("Evidence job");
    expect(optionValues(jobSelect)).toContain("job_cpp");
    expect(within(jobSelect).queryByText(/job_csharp/)).toBeNull();
  });

  it("omits a job when unique name and domain resolve to different companies", () => {
    const acme = makeCompany({
      id: "acme",
      canonicalName: "Acme Inc",
      jobIds: ["job_conflict"],
      domains: [{ domain: "acme.example", primary: true, verifiedAt: null }],
    });
    const other = makeCompany({
      id: "other",
      canonicalName: "Other Inc",
      domains: [{ domain: "other.example", primary: true, verifiedAt: null }],
    });
    renderDetail({
      company: acme,
      companies: [acme, other],
      discoveryJobs: [
        makeJob("job_conflict", {
          company: "Acme Inc",
          employerDomain: "other.example",
        }),
      ],
    });

    expect(optionValues(screen.getByLabelText("Evidence job"))).not.toContain(
      "job_conflict",
    );
  });

  it("keeps a unique name match when its unique domain resolves to the same company", () => {
    const company = makeCompany({
      id: "acme",
      jobIds: ["job_same_company"],
      domains: [{ domain: "acme.example", primary: true, verifiedAt: null }],
    });
    renderDetail({
      company,
      discoveryJobs: [
        makeJob("job_same_company", {
          company: "Acme Inc",
          employerDomain: "acme.example",
        }),
      ],
    });

    expect(optionValues(screen.getByLabelText("Evidence job"))).toContain(
      "job_same_company",
    );
  });

  it("offers applications only for the selected eligible job and clears the previous choice", () => {
    const company = makeCompany({
      jobIds: ["job_1", "job_2"],
      applicationRecordIds: ["app_1", "app_2", "app_unowned"],
    });
    renderDetail({
      company,
      discoveryJobs: [makeJob("job_1"), makeJob("job_2")],
      applicationRecords: [
        makeRecord("app_1", { jobId: "job_1" }),
        makeRecord("app_2", { jobId: "job_2" }),
        makeRecord("app_unowned", { jobId: "job_missing" }),
      ],
    });

    const jobSelect = screen.getByLabelText("Evidence job");
    fireEvent.change(jobSelect, { target: { value: "job_1" } });
    const firstApplication = screen.getByLabelText<HTMLSelectElement>(
      "Evidence application record",
    );
    expect(optionValues(firstApplication)).toContain("app_1");
    expect(optionValues(firstApplication)).not.toContain("app_2");
    fireEvent.change(firstApplication, { target: { value: "app_1" } });

    fireEvent.change(jobSelect, { target: { value: "job_2" } });
    const secondApplication = screen.getByLabelText<HTMLSelectElement>(
      "Evidence application record",
    );
    expect(secondApplication.value).toBe("");
    expect(optionValues(secondApplication)).not.toContain("app_1");
    expect(optionValues(secondApplication)).toContain("app_2");
    expect(optionValues(secondApplication)).not.toContain("app_unowned");
  });

  it("lets the user merge or reject a pending duplicate candidate explicitly", () => {
    const company = makeCompany({
      mergeReviewCandidates: [
        {
          candidateCompanyId: "company_2",
          reason: "Similar company name.",
          decision: "pending",
          decidedAt: null,
          requiresUserDecision: true,
        },
      ],
    });
    const { onReviewMerge } = renderDetail({ company });

    expect(screen.getByText("Duplicate employer review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReviewMerge).toHaveBeenCalledWith({
      companyId: "company_1",
      candidateId: "company_2",
      decision: "rejected",
    });

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(onReviewMerge).toHaveBeenCalledWith({
      companyId: "company_1",
      candidateId: "company_2",
      decision: "accepted",
    });
  });

  it("labels company preferences as local tracking with no submission side effects", () => {
    const { onSetPreference } = renderDetail();

    expect(
      screen.getByText(
        "Local company tracking only. This does not change job search or matching.",
      ),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("Company tracking preference for Acme Inc"),
      {
        target: { value: "prefer" },
      },
    );
    expect(onSetPreference).toHaveBeenCalledWith({
      companyId: "company_1",
      preference: "prefer",
    });
  });

  it("omits duplicate employer review entirely when no candidate is pending", () => {
    const { unmount } = renderDetail();

    expect(screen.queryByText("Duplicate employer review")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    unmount();

    renderDetail({
      company: makeCompany({
        mergeReviewCandidates: [
          {
            candidateCompanyId: "company_2",
            reason: "Similar company name.",
            decision: "rejected",
            decidedAt: now,
            requiresUserDecision: true,
          },
        ],
      }),
    });
    expect(screen.queryByText("Duplicate employer review")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("renders a compact header ordered back, title, status, then preference", () => {
    const { container } = renderDetail();

    const header = container.querySelector("header");
    expect(header).toBeTruthy();

    const back = within(header as HTMLElement).getByRole("button", {
      name: "All companies",
    });
    const heading = within(header as HTMLElement).getByRole("heading", {
      level: 1,
    });
    const preference = within(header as HTMLElement).getByLabelText(
      "Company tracking preference for Acme Inc",
    );

    expect(
      back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      heading.compareDocumentPosition(preference) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(
      within(header as HTMLElement).queryByText(/submission authority/i),
    ).toBeNull();
    expect(screen.queryByText("0 sources")).toBeNull();
  });

  it("gives every select control the 44px field height", () => {
    const company = makeCompany({
      salaryOfferEvidence: [
        {
          id: "evidence_1",
          kind: "offer",
          summary: "Verbal offer 190k",
          currency: "USD",
          minimum: 190000,
          maximum: null,
          period: "year",
          offerStatus: "active",
          jobId: null,
          applicationRecordId: null,
          source: "manual",
          recordedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    renderDetail({ company });

    for (const select of screen.getAllByRole("combobox")) {
      expect(select.className).toContain("h-11");
      expect(select.className).not.toContain("h-9");
      expect(select.className).not.toContain("h-10");
    }
  });

  it("shows the transient status channel only when a message exists", async () => {
    const { unmount } = renderDetail({
      actionMessage: "Preference saved.",
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Preference saved.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();

    renderDetail();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();

    const onMutate = vi.fn(() => Promise.reject(new Error("Save failed")));
    renderDetail({ onMutate });
    fireEvent.change(screen.getByLabelText("New note"), {
      target: { value: "Note body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Save failed");
  });

  it("wraps long company names without leaving the header row", () => {
    const longName =
      "Averylongcompanyname Global Holdings and Manufacturing Consortium Limited";
    const { container } = renderDetail({
      company: makeCompany({ canonicalName: longName }),
    });

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain(longName);
    expect(heading.className).toContain("min-w-0");
    expect(heading.className).toContain("break-words");
    expect(container.querySelector("header")?.className).toContain("flex-wrap");
  });

  it("orders evidence sections openings first and local CRM sections after", () => {
    renderDetail();

    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent ?? "");
    expect(headings).toEqual([
      "Acme Inc",
      "Openings (1)",
      "Applications (1)",
      "Duplicate jobs (0)",
      "Source history (0)",
      "Contacts",
      "Notes",
      "Salary / offer evidence",
    ]);
  });

  it("gives every editable select canonical tokens, focus hierarchy, and preserved geometry", () => {
    const onSetPreference = vi.fn(async () => {});
    const { container } = renderDetail({ onSetPreference });

    // Header tracking select plus evidence form Kind, Period, Offer status,
    // and Evidence job.
    expect(screen.getAllByRole("combobox")).toHaveLength(5);

    // Selecting a job reveals the application-record select.
    fireEvent.change(screen.getByLabelText("Evidence job"), {
      target: { value: "job_1" },
    });
    expect(screen.getAllByRole("combobox")).toHaveLength(6);

    const selects = Array.from(container.querySelectorAll("select"));
    for (const select of selects) {
      for (const className of [
        "border-(--field-border)",
        "bg-(--field)",
        "outline-none",
        "focus-visible:border-(--field-focus-border)",
        "focus-visible:bg-(--field-strong)",
        "focus-visible:shadow-[var(--field-focus-shadow)]",
      ]) {
        expect(select.className).toContain(className);
      }
      expect(select.className).not.toContain("border-input");
      expect(select.className).not.toContain("--surface-panel-raised");
      expect(select.className).not.toContain("focus-visible:ring");
      // Selects share the Input's 44px height so mixed rows align.
      expect(select.className).toContain("h-11");
      expect(select.className).toContain("rounded-(--radius-field)");
    }
    expect(container.innerHTML).not.toContain("border-input");

    // Native select behavior is unchanged for the protected tracking control,
    // including its disabled semantics hook and payload shape.
    fireEvent.change(
      screen.getByLabelText("Company tracking preference for Acme Inc"),
      { target: { value: "prefer" } },
    );
    expect(onSetPreference).toHaveBeenCalledWith({
      companyId: "company_1",
      preference: "prefer",
    });
  });
});
