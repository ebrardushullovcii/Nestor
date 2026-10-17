// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApplicationPrivacyReceipt } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationsDetailPanelPrivacyReceiptSection } from "./applications-detail-panel-privacy-receipt-section";

afterEach(cleanup);

describe("ApplicationsDetailPanelPrivacyReceiptSection", () => {
  it("requires a second explicit confirmation before recording employer-site verification", () => {
    const onResolveOutcome = vi.fn(() => Promise.resolve());
    render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={vi.fn()}
        onResolveOutcome={onResolveOutcome}
        receipt={{
          schemaVersion: 1,
          generatedAt: "2026-08-28T10:00:00.000Z",
          lineage: {
            applicationRecordId: "application-uncertain",
            runId: "run-uncertain",
            jobId: "job-uncertain",
            resultId: "result-uncertain",
          },
          destination: {
            origin: "https://jobs.example.com",
            safePath: "/apply",
          },
          resume: {
            source: "original_upload",
            sourceDocumentId: "resume-uncertain",
            exportArtifactId: null,
            fileName: "Resume.pdf",
            sha256: null,
          },
          stayedLocal: [],
          modelUse: [],
          externalWrites: [],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: true,
          finalSubmitOccurred: false,
          submissionOutcome: {
            id: "outcome-uncertain",
            preflightId: "preflight-uncertain",
            idempotencyKey: "idempotency-uncertain",
            authorityEnvelopeId: "authority-uncertain",
            authorityRevision: 1,
            runId: "run-uncertain",
            jobId: "job-uncertain",
            resultId: "result-uncertain",
            applicationRecordId: "application-uncertain",
            outcome: "outcome_uncertain",
            attemptedAt: "2026-08-28T10:00:00.000Z",
            verifiedAt: null,
            evidence: [],
            retry: {
              eligible: false,
              blockReason: "outcome_uncertain",
            },
          },
        }}
      />,
    );

    expect(screen.getByRole("alert").textContent).toMatch(
      /Submission outcome is uncertain.*Verify this application.*automatic retry is blocked/i,
    );
    expect(
      screen.getByRole("region", { name: "Verify submission outcome" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "I verified it was submitted" }),
    );
    expect(onResolveOutcome).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm verification" }),
    );
    expect(onResolveOutcome).toHaveBeenCalledWith(
      "outcome-uncertain",
      "submitted",
    );
  });

  it("shows the exact destination, CV, data handling, writes, and safety boundary", () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={onExport}
        receipt={{
          schemaVersion: 1,
          generatedAt: "2026-07-30T10:00:00.000Z",
          lineage: {
            applicationRecordId: "application-1",
            runId: "run-1",
            jobId: "job-1",
            resultId: "result-1",
          },
          destination: {
            origin: "https://boards.greenhouse.io/",
            safePath: "/example/jobs/123",
          },
          resume: {
            source: "original_upload",
            sourceDocumentId: "document-1",
            exportArtifactId: null,
            fileName: "Robin-CV.pdf",
            sha256: null,
          },
          stayedLocal: ["job_listing_data", "browser_evidence"],
          modelUse: [
            {
              purpose: "application_answering",
              transport: "external_model",
              providerLabel: "Example AI",
              modelLabel: "Example model",
              dataCategories: ["profile_data", "application_answers"],
              occurredAt: "2026-07-30T10:00:00.000Z",
            },
          ],
          externalWrites: [
            {
              category: "application_answer",
              fieldLabel: "Skills",
              occurredAt: "2026-07-30T10:00:00.000Z",
              artifactRefId: null,
              verified: true,
            },
            {
              category: "application_answer",
              fieldLabel: "Skills",
              occurredAt: "2026-07-30T10:00:00.000Z",
              artifactRefId: null,
              verified: true,
            },
            {
              category: "resume_attachment",
              fieldLabel: "Resume",
              occurredAt: "2026-07-30T10:00:00.000Z",
              artifactRefId: null,
              verified: true,
            },
          ],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: false,
          finalSubmitOccurred: false,
          submissionOutcome: null,
        }}
      />,
    );

    expect(screen.getByText("What Job Finder prepared")).not.toBeNull();
    expect(screen.queryByText("Earlier preparation record")).toBeNull();

    fireEvent.click(screen.getByText("Show details"));
    // The summary names the exact file recorded in the form.
    expect(
      screen.getByText(
        "https://boards.greenhouse.io/example/jobs/123 · Resume: Robin-CV.pdf (PDF)",
      ),
    ).not.toBeNull();
    expect(screen.getByText("Robin-CV.pdf")).not.toBeNull();
    expect(
      screen.getByText(/contains personal application answers/i),
    ).not.toBeNull();
    expect(screen.getByText("Stored on this device")).not.toBeNull();
    expect(screen.getByText("Sent to a model")).not.toBeNull();
    expect(screen.queryByText("Stayed local")).toBeNull();
    expect(
      screen.getByText(
        /Profile Data, Application Answers for Application Answering via Example AI/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Written to the site")).not.toBeNull();
    expect(screen.getByText("Skills, Resume")).not.toBeNull();
    expect(screen.queryByText("Skills, Skills, Resume")).toBeNull();
    expect(screen.getByText("The resume that was used")).not.toBeNull();
    expect(
      screen.getByText(
        /No file fingerprint was recorded for this preparation/i,
      ),
    ).not.toBeNull();
    expect(screen.getByText("Safety record")).not.toBeNull();
    expect(screen.getByText(/Final submit stayed disabled/)).not.toBeNull();
    expect(
      screen.getByText(/No final-submit action was recorded/),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /This record shows what Job Finder stored for this application/i,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /A submission is confirmed only when the employer site reports receipt/i,
      ),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Download preparation record" }),
    );
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("disables packet export with a plain-language reason when exact application-record lineage is missing", () => {
    const onExport = vi.fn().mockResolvedValue(undefined);
    render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={onExport}
        receipt={{
          schemaVersion: 1,
          generatedAt: "2026-07-30T10:00:00.000Z",
          lineage: {
            runId: "run-1",
            jobId: "job-1",
            resultId: "result-1",
            applicationRecordId: null,
          },
          destination: { origin: "https://example.com", safePath: "/apply" },
          resume: {
            source: "original_upload",
            sourceDocumentId: "document-1",
            exportArtifactId: null,
            fileName: "Robin-CV.pdf",
            sha256: null,
          },
          stayedLocal: [],
          modelUse: [],
          externalWrites: [],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: false,
          finalSubmitOccurred: false,
          submissionOutcome: null,
        }}
      />,
    );

    fireEvent.click(screen.getByText("Show details"));

    const exportButton = screen.getByRole("button", {
      name: "Download preparation record",
    });
    if (!(exportButton instanceof HTMLButtonElement)) {
      throw new Error("Export packet control should be a real button element");
    }
    expect(exportButton.disabled).toBe(true);
    fireEvent.click(exportButton);
    expect(onExport).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        /This legacy receipt predates exact application-record linking, so Job Finder cannot export its packet/,
      ),
    ).not.toBeNull();
    expect(screen.getByText(/stays visible on this page/)).not.toBeNull();
  });

  it("describes recorded final-submit fields neutrally for a modern lineage-exact receipt", () => {
    render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={vi.fn()}
        receipt={{
          schemaVersion: 1,
          generatedAt: "2026-07-30T10:00:00.000Z",
          lineage: {
            runId: "run-1",
            jobId: "job-1",
            resultId: "result-1",
            applicationRecordId: "application-1",
          },
          destination: { origin: "https://example.com", safePath: "/apply" },
          resume: {
            source: "tailored_export",
            sourceDocumentId: null,
            exportArtifactId: "export-1",
            fileName: "Tailored-CV.pdf",
            sha256: null,
          },
          stayedLocal: [],
          modelUse: [],
          externalWrites: [],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: true,
          finalSubmitOccurred: true,
          submissionOutcome: null,
        }}
      />,
    );

    fireEvent.click(screen.getByText("Show details"));

    expect(
      screen.getByText(
        /This receipt records a final-submit action for this run/,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(/employer-site outcome above is the record/),
    ).not.toBeNull();
    expect(document.body.textContent ?? "").toMatch(
      /This receipt records a final-submit action\. The employer-site confirmation determines whether the application was sent/i,
    );
  });

  it("describes observed preparation writes without claiming submission", () => {
    render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={vi.fn()}
        receipt={{
          schemaVersion: 1,
          generatedAt: "2026-07-30T10:00:00.000Z",
          lineage: {
            runId: "run-1",
            jobId: "job-1",
            resultId: "result-1",
            applicationRecordId: "application-1",
          },
          destination: { origin: "https://example.com", safePath: "/apply" },
          resume: {
            source: "original_upload",
            sourceDocumentId: "document-1",
            exportArtifactId: null,
            fileName: "Robin-CV.pdf",
            sha256: null,
          },
          stayedLocal: [],
          modelUse: [],
          externalWrites: [
            {
              category: "resume_attachment",
              fieldLabel: "Resume",
              occurredAt: "2026-07-30T10:00:00.000Z",
              artifactRefId: null,
              verified: true,
            },
          ],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: false,
          finalSubmitOccurred: false,
          submissionOutcome: null,
        }}
      />,
    );

    expect(
      screen.getByText(/Preparation writes Job Finder observed/),
    ).not.toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/do not confirm how the site stored the data/);
    expect(text).not.toMatch(/application (?:was|has been) submitted/i);
  });

  it("shows a shortened fingerprint while preserving the full digest as its accessible label", () => {
    const sha256 = "0123456789abcdef".repeat(4);
    render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={vi.fn()}
        receipt={{
          schemaVersion: 1,
          generatedAt: "2026-07-30T10:00:00.000Z",
          lineage: {
            runId: "run-1",
            jobId: "job-1",
            resultId: "result-1",
            applicationRecordId: "application-1",
          },
          destination: { origin: "https://example.com", safePath: "/apply" },
          resume: {
            source: "tailored_export",
            sourceDocumentId: null,
            exportArtifactId: "export-1",
            fileName: "Tailored-CV.pdf",
            sha256,
          },
          stayedLocal: [],
          modelUse: [],
          externalWrites: [],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: false,
          finalSubmitOccurred: false,
          submissionOutcome: null,
        }}
      />,
    );

    expect(screen.getByText("The resume that was used")).not.toBeNull();
    expect(
      screen.getByText("Fingerprint 0123456789ab…456789abcdef"),
    ).not.toBeNull();
    expect(
      screen.getByLabelText(`Resume file fingerprint ${sha256}`),
    ).not.toBeNull();
    expect(screen.getByText(/exact PDF you approved/i)).not.toBeNull();
  });

  it("names the original file by what it actually is, not as a PDF", () => {
    const sha256 = "abcdef0123456789".repeat(4);
    render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={vi.fn()}
        receipt={{
          schemaVersion: 1,
          generatedAt: "2026-07-30T10:00:00.000Z",
          lineage: {
            runId: "run-1",
            jobId: "job-1",
            resultId: "result-1",
            applicationRecordId: "application-1",
          },
          destination: { origin: "https://example.com", safePath: "/apply" },
          resume: {
            source: "original_upload",
            sourceDocumentId: "document-1",
            exportArtifactId: null,
            fileName: "Robin-CV.txt",
            sha256,
          },
          stayedLocal: [],
          modelUse: [],
          externalWrites: [],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: false,
          finalSubmitOccurred: false,
          submissionOutcome: null,
        }}
      />,
    );

    // The one screen whose job is proving nothing was altered must not
    // misname the file it is vouching for.
    const text = document.body.textContent ?? "";
    expect(text).toContain("Resume: Robin-CV.txt (text file)");
    expect(text).toContain(
      "This is a plain-text copy of your original, unchanged.",
    );
    expect(text).not.toMatch(/PDF/);
  });

  it("does not render a receipt before one exists", () => {
    const { container } = render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={vi.fn()}
        receipt={null}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("keeps legacy wording exclusive to receipts without exact application-record lineage", () => {
    const baseReceipt: ApplicationPrivacyReceipt = {
      schemaVersion: 1,
      generatedAt: "2026-07-30T10:00:00.000Z",
      lineage: {
        runId: "run-1",
        jobId: "job-1",
        resultId: "result-1",
        applicationRecordId: null,
      },
      destination: { origin: "https://example.com", safePath: "/apply" },
      resume: {
        source: "tailored_export",
        sourceDocumentId: null,
        exportArtifactId: "export-1",
        fileName: "Tailored-CV.pdf",
        sha256: null,
      },
      stayedLocal: [],
      modelUse: [],
      externalWrites: [],
      accountCreationAuthorized: false,
      finalSubmitAuthorized: false,
      finalSubmitOccurred: false,
      submissionOutcome: null,
    };

    const modern = render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={vi.fn()}
        receipt={{
          ...baseReceipt,
          lineage: { ...baseReceipt.lineage, applicationRecordId: "app-1" },
        }}
      />,
    );
    const modernText = modern.container.textContent ?? "";
    expect(modernText).not.toMatch(/legacy/i);
    expect(screen.getByText("What Job Finder prepared")).not.toBeNull();
    modern.unmount();

    render(
      <ApplicationsDetailPanelPrivacyReceiptSection
        onExport={vi.fn()}
        receipt={{
          ...baseReceipt,
          lineage: { ...baseReceipt.lineage, applicationRecordId: null },
        }}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Earlier preparation record/);
    expect(text).toMatch(
      /This legacy receipt predates exact application-record linking/,
    );
    expect(text).toMatch(/Legacy data marked final submit as disabled/);
  });
});
