import { parentPort } from "node:worker_threads";
import type {
  ResumeComputationRequest,
  ResumeComputationResponse,
} from "@nestor/contracts";
import { ResumeDraftSchema } from "@nestor/contracts";
import { renderResumeTemplateHtml } from "../../shared/job-finder-resume-renderer";
import {
  sanitizeResumeDraft,
  validateResumeDraft,
  buildResumeDraftStateHash,
  buildResumeDraftRevision,
} from "@nestor/job-finder/resume-computation";

parentPort?.on("message", (request: ResumeComputationRequest) => {
  let response: ResumeComputationResponse;
  try {
    switch (request.kind) {
      case "render":
        response = {
          id: request.id,
          kind: request.kind,
          result: {
            previewHtml: renderResumeTemplateHtml(request.input, {
              mode: "preview",
            }),
            exportHtml: renderResumeTemplateHtml(request.input),
          },
        };
        break;
      case "parse":
        response = {
          id: request.id,
          kind: request.kind,
          result: ResumeDraftSchema.parse(request.input),
        };
        break;
      case "sanitize":
        response = {
          id: request.id,
          kind: request.kind,
          result: sanitizeResumeDraft(request.input),
        };
        break;
      case "validate":
        response = {
          id: request.id,
          kind: request.kind,
          result: validateResumeDraft(request.input),
        };
        break;
      case "stateHash":
        response = {
          id: request.id,
          kind: request.kind,
          result: buildResumeDraftStateHash(request.input),
        };
        break;
      case "revision":
        response = {
          id: request.id,
          kind: request.kind,
          result: buildResumeDraftRevision(request.input),
        };
        break;
    }
  } catch (error) {
    response = {
      id: request.id,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  parentPort!.postMessage(response);
});
