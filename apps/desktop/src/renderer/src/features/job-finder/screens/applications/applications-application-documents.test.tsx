// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ApplicationDocumentRevisionSchema,
  ApplicationRecordSchema,
  ApplyRunDetailsSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationsApplicationDocuments } from "./applications-application-documents";

const applicationRecord = ApplicationRecordSchema.parse({
  id: "application_1",
  jobId: "job_1",
  title: "Platform Engineer",
  company: "Acme",
  status: "drafting",
  lastActionLabel: "Prepared application",
  nextActionLabel: "Review",
  lastUpdatedAt: "2026-08-10T10:00:00.000Z",
});

const proposed = ApplicationDocumentRevisionSchema.parse({
  id: "document_1",
  revision: 1,
  kind: "cover_letter",
  status: "proposed",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
  job: {
    jobId: "job_1",
    applicationRecordId: "application_1",
    sourceJobId: "source_job_1",
    canonicalUrl: "https://example.com/jobs/1",
    title: "Platform Engineer",
    company: "Acme",
    jobDigest: "a".repeat(64),
  },
  question: null,
  content: "Dear Hiring Team,\n\nApproved profile evidence.",
  evidence: [
    {
      id: "profile.summary",
      source: "profile_summary",
      label: "Approved profile summary",
      text: "Approved profile evidence.",
    },
  ],
  evidenceDigest: "b".repeat(64),
  approvedAt: null,
  outputAsset: null,
  lastExportedAt: null,
});

describe("ApplicationsApplicationDocuments", () => {
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    document.body.replaceChildren();
    root = null;
    vi.restoreAllMocks();
  });

  it("shows a background letter that arrives after the panel has loaded", async () => {
    const listApplicationDocuments = vi
      .fn()
      .mockResolvedValueOnce({ documents: [] })
      .mockResolvedValue({ documents: [proposed] });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { jobFinder: { listApplicationDocuments } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={null}
          demoteAsSecondary
        />,
      );
      await Promise.resolve();
    });
    const details = ApplyRunDetailsSchema.parse({
      run: {
        id: "synthetic_run",
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: [applicationRecord.jobId],
        currentJobId: applicationRecord.jobId,
        summary: "Waiting for answers",
        detail: "Review the questions",
        createdAt: proposed.createdAt,
        updatedAt: proposed.updatedAt,
      },
      result: {
        id: "synthetic_result",
        runId: "synthetic_run",
        jobId: applicationRecord.jobId,
        applicationRecordId: applicationRecord.id,
        state: "awaiting_review",
        summary: "Letter attached",
        detail: "Waiting for answers",
        startedAt: proposed.createdAt,
        updatedAt: proposed.updatedAt,
        reviewCard: {
          siteLabel: "Synthetic",
          pageUrl: null,
          preparedAt: proposed.createdAt,
          answers: [],
          attachments: [],
          letter: { text: proposed.content, groundedIn: ["Profile summary"] },
          waitingOnYou: ["Sponsorship"],
        },
      },
      questionRecords: [],
    });
    await act(async () => {
      root?.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={details}
          demoteAsSecondary
        />,
      );
      await Promise.resolve();
    });
    expect(listApplicationDocuments).toHaveBeenCalledTimes(2);
    expect(container.querySelector("textarea")?.value).toBe(proposed.content);
  });

  it("lists each document once at its newest revision and opens on the approved letter", async () => {
    const approved = ApplicationDocumentRevisionSchema.parse({
      ...proposed,
      revision: 2,
      status: "approved",
      content: "Dear Hiring Team,\n\nThe letter you approved.",
      approvedAt: "2026-08-10T11:00:00.000Z",
      updatedAt: "2026-08-10T11:00:00.000Z",
    });
    const otherDraft = ApplicationDocumentRevisionSchema.parse({
      ...proposed,
      id: "document_2",
    });
    const listApplicationDocuments = vi
      .fn()
      .mockResolvedValue({ documents: [otherDraft, proposed, approved] });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { jobFinder: { listApplicationDocuments } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={null}
          demoteAsSecondary
        />,
      );
      await Promise.resolve();
    });
    const options = [...container.querySelectorAll("option")]
      .map((option) => option.textContent ?? "")
      .filter((text) => text.includes("revision"));
    expect(options).toHaveLength(2);
    const savedDocument = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Saved document"))
      ?.querySelector("select");
    expect(savedDocument?.value).toBe("document_1");
    expect(container.textContent).toContain("The letter you approved.");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("saves a manual edit as a new revision before exact approval", async () => {
    let currentDocument: typeof proposed | null = null;
    const listApplicationDocuments = vi.fn(() =>
      Promise.resolve({
        documents: currentDocument ? [currentDocument] : [],
      }),
    );
    const proposeApplicationDocument = vi.fn(() => {
      currentDocument = proposed;
      return Promise.resolve(proposed);
    });
    const edited = ApplicationDocumentRevisionSchema.parse({
      ...proposed,
      revision: 2,
      content: "User-authored revision.",
      authorship: "user_edited",
      requiresGroundingReview: true,
    });
    const editApplicationDocument = vi.fn(() => {
      currentDocument = edited;
      return Promise.resolve(edited);
    });
    const approveApplicationDocument = vi.fn(() => {
      currentDocument = ApplicationDocumentRevisionSchema.parse({
        ...edited,
        status: "approved",
        approvedAt: "2026-08-10T10:05:00.000Z",
        outputAsset: {
          id: "asset_1",
          kind: "cover_letter",
          originalName: "document_1-r2.txt",
          mime: "text/plain",
          byteSize: 42,
          sha256: "c".repeat(64),
          createdAt: "2026-08-10T10:05:00.000Z",
          sensitivity: "sensitive",
          consentScope: "job_application_attachment",
          retention: "until_deleted",
          deletedAt: null,
          extractedText: null,
        },
      });
      return Promise.resolve(currentDocument);
    });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listApplicationDocuments,
          proposeApplicationDocument,
          editApplicationDocument,
          approveApplicationDocument,
          exportApplicationDocument: vi.fn(),
        },
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={null}
          demoteAsSecondary
        />,
      );
      await Promise.resolve();
    });
    const generate = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Draft a cover letter"),
    ) as HTMLButtonElement;
    await act(async () => {
      generate.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "Read, edit and approve documents for this application",
    );
    expect(document.querySelector("details > summary")).not.toBeNull();
    expect(proposeApplicationDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job_1",
        applicationRecordId: "application_1",
        question: null,
      }),
    );
    expect(document.body.textContent).toContain("Approved profile evidence.");
    expect(document.body.textContent).toContain(
      "Exact job: Platform Engineer at Acme",
    );

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      // React tracks textarea values through the instance setter; use the native
      // setter to exercise the real onChange path in jsdom.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (valueSetter) {
        Reflect.apply(valueSetter, textarea, ["User-authored revision."]);
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const saveEdit = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save edit as new revision"),
    ) as HTMLButtonElement;
    await act(async () => {
      saveEdit.click();
      await Promise.resolve();
    });
    expect(editApplicationDocument).toHaveBeenCalledWith({
      documentId: "document_1",
      expectedRevision: 1,
      content: "User-authored revision.",
    });
    expect(document.body.textContent).toContain("User-authored revision");

    const approve = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Approve",
    ) as HTMLButtonElement;
    await act(async () => {
      approve.click();
      await Promise.resolve();
    });
    expect(approveApplicationDocument).toHaveBeenCalledWith({
      documentId: "document_1",
      expectedRevision: 2,
    });
  });

  it("approves the text on screen, saving unsaved typing first", async () => {
    let currentDocument: typeof proposed | null = null;
    const listApplicationDocuments = vi.fn(() =>
      Promise.resolve({
        documents: currentDocument ? [currentDocument] : [],
      }),
    );
    const proposeApplicationDocument = vi.fn(() => {
      currentDocument = proposed;
      return Promise.resolve(proposed);
    });
    const edited = ApplicationDocumentRevisionSchema.parse({
      ...proposed,
      revision: 2,
      content: "User-authored revision.",
      authorship: "user_edited",
      requiresGroundingReview: true,
    });
    const editApplicationDocument = vi.fn(() => {
      currentDocument = edited;
      return Promise.resolve(edited);
    });
    const approveApplicationDocument = vi.fn(() => {
      currentDocument = ApplicationDocumentRevisionSchema.parse({
        ...edited,
        status: "approved",
        approvedAt: "2026-08-10T10:05:00.000Z",
        outputAsset: {
          id: "asset_1",
          kind: "cover_letter",
          originalName: "document_1-r2.txt",
          mime: "text/plain",
          byteSize: 42,
          sha256: "c".repeat(64),
          createdAt: "2026-08-10T10:05:00.000Z",
          sensitivity: "sensitive",
          consentScope: "job_application_attachment",
          retention: "until_deleted",
          deletedAt: null,
          extractedText: null,
        },
      });
      return Promise.resolve(currentDocument);
    });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listApplicationDocuments,
          proposeApplicationDocument,
          editApplicationDocument,
          approveApplicationDocument,
          exportApplicationDocument: vi.fn(),
        },
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={null}
        />,
      );
      await Promise.resolve();
    });
    const generate = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Draft a cover letter"),
    ) as HTMLButtonElement;
    await act(async () => {
      generate.click();
      await Promise.resolve();
    });

    expect(proposeApplicationDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job_1",
        applicationRecordId: "application_1",
        question: null,
      }),
    );
    expect(document.body.textContent).toContain("Approved profile evidence.");
    expect(document.body.textContent).toContain(
      "Exact job: Platform Engineer at Acme",
    );

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      // React tracks textarea values through the instance setter; use the native
      // setter to exercise the real onChange path in jsdom.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (valueSetter) {
        Reflect.apply(valueSetter, textarea, ["User-authored revision."]);
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const approve = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save and approve",
    ) as HTMLButtonElement;
    await act(async () => {
      approve.click();
      await Promise.resolve();
    });
    expect(editApplicationDocument).toHaveBeenCalledWith({
      documentId: "document_1",
      expectedRevision: 1,
      content: "User-authored revision.",
    });
    expect(approveApplicationDocument).toHaveBeenCalledWith({
      documentId: "document_1",
      expectedRevision: 2,
    });
  });

  it.each(["", "   \n  "])(
    "does not approve an empty editor (%j)",
    async (content) => {
      const approveApplicationDocument = vi.fn();
      const editApplicationDocument = vi.fn();
      Object.defineProperty(window, "nestor", {
        configurable: true,
        value: {
          jobFinder: {
            listApplicationDocuments: vi.fn(() =>
              Promise.resolve({ documents: [proposed] }),
            ),
            approveApplicationDocument,
            editApplicationDocument,
          },
        },
      });
      const container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <ApplicationsApplicationDocuments
            applicationRecord={applicationRecord}
            applyRunDetails={null}
          />,
        );
        await Promise.resolve();
      });
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        Reflect.apply(setter, textarea, [content]);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
      const approve = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Approve",
      )!;
      expect(approve.disabled).toBe(true);
      await act(async () => {
        approve.click();
        await Promise.resolve();
      });
      expect(approveApplicationDocument).not.toHaveBeenCalled();
      expect(editApplicationDocument).not.toHaveBeenCalled();
    },
  );

  it("renders every native field with canonical tokens, focus hierarchy, and preserved geometry", async () => {
    const listApplicationDocuments = vi.fn(() =>
      Promise.resolve({ documents: [proposed] }),
    );
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listApplicationDocuments,
          proposeApplicationDocument: vi.fn(),
          editApplicationDocument: vi.fn(),
          approveApplicationDocument: vi.fn(),
          exportApplicationDocument: vi.fn(),
        },
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={null}
        />,
      );
      await Promise.resolve();
    });

    const selects = [...container.querySelectorAll("select")];
    const textareas = [...container.querySelectorAll("textarea")];
    // Document type + Exact attachment question; the saved-document select only
    // appears with more than one revision.
    expect(selects).toHaveLength(2);
    expect(textareas).toHaveLength(1);

    for (const control of [...selects, ...textareas]) {
      expect(control.className).toContain("border-(--field-border)");
      expect(control.className).toContain("bg-(--field)");
      expect(control.className).toContain("outline-none");
      expect(control.className).toContain(
        "focus-visible:border-(--field-focus-border)",
      );
      expect(control.className).toContain("focus-visible:bg-(--field-strong)");
      expect(control.className).toContain(
        "focus-visible:shadow-[var(--field-focus-shadow)]",
      );
      expect(control.className).not.toContain("border-input");
      expect(control.className).not.toContain("focus-visible:ring");
    }
    for (const select of selects) {
      expect(select.className).toContain("h-11");
      expect(select.className).toContain("rounded-(--radius-field)");
    }
    expect(textareas[0]?.className).toContain("min-h-64");
    expect(textareas[0]?.className).toContain("resize-y");
  });
  it("keeps the approved letter readable below its newer draft", async () => {
    const approved = ApplicationDocumentRevisionSchema.parse({
      ...proposed,
      revision: 2,
      status: "approved",
      approvedAt: proposed.updatedAt,
      content: "The approved letter still used on the form.",
    });
    const newDraft = {
      ...proposed,
      revision: 3,
      content: "A new proposal awaiting approval.",
    };
    const listApplicationDocuments = vi.fn().mockResolvedValue({
      documents: [newDraft],
      approvedRevisions: [approved],
    });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { jobFinder: { listApplicationDocuments } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={null}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "Revision 2 is approved and stays in use until you approve this one.",
    );
    const disclosure = [...container.querySelectorAll("details")].find(
      (details) =>
        details.querySelector("summary")?.textContent ===
        "Read approved revision 2",
    )!;
    expect(disclosure).toBeTruthy();
    disclosure.open = true;
    expect(disclosure.textContent).toContain(approved.content);
    expect(container.querySelector("textarea")?.value).toBe(newDraft.content);
    listApplicationDocuments.mockResolvedValue({
      documents: [
        { ...newDraft, status: "approved", approvedAt: proposed.updatedAt },
      ],
      approvedRevisions: [],
    });
    await act(async () => {
      root?.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={ApplyRunDetailsSchema.parse({
            run: {
              id: "synthetic",
              mode: "copilot",
              state: "paused_for_user_review",
              jobIds: [applicationRecord.jobId],
              summary: "Ready",
              detail: "Read the letter",
              createdAt: proposed.createdAt,
              updatedAt: proposed.updatedAt,
            },
            result: {
              id: "synthetic-result",
              runId: "synthetic",
              jobId: applicationRecord.jobId,
              state: "awaiting_review",
              summary: "Ready",
              detail: "Read the letter",
              startedAt: proposed.createdAt,
              updatedAt: proposed.updatedAt,
              reviewCard: {
                siteLabel: "Synthetic",
                preparedAt: proposed.updatedAt,
                letter: { text: newDraft.content },
              },
            },
          })}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Read approved revision 2");
  });
});

it("shows a review reason without internal copy or IPC prefixes", async () => {
  const draft = ApplicationDocumentRevisionSchema.parse({
    ...proposed,
    requiresGroundingReview: true,
    reviewReason: "Agree how to handle the location mismatch before sending.",
  });
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      jobFinder: {
        listApplicationDocuments: () => Promise.resolve({ documents: [draft] }),
      },
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const mounted = createRoot(container);
  try {
    await act(async () => {
      mounted.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={null}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "Agree how to handle the location mismatch",
    );
    expect(container.textContent).not.toMatch(
      /evidence-linked|grounding checker|while the form waits/,
    );
  } finally {
    await act(async () => {
      mounted.unmount();
      await Promise.resolve();
    });
    container.remove();
  }
});

it("strips the IPC prefix from a document failure", async () => {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      jobFinder: {
        listApplicationDocuments: () =>
          Promise.reject(
            new Error(
              "Error invoking remote method 'job-finder:list-application-documents': ApplicationDocumentLibraryError: Could not load the documents. Try again.",
            ),
          ),
      },
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const mounted = createRoot(container);
  try {
    await act(async () => {
      mounted.render(
        <ApplicationsApplicationDocuments
          applicationRecord={applicationRecord}
          applyRunDetails={null}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "Could not load the documents. Try again.",
    );
    expect(container.textContent).not.toContain("Error invoking remote method");
  } finally {
    await act(async () => {
      mounted.unmount();
      await Promise.resolve();
    });
    container.remove();
  }
});
