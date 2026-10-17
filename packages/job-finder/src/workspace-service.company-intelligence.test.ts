import { ApplicationRecordSchema } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";

describe("workspace company intelligence end to end", () => {
  async function withReconciledCompanies(
    harness: ReturnType<typeof createWorkspaceServiceHarness>,
  ) {
    // The default campaign (including all saved jobs) is created lazily on
    // the first snapshot read; company entities are then reconciled from the
    // saved jobs exactly like the service does after every campaign run.
    await harness.workspaceService.getWorkspaceSnapshot();
    return harness.workspaceService.refreshCompanyIntelligence();
  }

  test("refreshCompanyIntelligence reconciles companies from saved jobs and applications", async () => {
    const harness = createWorkspaceServiceHarness();
    const snapshot = await withReconciledCompanies(harness);

    const companies = snapshot.intelligence.companies;
    expect(companies.length).toBeGreaterThanOrEqual(2);
    const signal = companies.find((company) =>
      company.jobIds.includes("job_ready"),
    );
    expect(signal).toBeDefined();
    expect(signal!.canonicalName).toBe("Signal Systems");
    expect(
      signal!.domains.some(
        (domain) => domain.domain === "signalsystems.example.com",
      ),
    ).toBe(true);
    const northwind = companies.find((company) =>
      company.jobIds.includes("job_generating"),
    );
    expect(northwind!.canonicalName).toBe("Northwind Labs");
  });

  test("mutateCompanyIntelligence persists contacts, notes, and salary/offer evidence locally", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const initial = await withReconciledCompanies(harness);
    const company = initial.intelligence.companies.find((entry) =>
      entry.jobIds.includes("job_ready"),
    );
    expect(company).toBeDefined();
    if (!company) return;

    const withContact = await workspaceService.mutateCompanyIntelligence({
      companyId: company.id,
      expectedUpdatedAt: company.updatedAt,
      mutation: {
        type: "upsert_contact",
        contact: {
          id: "contact_1",
          name: "Ada Lovelace",
          role: "Recruiter",
          email: "ada@signal.example.com",
          phone: null,
          notes: null,
          createdAt: "2026-08-15T10:00:00.000Z",
          updatedAt: "2026-08-15T10:00:00.000Z",
        },
      },
    });
    const withContactCompany = withContact.intelligence.companies.find(
      (entry) => entry.id === company.id,
    )!;
    expect(withContactCompany.contacts).toHaveLength(1);
    expect(withContactCompany.contacts[0]).toMatchObject({
      id: "contact_1",
      name: "Ada Lovelace",
    });

    const withNote = await workspaceService.mutateCompanyIntelligence({
      companyId: company.id,
      expectedUpdatedAt: withContactCompany.updatedAt,
      mutation: {
        type: "add_note",
        note: {
          id: "note_1",
          body: "Recruiter call scheduled.",
          createdAt: "2026-08-15T10:05:00.000Z",
          updatedAt: "2026-08-15T10:05:00.000Z",
        },
      },
    });
    const withNoteCompany = withNote.intelligence.companies.find(
      (entry) => entry.id === company.id,
    )!;
    expect(withNoteCompany.notes.map((note) => note.body)).toEqual([
      "Recruiter call scheduled.",
    ]);

    const withEvidence = await workspaceService.mutateCompanyIntelligence({
      companyId: company.id,
      expectedUpdatedAt: withNoteCompany.updatedAt,
      mutation: {
        type: "upsert_salary_offer_evidence",
        evidence: {
          id: "evidence_1",
          kind: "listed_salary",
          summary: "Listed range 190k",
          currency: "USD",
          minimum: 190000,
          maximum: 190000,
          period: "year",
          offerStatus: null,
          jobId: "job_ready",
          applicationRecordId: null,
          source: "manual",
          recordedAt: "2026-08-15T10:10:00.000Z",
          createdAt: "2026-08-15T10:10:00.000Z",
          updatedAt: "2026-08-15T10:10:00.000Z",
        },
      },
    });
    const withEvidenceCompany = withEvidence.intelligence.companies.find(
      (entry) => entry.id === company.id,
    )!;
    expect(withEvidenceCompany.salaryOfferEvidence).toHaveLength(1);
    expect(withEvidenceCompany.salaryOfferEvidence[0]!.jobId).toBe("job_ready");

    // A stale compare-and-swap is rejected so a concurrent merge/edit is never
    // overwritten.
    await expect(
      workspaceService.mutateCompanyIntelligence({
        companyId: company.id,
        expectedUpdatedAt: company.updatedAt,
        mutation: { type: "remove_note", noteId: "note_1" },
      }),
    ).rejects.toThrow(/changed since you opened/i);

    // The local tracking facts survive a refresh reconcile unchanged.
    const refreshed = await workspaceService.refreshCompanyIntelligence();
    const refreshedCompany = refreshed.intelligence.companies.find(
      (entry) => entry.id === company.id,
    )!;
    expect(refreshedCompany.contacts).toHaveLength(1);
    expect(refreshedCompany.notes).toHaveLength(1);
    expect(refreshedCompany.salaryOfferEvidence).toHaveLength(1);
  });

  test("rejects the second same-millisecond mutation using the first command's stale timestamp", async () => {
    const harness = createWorkspaceServiceHarness();
    const initial = await withReconciledCompanies(harness);
    const company = initial.intelligence.companies.find((entry) =>
      entry.jobIds.includes("job_ready"),
    )!;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(company.updatedAt));
    try {
      const first = await harness.workspaceService.mutateCompanyIntelligence({
        companyId: company.id,
        expectedUpdatedAt: company.updatedAt,
        mutation: {
          type: "add_note",
          note: {
            id: "same_millisecond_note",
            body: "First edit",
            createdAt: company.updatedAt,
            updatedAt: company.updatedAt,
          },
        },
      });
      const updated = first.intelligence.companies.find(
        (entry) => entry.id === company.id,
      )!;
      expect(Date.parse(updated.updatedAt)).toBeGreaterThan(
        Date.parse(company.updatedAt),
      );

      await expect(
        harness.workspaceService.mutateCompanyIntelligence({
          companyId: company.id,
          expectedUpdatedAt: company.updatedAt,
          mutation: { type: "remove_note", noteId: "same_millisecond_note" },
        }),
      ).rejects.toThrow(/changed since you opened/i);
    } finally {
      vi.useRealTimers();
    }
  });

  test("company preference and merge review never affect final-submit authority", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const initial = await withReconciledCompanies(harness);
    const company = initial.intelligence.companies.find((entry) =>
      entry.jobIds.includes("job_generating"),
    )!;

    const withPreference = await workspaceService.setCompanyPreference({
      companyId: company.id,
      preference: "prefer",
    });
    const preferred = withPreference.intelligence.companies.find(
      (entry) => entry.id === company.id,
    )!;
    expect(preferred.preference).toBe("prefer");
    expect(preferred.preferenceReason).toBeNull();

    const withCandidate = initial;
    const primary = withCandidate.intelligence.companies.find(
      (entry) => entry.id === company.id,
    )!;
    const pending = primary.mergeReviewCandidates.find(
      (candidate) => candidate.decision === "pending",
    );
    if (pending) {
      const rejected = await workspaceService.reviewCompanyMerge({
        companyId: primary.id,
        candidateId: pending.candidateCompanyId,
        decision: "rejected",
      });
      const after = rejected.intelligence.companies.find(
        (entry) => entry.id === primary.id,
      )!;
      const decided = after.mergeReviewCandidates.find(
        (candidate) =>
          candidate.candidateCompanyId === pending.candidateCompanyId,
      )!;
      expect(decided.decision).toBe("rejected");
      expect(decided.decidedAt).not.toBeNull();
    }

    // No application run, attempt, receipt, or submission evidence was ever
    // created by any company operation.
    const final = await workspaceService.getWorkspaceSnapshot();
    expect(final.applyRuns).toHaveLength(0);
    expect(final.applicationAttempts).toHaveLength(0);
    expect(final.applyJobResults).toHaveLength(0);
    expect(
      final.intelligence.companies.some(
        (entry) => entry.preference === "prefer",
      ),
    ).toBe(true);
  });

  test("persists an explicitly selected sibling application and does not write for a missing record", async () => {
    const harness = createWorkspaceServiceHarness();
    for (const id of ["application_first", "application_selected"]) {
      await harness.repository.upsertApplicationRecord(
        ApplicationRecordSchema.parse({
          id,
          jobId: "job_ready",
          title: "Senior Software Engineer",
          company: "Signal Systems",
          status: "submitted",
          lastActionLabel: "Submitted",
          nextActionLabel: null,
          lastUpdatedAt: "2026-08-15T10:00:00.000Z",
        }),
      );
    }
    const initial = await withReconciledCompanies(harness);
    const company = initial.intelligence.companies.find((entry) =>
      entry.jobIds.includes("job_ready"),
    )!;
    const evidence = {
      id: "evidence_exact_offer",
      kind: "offer" as const,
      summary: "Exact application offer",
      currency: "USD",
      minimum: 200000,
      maximum: 200000,
      period: "year" as const,
      offerStatus: "active" as const,
      jobId: "job_ready",
      applicationRecordId: "application_selected",
      source: "manual",
      recordedAt: "2026-08-15T10:10:00.000Z",
      createdAt: "2026-08-15T10:10:00.000Z",
      updatedAt: "2026-08-15T10:10:00.000Z",
    };
    const saved = await harness.workspaceService.mutateCompanyIntelligence({
      companyId: company.id,
      expectedUpdatedAt: company.updatedAt,
      mutation: { type: "upsert_salary_offer_evidence", evidence },
    });
    const savedCompany = saved.intelligence.companies.find(
      (entry) => entry.id === company.id,
    )!;
    expect(savedCompany.salaryOfferEvidence[0]?.applicationRecordId).toBe(
      "application_selected",
    );

    const stateBeforeFailure = await harness.repository.getIntelligenceState();
    await expect(
      harness.workspaceService.mutateCompanyIntelligence({
        companyId: company.id,
        expectedUpdatedAt: savedCompany.updatedAt,
        mutation: {
          type: "upsert_salary_offer_evidence",
          evidence: { ...evidence, applicationRecordId: "application_deleted" },
        },
      }),
    ).rejects.toThrow(/does not exist/i);
    expect(await harness.repository.getIntelligenceState()).toEqual(
      stateBeforeFailure,
    );
  });
});
