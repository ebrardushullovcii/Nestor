import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  ApplicationAuthorityEnvelopeMutationResultSchema,
  ApplicationAuthorityReadinessSchema,
  ApproveCurrentApplicationAnswersInputSchema,
  ApproveCurrentApplicationAnswersResultSchema,
  CreateApplicationAuthorityEnvelopeInputSchema,
  GetApplicationAuthorityReadinessInputSchema,
  GetApplicationAuthorityEnvelopeInputSchema,
  GetApplicationAuthorityEnvelopeResultSchema,
  ListApplicationAuthorityEnvelopesInputSchema,
  ListApplicationAuthorityEnvelopesResultSchema,
  RevokeApplicationAuthorityEnvelopeInputSchema,
  ResolveSubmissionOutcomeInputSchema,
  ResolveSubmissionOutcomeResultSchema,
  UpdateApplicationAuthorityEnvelopeInputSchema,
} from "@nestor/contracts";

import {
  getJobFinderApplicationAuthorityService,
  type JobFinderApplicationAuthorityService,
} from "../services/job-finder";

export interface JobFinderAuthorityRouteDependencies {
  service: JobFinderApplicationAuthorityService;
}

/**
 * Main-process-only authority management boundary. It exposes inspect,
 * prepare-only create/update, and revocation; no preflight, arm, or submit
 * operation is registered here.
 */
export function createJobFinderAuthorityOperations(
  dependencies: JobFinderAuthorityRouteDependencies = {
    service: getJobFinderApplicationAuthorityService(),
  },
) {
  const operations = new Map<string, (event: IpcMainInvokeEvent | null, input: unknown) => Promise<unknown>>();
  const add = (name: string, operation: (event: IpcMainInvokeEvent | null, input: unknown) => Promise<unknown>) => operations.set(name, operation);
  add(
    "job-finder:get-application-authority-readiness",
    async (_event, payload: unknown) => {
      GetApplicationAuthorityReadinessInputSchema.parse(
        payload === undefined ? {} : payload,
      );
      return ApplicationAuthorityReadinessSchema.parse(
        await dependencies.service.getReadiness(),
      );
    },
  );

  add(
    "job-finder:approve-current-application-answers",
    async (_event, payload: unknown) => {
      const input = ApproveCurrentApplicationAnswersInputSchema.parse(payload);
      return ApproveCurrentApplicationAnswersResultSchema.parse(
        await dependencies.service.approveCurrentAnswers(input),
      );
    },
  );

  add(
    "job-finder:list-application-authority-envelopes",
    async (_event, payload: unknown) => {
      const input = ListApplicationAuthorityEnvelopesInputSchema.parse(
        payload === undefined ? {} : payload,
      );
      const result = await dependencies.service.list(input);
      return ListApplicationAuthorityEnvelopesResultSchema.parse(result);
    },
  );

  add(
    "job-finder:get-application-authority-envelope",
    async (_event, payload: unknown) => {
      const input = GetApplicationAuthorityEnvelopeInputSchema.parse(payload);
      const result = await dependencies.service.get(input);
      return GetApplicationAuthorityEnvelopeResultSchema.parse(result);
    },
  );

  add(
    "job-finder:create-application-authority-envelope",
    async (_event, payload: unknown) => {
      const input =
        CreateApplicationAuthorityEnvelopeInputSchema.parse(payload);
      const result = await dependencies.service.create(input);
      return ApplicationAuthorityEnvelopeMutationResultSchema.parse(result);
    },
  );

  add(
    "job-finder:update-application-authority-envelope",
    async (_event, payload: unknown) => {
      const input =
        UpdateApplicationAuthorityEnvelopeInputSchema.parse(payload);
      const result = await dependencies.service.update(input);
      return ApplicationAuthorityEnvelopeMutationResultSchema.parse(result);
    },
  );

  add(
    "job-finder:revoke-application-authority-envelope",
    async (_event, payload: unknown) => {
      const input =
        RevokeApplicationAuthorityEnvelopeInputSchema.parse(payload);
      const result = await dependencies.service.revoke(input);
      return ApplicationAuthorityEnvelopeMutationResultSchema.parse(result);
    },
  );

  add(
    "job-finder:resolve-submission-outcome",
    async (_event, payload: unknown) => {
      const input = ResolveSubmissionOutcomeInputSchema.parse(payload);
      const result = await dependencies.service.resolveSubmissionOutcome(input);
      return ResolveSubmissionOutcomeResultSchema.parse(result);
    },
  );
  return operations;
}

export function registerJobFinderAuthorityRouteHandlers(ipcMain: IpcMain, dependencies?: JobFinderAuthorityRouteDependencies): void {
  for (const [name, operation] of createJobFinderAuthorityOperations(dependencies)) {
    ipcMain.handle(name, (event, input: unknown) => operation(event, input));
  }
}
export async function executeAuthorityAction(id: string, input: unknown) {
  const operation = createJobFinderAuthorityOperations().get(`job-finder:${id}`);
  if (!operation) throw new Error("Unknown application authority action.");
  return operation(null, input);
}
