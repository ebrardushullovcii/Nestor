import {
  AiBehaviorPreferenceSchema,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import {
  createApplicationService,
  type ApplicationService,
  type ApplicationServiceDeps,
} from "@nestor/job-finder/applications";
import { withApplicationAuthorityGate, recordApplicationAuthoritySuccessor } from "@nestor/job-finder";

import { getJobStore } from "./job-store";
import { getApplicationStore } from "./job-finder/application-store";
import { createJobFinderApplicationAuthorityService } from "./job-finder/application-authority-service";
import { getCandidateAssetLibrary } from "./job-finder/candidate-asset-library-instance";

let service: ApplicationService | null = null;
let ready: Promise<ApplicationService> | null = null;
let resolveReady: ((service: ApplicationService) => void) | null = null;

export async function startApplicationService(deps: Pick<ApplicationServiceDeps,
  "browser" | "aiClient" | "documentManager" | "isHoldingCurrent"> & {
  repository: JobFinderRepository;
}): Promise<ApplicationService> {
  service?.stop();
  const { repository } = deps;
  const applications = getApplicationStore();
  const authority = createJobFinderApplicationAuthorityService({ repository });
  const instructionMode: NonNullable<ApplicationServiceDeps["instructionMode"]> = async input => {
    const { assistantApplicationMode } = await import("./assistant/assistant-service");
    return assistantApplicationMode(input);
  };

  const authorizeSending: ApplicationServiceDeps["authorizeSending"] = async input => withApplicationAuthorityGate(repository, input.signal, async () => {
    for (let retry = 0; retry < 5; retry += 1) {
      input.signal.throwIfAborted();
      const { revision } = await repository.getProfileWithRevision();
      const approval = await authority.approveCurrentAnswers({ expectedProfileRevision: revision, confirmedCurrentAnswers: true });
      if (approval.status === "stale") continue;
      if (approval.status !== "created" && approval.status !== "duplicate") throw new Error("Your current profile could not be checked before applying. Try Apply again.");
      const settings = await repository.getSettings();
      const instruction = applications.instructionFor(input.application.id);
      if (!input.personClicked && (instruction
        ? await instructionMode({ ...instruction, jobId: input.job.id }) !== "autonomous_submit"
        : settings.applicationAutomationMode !== "autonomous_submit")) return null;
      const active = (await authority.list({ status: "active" })).at(0) ?? null;
      // The active permission contains only running work, never every job in storage.
      const running = [...applications.listWorkInState("running"), ...applications.listWorkInState("submitting")];
      const scoped = running.filter(row => row.mode === "autonomous_submit").flatMap(row => {
        const artifact = applications.getResumeArtifact(row.id);
        const job = getJobStore().getJob(row.jobId);
        return artifact?.sha256 && job ? [{ id: String(job.id), digest: artifact.sha256, origins: [new URL(job.applyUrl ?? job.url).origin, new URL(job.url).origin] }] : [];
      });
      const policy = {
        mode: "autonomous_submit" as const,
        scope: { campaignId: null, jobIds: [...new Set([String(input.job.id), ...scoped.map(item => item.id)])] },
        maxApplicationsPerRun: 1,
        intermediateMutationsAuthorized: true,
        preApprovedAttestationKinds: AiBehaviorPreferenceSchema.parse(settings.aiBehavior ?? {}).applying.preApprovedDeclarations,
        salaryDisclosure: settings.salaryDisclosure ?? "pause_for_user",
        allowedResumeSha256: [...new Set([input.artifact.sha256!, ...scoped.map(item => item.digest)])],
        allowedOrigins: [...new Set([new URL(input.job.applyUrl ?? input.job.url).origin, new URL(input.job.url).origin, ...scoped.flatMap(item => item.origins),
          // Reviewed ATS origins remain available to another in-flight form.
          ...applications.originsForApplications(running.map(row => row.id)),
        ])],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      };
      if (active) {
        if (active.mode !== "autonomous_submit") {
          const revoked = await authority.revoke({ id: active.id, expectedRevision: active.revision });
          if (revoked.status !== "applied") continue;
        } else {
          const update = { ...policy, id: active.id, expectedRevision: active.revision };
          const changed = await authority.update(update);
          if (changed.status === "applied") return changed.envelope;
          if (changed.status === "stale" && changed.current?.revision === active.revision) {
            const replaced = await authority.replaceUsed(update);
            if (replaced.status === "applied") { recordApplicationAuthoritySuccessor(repository, active.id, replaced.envelope.id); return replaced.envelope; }
          }
          continue;
        }
      }
      const created = await authority.create(policy);
      if (created.status === "applied") return created.envelope;
    }
    throw new Error("The application permission changed while Apply was starting. Try again.");
  });

  service = createApplicationService({
    ...deps,
    jobs: getJobStore(), applications, authorityRepository: repository, candidateAssets: getCandidateAssetLibrary(),
    readInputs: async () => {
      const [profile, settings, searchPreferences] = await Promise.all([
        repository.getProfile(), repository.getSettings(), repository.getSearchPreferences(),
      ]);
      return { profile, settings, searchPreferences };
    },
    isPaused: async () => (await repository.getActivityControl()).paused,
    authorizeSending,
    instructionMode,
  });
  await service.start();
  resolveReady?.(service);
  resolveReady = null;
  ready = Promise.resolve(service);
  return service;
}

export function getApplicationService(): Promise<ApplicationService> {
  ready ??= new Promise(resolve => { resolveReady = resolve; });
  return ready;
}

export function stopApplicationService(): void {
  service?.stop(); service = null; ready = null;
}

