import type { ApplyDocument, ApplyLetterProvider } from "@nestor/browser-agent";
import type { CoverLetterPreference } from "@nestor/contracts";

/**
 * The application documents one application sends.
 *
 * Each purpose and set of instructions creates one stable version. Asking for
 * that same version as text or a file returns the same words, while a revision
 * or a different purpose remains a distinct document.
 *
 * The letter is rendered by whoever owns document rendering, and stored beside
 * the resume that went with it, as the exact bytes that were sent.
 */

export interface ApplicationLetterRenderRequest {
  text: string;
  /** The type the form insisted on, or null when it did not care. */
  fileType: "pdf" | "docx" | "txt" | null;
  jobId: string;
  applicationId: string;
}

export type ApplicationLetterRenderResult =
  | {
      ok: true;
      fileName: string;
      mimeType: string;
      /** The exact bytes that go to the employer and into the library. */
      loadBytes: () => Promise<Uint8Array>;
    }
  | { ok: false; reason: string };

export interface ApplicationLetterDependencies {
  /** Writes the letter. Returns null when no model is available. */
  writeLetter: (input: {
    prompt: string;
    purpose: "cover_letter" | "motivation_letter" | "supporting_statement";
    groundedIn: string[];
    language: string | null;
    preference: CoverLetterPreference;
    priorText: string | null;
    signal?: AbortSignal;
  }) => Promise<string | null>;
  /**
   * Renders the letter to a file and stores it beside the resume. Omitted when
   * this run has no way to render one, in which case a form that wants a file
   * pauses for the person.
   */
  renderLetter?: (
    input: ApplicationLetterRenderRequest,
  ) => Promise<ApplicationLetterRenderResult>;
  getApprovedText?: (
    jobId: string,
    applicationRecordId?: string,
  ) => Promise<string | null>;
  preference: CoverLetterPreference;
  application: { jobId: string; applicationId: string };
  signal?: AbortSignal;
}

export class ApplicationLetterGroundingError extends Error {
  constructor(
    reason: string,
    readonly draftText: string,
  ) {
    super(`The letter needs your review: ${reason}`);
    this.name = "ApplicationLetterGroundingError";
  }
}

export function createApplicationLetterProvider(
  dependencies: ApplicationLetterDependencies,
): ApplyLetterProvider {
  type WrittenVersion = {
    purpose: NonNullable<
      Parameters<ApplyLetterProvider["provide"]>[0]["purpose"]
    >;
    version: number;
    text: string;
    renderedByType: Map<string, ApplyDocument>;
  };
  const versionsByRequest = new Map<string, WrittenVersion>();
  const versionCounts = new Map<WrittenVersion["purpose"], number>();
  const latestByPurpose = new Map<WrittenVersion["purpose"], WrittenVersion>();

  return {
    preference: dependencies.preference,
    provide: async (request) => {
      const signal =
        request.signal && dependencies.signal
          ? AbortSignal.any([request.signal, dependencies.signal])
          : (request.signal ?? dependencies.signal);
      signal?.throwIfAborted();
      const purpose = request.purpose ?? "cover_letter";
      const requestKey = `${purpose}\n${request.prompt.trim()}\n${request.approvedText ?? ""}`;
      let writtenVersion = versionsByRequest.get(requestKey) ?? null;
      if (!writtenVersion) {
        let written: string | null;
        try {
          written =
            request.approvedText ??
            (await dependencies.writeLetter({
              prompt: request.prompt,
              purpose,
              groundedIn: request.groundedIn,
              language: request.language,
              preference: dependencies.preference,
              priorText: latestByPurpose.get(purpose)?.text ?? null,
              ...(signal ? { signal } : {}),
            }));
          signal?.throwIfAborted();
        } catch (error) {
          if (error instanceof ApplicationLetterGroundingError) {
            return {
              ok: false,
              reason: error.message,
              draftText: error.draftText,
            };
          }
          return {
            ok: false,
            reason:
              "Job Finder could not write this draft right now. Try again.",
          };
        }
        if (!written?.trim()) {
          return {
            ok: false,
            reason:
              "Its assistant is unavailable right now, so nothing was attached. Try this application again shortly.",
          };
        }
        const version = (versionCounts.get(purpose) ?? 0) + 1;
        versionCounts.set(purpose, version);
        writtenVersion = {
          purpose,
          version,
          text: request.approvedText ?? written.trim(),
          renderedByType: new Map(),
        };
        versionsByRequest.set(requestKey, writtenVersion);
        latestByPurpose.set(purpose, writtenVersion);
      }

      signal?.throwIfAborted();
      if (request.delivery === "text") {
        return { ok: true, text: writtenVersion.text, document: null };
      }

      const typeKey = request.fileType ?? "any";
      const alreadyRendered = writtenVersion.renderedByType.get(typeKey);
      if (alreadyRendered) {
        return {
          ok: true,
          text: writtenVersion.text,
          document: alreadyRendered,
        };
      }

      if (!dependencies.renderLetter) {
        return { ok: true, text: writtenVersion.text, document: null };
      }

      const rendered = await dependencies.renderLetter({
        text: writtenVersion.text,
        fileType: request.fileType,
        jobId: dependencies.application.jobId,
        applicationId: dependencies.application.applicationId,
      });
      if (!rendered.ok) {
        return { ok: true, text: writtenVersion.text, document: null };
      }

      const purposeLabel = writtenVersion.purpose.replace(/_/gu, " ");
      const document: ApplyDocument = {
        id: `document_${writtenVersion.purpose}_${dependencies.application.jobId}_v${writtenVersion.version}_${typeKey}`,
        fileName: rendered.fileName,
        mimeType: rendered.mimeType,
        // A version number counts letters written in this run; the letter
        // the person approved is named as theirs, never "v1" again.
        label: `${purposeLabel.charAt(0).toUpperCase()}${purposeLabel.slice(1)}${
          request.approvedText !== undefined
            ? " you approved"
            : ` v${writtenVersion.version}`
        }`,
        kind: "cover_letter",
        loadBytes: rendered.loadBytes,
      };
      writtenVersion.renderedByType.set(typeKey, document);
      return { ok: true, text: writtenVersion.text, document };
    },
  };
}
