import type {
  ApplicationCrmBulkStageMutationInput,
  OutcomeEvent,
  ApplicationCrmCalendarEntry,
  ApplicationCrmData,
  ApplicationCrmDuplicateHint,
  ApplicationCrmExportInput,
  ApplicationCrmExportResult,
  ApplicationCrmMutation,
  ApplicationCrmMutationInput,
  ApplicationCrmRecommendedAction,
  ApplicationCrmSettings,
  ApplicationCrmStage,
  ApplyJobResult,
  ApplyRunSummary,
  ApplicationRecord,
} from "@nestor/contracts";
import type { ApplicationRecordBatchCommitResult } from "@nestor/db";
import {
  projectApplicationRecordsActivity,
  APPLICATION_CRM_STAGE_NAMES,
  inferApplicationActivityStage,
  ApplicationCrmDataSchema,
  ApplicationCrmBulkStageMutationInputSchema,
  ApplicationCrmExportInputSchema,
  ApplicationCrmMutationInputSchema,
  ApplicationCrmSettingsSchema,
  ApplicationRecordSchema,
  resolveApplicationCrmStageSource,
  resolveApplicationCrmTrackedStage,
} from "@nestor/contracts";

export interface ApplicationCrmRepository {
  listApplicationRecords(): Promise<readonly ApplicationRecord[]>;
  upsertApplicationRecord(record: ApplicationRecord): Promise<void>;
}

export interface ApplicationCrmBatchRepository extends ApplicationCrmRepository {
  commitApplicationRecordBatch(input: {
    expectedRevisions: readonly {
      applicationRecordId: string;
      expectedRevision: number;
    }[];
    records: readonly ApplicationRecord[];
  }): Promise<ApplicationRecordBatchCommitResult>;
}

export class ApplicationCrmRevisionConflictError extends Error {
  constructor() {
    super(
      "This application changed after you opened it. Refresh and try again.",
    );
    this.name = "ApplicationCrmRevisionConflictError";
  }
}

export class ApplicationCrmBulkStageValidationError extends Error {
  readonly recordIds: readonly string[];

  constructor(message: string, recordIds: readonly string[]) {
    super(message);
    this.name = "ApplicationCrmBulkStageValidationError";
    this.recordIds = [...recordIds];
  }
}

export class ApplicationCrmBulkStageRevisionConflictError extends ApplicationCrmRevisionConflictError {
  readonly recordIds: readonly string[];

  constructor(recordIds: readonly string[]) {
    super();
    this.message =
      recordIds.length === 1
        ? "That application changed before the bulk stage update could be saved. Refresh and try again."
        : `${recordIds.length} applications changed before the bulk stage update could be saved. Refresh and try again.`;
    this.name = "ApplicationCrmBulkStageRevisionConflictError";
    this.recordIds = [...recordIds];
  }
}

const applicationRecordTransitionTails = new WeakMap<
  object,
  Map<string, Promise<void>>
>();

export async function withApplicationRecordTransition<T>(
  repository: object,
  applicationRecordId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let tails = applicationRecordTransitionTails.get(repository);
  if (!tails) {
    tails = new Map<string, Promise<void>>();
    applicationRecordTransitionTails.set(repository, tails);
  }
  const previous = tails.get(applicationRecordId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  tails.set(applicationRecordId, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (tails.get(applicationRecordId) === tail) {
      tails.delete(applicationRecordId);
    }
  }
}

const applicationRecordResolutionTails = new WeakMap<
  object,
  Map<string, Promise<void>>
>();

async function withApplicationRecordResolution<T>(
  repository: object,
  jobId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let tails = applicationRecordResolutionTails.get(repository);
  if (!tails) {
    tails = new Map<string, Promise<void>>();
    applicationRecordResolutionTails.set(repository, tails);
  }
  const previous = tails.get(jobId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  tails.set(jobId, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (tails.get(jobId) === tail) tails.delete(jobId);
  }
}

export async function resolveApplicationRecordForJob(input: {
  repository: ApplicationCrmRepository;
  job: {
    id: string;
    title: string;
    company: string;
    status: ApplicationRecord["status"];
  };
  applicationRecordId?: string | null;
  now?: string;
}): Promise<ApplicationRecord> {
  return withApplicationRecordResolution(
    input.repository,
    input.job.id,
    async () => {
      const records = await input.repository.listApplicationRecords();
      if (
        input.applicationRecordId !== undefined &&
        input.applicationRecordId !== null
      ) {
        const selected = records.find(
          (record) => record.id === input.applicationRecordId,
        );
        if (!selected) {
          throw new Error(
            `Unknown Job Finder application record '${input.applicationRecordId}'.`,
          );
        }
        if (selected.jobId !== input.job.id) {
          throw new Error(
            `Application record '${selected.id}' does not belong to job '${input.job.id}'.`,
          );
        }
        return selected;
      }

      const matches = records.filter((record) => record.jobId === input.job.id);
      if (matches.length > 1) {
        throw new Error(
          `Job '${input.job.id}' has multiple application records; explicit application selection is required.`,
        );
      }
      if (matches[0]) return matches[0];

      const id = `application_${input.job.id}`;
      if (records.some((record) => record.id === id)) {
        throw new Error(
          `Canonical application record id '${id}' is already owned by another job.`,
        );
      }
      const now = input.now ?? new Date().toISOString();
      const created = ApplicationRecordSchema.parse({
        id,
        jobId: input.job.id,
        title: input.job.title,
        company: input.job.company,
        status: input.job.status,
        lastActionLabel: "Application record created for safe preparation.",
        nextActionLabel: "Prepare the application when you are ready.",
        lastUpdatedAt: now,
      });
      await input.repository.upsertApplicationRecord(created);
      return created;
    },
  );
}

function normalizeTag(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function uniqueTags(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const value of values) {
    const normalized = normalizeTag(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    tags.push(normalized);
  }

  return tags;
}

export function inferApplicationCrmStage(
  record: Pick<ApplicationRecord, "status" | "lastAttemptState"> &
    Partial<Pick<ApplicationRecord, "latestBlocker">>,
): ApplicationCrmStage {
  return inferApplicationActivityStage(record);
}

/**
 * Preparation states that prove the approval decision already happened and the
 * application moved on to (or past) its browser run. A record parked in one of
 * these states is not waiting for an approval any more, so counting it as
 * "ready for your approval" leaves a stale notification standing after the
 * resume was approved and the application was prepared.
 */
const PREPARATION_STARTED_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "in_progress",
  "paused",
  "submitted",
  "failed",
  "unsupported",
]);

/**
 * True only while the record's own approval decision is still outstanding: the
 * CRM stage says approval is the next step AND no preparation attempt has begun
 * for it yet. Every surface that tells the user an application "is ready for
 * your approval" derives from this one predicate so an approved-and-prepared
 * application cannot keep asking to be approved.
 */
export function isApplicationAwaitingUserApproval(
  record: ApplicationRecord,
): boolean {
  if (getApplicationCrmData(record).stage !== "ready_for_approval") {
    return false;
  }

  return !PREPARATION_STARTED_ATTEMPT_STATES.has(
    record.lastAttemptState ?? "not_started",
  );
}

export function getApplicationCrmData(
  record: ApplicationRecord,
): ApplicationCrmData {
  const stageSource = resolveApplicationCrmStageSource(record.crm);
  const stage = resolveApplicationCrmTrackedStage(
    record.crm,
    inferApplicationCrmStage(record),
  );
  if (record.crm)
    return ApplicationCrmDataSchema.parse({
      ...record.crm,
      stageSource,
      stage,
      stageChangedAt:
        stage === record.crm.stage
          ? record.crm.stageChangedAt
          : record.lastUpdatedAt,
    });

  return ApplicationCrmDataSchema.parse({
    stage,
    stageSource,
    stageChangedAt: record.lastUpdatedAt,
    appliedAt: record.status === "submitted" ? record.lastUpdatedAt : null,
  });
}

type ApplicationCrmProvenance =
  | "user_recorded_local"
  | "local_historical_inference";

function applicationCrmProvenance(
  record: Pick<ApplicationRecord, "crm">,
): ApplicationCrmProvenance {
  return resolveApplicationCrmStageSource(record.crm) === "user"
    ? "user_recorded_local"
    : "local_historical_inference";
}

function replaceById<T extends { id: string }>(
  values: readonly T[],
  value: T,
): T[] {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index < 0) return [...values, value];
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  );
}

function removeById<T extends { id: string }>(
  values: readonly T[],
  id: string,
): T[] {
  return values.filter((value) => value.id !== id);
}

function applyMutation(input: {
  crm: ApplicationCrmData;
  mutation: ApplicationCrmMutation;
  now: string;
  createId: () => string;
  actor?: "user" | "assistant";
}): ApplicationCrmData {
  const source = input.actor ?? "user";
  const { mutation, now } = input;
  const crm = input.crm;

  switch (mutation.type) {
    case "set_archived":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        archivedAt: mutation.archived ? (crm.archivedAt ?? now) : null,
      });
    case "set_stage": {
      if (
        crm.stageSource === "user" &&
        crm.stage === mutation.stage &&
        crm.customStageId === mutation.customStageId
      ) {
        return crm;
      }
      const event = {
        id: input.createId(),
        at: now,
        kind: "stage_changed" as const,
        title: `Moved to ${mutation.stage.replaceAll("_", " ")}`,
        detail: mutation.note,
        fromStage: crm.stage,
        toStage: mutation.stage,
        source,
      };
      return ApplicationCrmDataSchema.parse({
        ...crm,
        stage: mutation.stage,
        stageSource: "user",
        customStageId: mutation.customStageId,
        stageChangedAt: now,
        appliedAt:
          mutation.stage === "applied" ? (crm.appliedAt ?? now) : crm.appliedAt,
        lastEmployerActivityAt: [
          "employer_viewed",
          "recruiter_contact",
          "assessment",
          "interview",
          "offer",
          "rejected",
        ].includes(mutation.stage)
          ? now
          : crm.lastEmployerActivityAt,
        events: [...crm.events, event],
      });
    }
    case "set_tags":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        tags: uniqueTags(mutation.tags),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "tags_changed",
            title: "Updated application tags",
            detail: uniqueTags(mutation.tags).join(", ") || "All tags removed",
            source,
          },
        ],
      });
    case "add_note":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        notes: replaceById(crm.notes, mutation.note),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "note_changed",
            title: "Note added",
            detail: null,
            source,
          },
        ],
      });
    case "remove_note":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        notes: removeById(crm.notes, mutation.noteId),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "note_changed",
            title: "Removed a note",
            detail: null,
            source,
          },
        ],
      });
    case "upsert_contact":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        contacts: replaceById(crm.contacts, mutation.contact),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "contact_changed",
            title: crm.contacts.some(
              (contact) => contact.id === mutation.contact.id,
            )
              ? `Updated contact ${mutation.contact.name}`
              : `Added contact ${mutation.contact.name}`,
            detail: null,
            source,
          },
        ],
      });
    case "remove_contact":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        contacts: removeById(crm.contacts, mutation.contactId),
        interviews: crm.interviews.map((interview) => ({
          ...interview,
          contactIds: interview.contactIds.filter(
            (contactId) => contactId !== mutation.contactId,
          ),
        })),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "contact_changed",
            title: "Removed a contact",
            detail: null,
            source,
          },
        ],
      });
    case "upsert_reminder": {
      const existed = crm.reminders.some(
        (reminder) => reminder.id === mutation.reminder.id,
      );
      return ApplicationCrmDataSchema.parse({
        ...crm,
        reminders: replaceById(crm.reminders, mutation.reminder),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "reminder_changed",
            title: existed
              ? `Updated reminder ${mutation.reminder.title}`
              : `Added reminder ${mutation.reminder.title}`,
            detail: `Due ${mutation.reminder.dueAt}`,
            source,
          },
        ],
      });
    }
    case "remove_reminder":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        reminders: removeById(crm.reminders, mutation.reminderId),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "reminder_changed",
            title: "Removed a reminder",
            detail: null,
            source,
          },
        ],
      });
    case "upsert_interview": {
      const missingContactId = mutation.interview.contactIds.find(
        (contactId) =>
          !crm.contacts.some((contact) => contact.id === contactId),
      );
      if (missingContactId) {
        throw new Error(
          "The selected interview contact is no longer available. Refresh and try again.",
        );
      }
      const existed = crm.interviews.some(
        (interview) => interview.id === mutation.interview.id,
      );
      return ApplicationCrmDataSchema.parse({
        ...crm,
        interviews: replaceById(crm.interviews, mutation.interview),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "interview_changed",
            title: existed
              ? `Updated interview ${mutation.interview.title}`
              : `Scheduled interview ${mutation.interview.title}`,
            detail: `Starts ${mutation.interview.startsAt}`,
            source,
          },
        ],
      });
    }
    case "remove_interview":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        interviews: removeById(crm.interviews, mutation.interviewId),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "interview_changed",
            title: "Removed an interview",
            detail: null,
            source,
          },
        ],
      });
    case "set_compensation":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        compensation: mutation.compensation,
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "compensation_changed",
            title:
              mutation.compensation.offerStatus === "none"
                ? "Updated compensation details"
                : "Updated offer details",
            detail: null,
            source,
          },
        ],
      });
    case "add_attachment":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        attachments: replaceById(crm.attachments, mutation.attachment),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "attachment_changed",
            title: `Linked ${mutation.attachment.label}`,
            detail: null,
            source,
          },
        ],
      });
    case "remove_attachment":
      return ApplicationCrmDataSchema.parse({
        ...crm,
        attachments: removeById(crm.attachments, mutation.attachmentId),
        events: [
          ...crm.events,
          {
            id: input.createId(),
            at: now,
            kind: "attachment_changed",
            title: "Unlinked an attachment",
            detail: null,
            source,
          },
        ],
      });
  }
}

export async function mutateApplicationCrm(input: {
  repository: ApplicationCrmRepository;
  command: ApplicationCrmMutationInput;
  now?: () => string;
  createId?: () => string;
  validateCandidateAsset?: (candidateAssetId: string) => Promise<{
    id: string;
    originalName: string;
    consentScope: string;
    deletedAt: string | null;
  } | null>;
}): Promise<ApplicationRecord> {
  const command = ApplicationCrmMutationInputSchema.parse(input.command);
  const listedRecords = await input.repository.listApplicationRecords();
  const listedRecord = listedRecords.find(
    (candidate) => candidate.id === command.applicationRecordId,
  );
  if (!listedRecord) throw new Error("Application record not found.");

  return withApplicationRecordTransition(
    input.repository,
    listedRecord.id,
    async () => {
      const records = await input.repository.listApplicationRecords();
      const record = records.find(
        (candidate) => candidate.id === command.applicationRecordId,
      );
      if (!record) throw new Error("Application record not found.");

      const crm = getApplicationCrmData(record);
      if (crm.revision !== command.expectedRevision) {
        throw new ApplicationCrmRevisionConflictError();
      }

      if (command.mutation.type === "add_attachment") {
        if (!input.validateCandidateAsset) {
          throw new Error(
            "The selected Candidate Asset could not be verified. Refresh and try again.",
          );
        }
        const asset = await input.validateCandidateAsset(
          command.mutation.attachment.candidateAssetId,
        );
        if (
          !asset ||
          asset.id !== command.mutation.attachment.candidateAssetId ||
          asset.deletedAt !== null ||
          asset.consentScope !== "job_application_attachment"
        ) {
          throw new Error(
            "The selected Candidate Asset is unavailable or is not approved for application attachment.",
          );
        }
      }

      const now = input.now?.() ?? new Date().toISOString();
      const createId =
        input.createId ??
        (() => `crm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
      const mutated = applyMutation({
        crm,
        mutation: command.mutation,
        now,
        createId,
        actor: command.actor ?? "user",
      });
      if (mutated === crm) {
        return record;
      }
      const nextCrm = ApplicationCrmDataSchema.parse({
        ...mutated,
        revision: crm.revision + 1,
      });
      const nextRecord = ApplicationRecordSchema.parse({
        ...record,
        status: record.status,
        lastActionLabel:
          command.mutation.type === "set_stage"
            ? `Stage changed to ${nextCrm.stage.replaceAll("_", " ")}`
            : record.lastActionLabel,
        lastUpdatedAt: now,
        crm: nextCrm,
      });

      await input.repository.upsertApplicationRecord(nextRecord);
      return nextRecord;
    },
  );
}

function applyBulkStageMutationToRecord(input: {
  record: ApplicationRecord;
  stage: ApplicationCrmStage;
  customStageId: string | null;
  note: string | null;
  now: string;
  createId: () => string;
  actor: "user" | "assistant";
  command: ApplicationCrmBulkStageMutationInput;
  previousStage?: ApplicationCrmBulkStageMutationInput["items"][number]["previousStage"];
}): { record: ApplicationRecord; changed: boolean } {
  const crm = getApplicationCrmData(input.record);
  const mutated = applyMutation({
    crm,
    mutation:
      input.command.action === "tags"
        ? {
            type: "set_tags",
            tags: [...crm.tags, ...(input.command.tags ?? [])],
          }
        : input.command.action === "archive" ||
            input.command.action === "restore"
          ? {
              type: "set_archived",
              archived: input.command.action === "archive",
            }
          : {
              type: "set_stage",
              stage: input.previousStage?.stage ?? input.stage,
              customStageId:
                input.previousStage?.customStageId ?? input.customStageId,
              note: input.note,
            },
    now: input.now,
    createId: input.createId,
    actor: input.actor,
  });
  if (mutated === crm && input.command.action !== "undo") {
    return { record: input.record, changed: false };
  }

  const nextCrm = ApplicationCrmDataSchema.parse({
    ...mutated,
    ...(input.command.action === "undo" ? input.previousStage : {}),
    revision: crm.revision + 1,
  });
  return {
    changed: true,
    record: ApplicationRecordSchema.parse({
      ...input.record,
      status: input.record.status,
      lastActionLabel:
        !input.command.action ||
        input.command.action === "stage" ||
        input.command.action === "undo"
          ? `Stage changed to ${nextCrm.stage.replaceAll("_", " ")}`
          : input.record.lastActionLabel,
      lastUpdatedAt: input.now,
      crm: nextCrm,
    }),
  };
}

export function prepareApplicationCrmBulkStageMutation(input: {
  records: readonly ApplicationRecord[];
  command: unknown;
  now?: () => string;
  createId?: () => string;
}): {
  nextRecords: readonly ApplicationRecord[];
  changedRecordIds: readonly string[];
} {
  const command = ApplicationCrmBulkStageMutationInputSchema.parse(
    input.command,
  );
  const recordsById = new Map(
    input.records.map((record) => [record.id, record]),
  );
  const missingRecordIds = command.items
    .map((item) => item.applicationRecordId)
    .filter((recordId) => !recordsById.has(recordId));
  if (missingRecordIds.length > 0) {
    throw new ApplicationCrmBulkStageValidationError(
      missingRecordIds.length === 1
        ? "The selected application no longer exists. Refresh and try again."
        : `${missingRecordIds.length} selected applications no longer exist. Refresh and try again.`,
      missingRecordIds,
    );
  }

  const staleRecordIds = command.items
    .filter(
      ({ applicationRecordId, expectedRevision }) =>
        getApplicationCrmData(recordsById.get(applicationRecordId)!)
          .revision !== expectedRevision,
    )
    .map(({ applicationRecordId }) => applicationRecordId);
  if (staleRecordIds.length > 0) {
    throw new ApplicationCrmBulkStageRevisionConflictError(staleRecordIds);
  }

  const now = input.now?.() ?? new Date().toISOString();
  const createId =
    input.createId ??
    (() => `crm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  const changedRecordIds: string[] = [];
  const nextRecords = command.items.map(
    ({ applicationRecordId, previousStage }) => {
      const prepared = applyBulkStageMutationToRecord({
        record: recordsById.get(applicationRecordId)!,
        command,
        previousStage,
        stage: command.stage,
        customStageId: command.customStageId,
        note: command.note,
        now,
        createId,
        actor: command.actor ?? "user",
      });
      if (!prepared.changed) return prepared.record;

      changedRecordIds.push(applicationRecordId);
      return prepared.record;
    },
  );

  return { nextRecords, changedRecordIds };
}

export async function mutateApplicationCrmBulkStage(input: {
  repository: ApplicationCrmBatchRepository;
  command: unknown;
  now?: () => string;
  createId?: () => string;
}): Promise<readonly ApplicationRecord[]> {
  const command = ApplicationCrmBulkStageMutationInputSchema.parse(
    input.command,
  );
  const listedRecords = await input.repository.listApplicationRecords();
  const listedRecordsById = new Map(
    listedRecords.map((record) => [record.id, record]),
  );
  const missingRecordIds = command.items
    .map((item) => item.applicationRecordId)
    .filter((recordId) => !listedRecordsById.has(recordId));
  if (missingRecordIds.length > 0) {
    throw new ApplicationCrmBulkStageValidationError(
      missingRecordIds.length === 1
        ? "The selected application no longer exists. Refresh and try again."
        : `${missingRecordIds.length} selected applications no longer exist. Refresh and try again.`,
      missingRecordIds,
    );
  }

  const now = input.now?.() ?? new Date().toISOString();
  const createId =
    input.createId ??
    (() => `crm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  const staleRecordIds: string[] = [];
  const changedRecordIds: string[] = [];
  const nextRecordsById = new Map<string, ApplicationRecord>();

  for (const item of command.items) {
    const listedRecord = listedRecordsById.get(item.applicationRecordId)!;
    await withApplicationRecordTransition(
      input.repository,
      listedRecord.id,
      async () => {
        const freshRecord = (
          await input.repository.listApplicationRecords()
        ).find((candidate) => candidate.id === item.applicationRecordId);
        if (!freshRecord) {
          throw new ApplicationCrmBulkStageValidationError(
            "The selected application no longer exists. Refresh and try again.",
            [item.applicationRecordId],
          );
        }
        if (
          getApplicationCrmData(freshRecord).revision !== item.expectedRevision
        ) {
          staleRecordIds.push(item.applicationRecordId);
          return;
        }
        const prepared = applyBulkStageMutationToRecord({
          record: freshRecord,
          command,
          previousStage: item.previousStage,
          stage: command.stage,
          customStageId: command.customStageId,
          note: command.note,
          now,
          createId,
          actor: command.actor ?? "user",
        });
        if (!prepared.changed) return;

        changedRecordIds.push(prepared.record.id);
        nextRecordsById.set(prepared.record.id, prepared.record);
      },
    );
  }

  if (staleRecordIds.length > 0) {
    throw new ApplicationCrmBulkStageRevisionConflictError(staleRecordIds);
  }
  const result = await input.repository.commitApplicationRecordBatch({
    expectedRevisions: command.items,
    records: changedRecordIds.map((recordId) => nextRecordsById.get(recordId)!),
  });
  if (result.status !== "applied") {
    if (result.status === "missing") {
      throw new ApplicationCrmBulkStageValidationError(
        "One or more selected applications no longer exist. Refresh and try again.",
        result.recordIds,
      );
    }
    throw new ApplicationCrmBulkStageRevisionConflictError(result.recordIds);
  }
  const committedRecordsById = new Map(
    result.committedRecords.map((record) => [record.id, record]),
  );
  return listedRecords.map(
    (record) => committedRecordsById.get(record.id) ?? record,
  );
}

export async function runApplicationNoResponseAutomation(input: {
  repository: ApplicationCrmRepository;
  settings?: ApplicationCrmSettings;
  now?: () => string;
  createId?: () => string;
}): Promise<readonly ApplicationRecord[]> {
  const settings = ApplicationCrmSettingsSchema.parse(input.settings ?? {});
  if (!settings.noResponseAutomation.enabled) return [];

  const now = input.now?.() ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const thresholdMs = settings.noResponseAutomation.afterDays * 86_400_000;
  const records = await input.repository.listApplicationRecords();
  const updated: ApplicationRecord[] = [];

  for (const snapshotRecord of records) {
    const snapshotCrm = getApplicationCrmData(snapshotRecord);
    if (
      snapshotCrm.stage !== "applied" ||
      !snapshotCrm.appliedAt ||
      !Number.isFinite(Date.parse(snapshotCrm.appliedAt)) ||
      nowMs - Date.parse(snapshotCrm.appliedAt) < thresholdMs
    ) {
      continue;
    }

    await withApplicationRecordTransition(
      input.repository,
      snapshotRecord.id,
      async () => {
        const freshRecords = await input.repository.listApplicationRecords();
        const record = freshRecords.find(
          (candidate) => candidate.id === snapshotRecord.id,
        );
        if (!record) return;
        const crm = getApplicationCrmData(record);
        if (crm.stage !== "applied" || !crm.appliedAt) return;
        const appliedAtMs = Date.parse(crm.appliedAt);
        if (
          !Number.isFinite(appliedAtMs) ||
          nowMs - appliedAtMs < thresholdMs
        ) {
          return;
        }

        const nextCrm = ApplicationCrmDataSchema.parse({
          ...crm,
          revision: crm.revision + 1,
          stage: "no_response",
          stageChangedAt: now,
          events: [
            ...crm.events,
            {
              id:
                input.createId?.() ??
                `crm_automation_${record.id}_${Date.now()}`,
              at: now,
              kind: "automation",
              title: `No response after ${settings.noResponseAutomation.afterDays} days`,
              detail:
                "The application was marked for follow-up. No external action was taken.",
              fromStage: "applied",
              toStage: "no_response",
              source: "automation",
            },
          ],
        });
        const nextRecord = ApplicationRecordSchema.parse({
          ...record,
          status: record.status,
          lastActionLabel: `No response after ${settings.noResponseAutomation.afterDays} days`,
          nextActionLabel: "Follow up with the employer",
          lastUpdatedAt: now,
          crm: nextCrm,
        });
        await input.repository.upsertApplicationRecord(nextRecord);
        updated.push(nextRecord);
      },
    );
  }

  return updated;
}

function normalizeEmployer(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /\b(?:incorporated|inc|limited|ltd|llc|gmbh|corp|corporation)\b/gu,
      "",
    )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function findApplicationCrmDuplicateHints(
  records: readonly ApplicationRecord[],
): ApplicationCrmDuplicateHint[] {
  const hints: ApplicationCrmDuplicateHint[] = [];

  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    const left = records[leftIndex];
    if (!left) continue;
    const leftCrm = getApplicationCrmData(left);
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < records.length;
      rightIndex += 1
    ) {
      const right = records[rightIndex];
      if (!right) continue;
      if (
        normalizeEmployer(left.company) &&
        normalizeEmployer(left.company) === normalizeEmployer(right.company)
      ) {
        hints.push({
          applicationRecordId: left.id,
          duplicateApplicationRecordId: right.id,
          kind: "employer",
          reason: `Both applications use the employer name ${left.company}.`,
        });
      }

      const rightEmails = new Set(
        getApplicationCrmData(right)
          .contacts.map((contact) => contact.email?.toLowerCase() ?? "")
          .filter(Boolean),
      );
      const sharedEmail = leftCrm.contacts.find(
        (contact) =>
          contact.email && rightEmails.has(contact.email.toLowerCase()),
      )?.email;
      if (sharedEmail) {
        hints.push({
          applicationRecordId: left.id,
          duplicateApplicationRecordId: right.id,
          kind: "contact",
          reason: `Both applications reference ${sharedEmail}.`,
        });
      }
    }
  }

  return hints;
}

export function buildApplicationCrmCalendar(
  records: readonly ApplicationRecord[],
): ApplicationCrmCalendarEntry[] {
  return records
    .flatMap((record) => {
      const crm = getApplicationCrmData(record);
      if (crm.archivedAt) return [];
      const entries: ApplicationCrmCalendarEntry[] = [
        ...crm.reminders
          .filter((reminder) => reminder.status === "pending")
          .map((reminder) => ({
            id: `reminder_${reminder.id}`,
            applicationRecordId: record.id,
            kind: "reminder" as const,
            title: `${reminder.title} · ${record.title} at ${record.company}`,
            startsAt: reminder.dueAt,
            endsAt: null,
            status: reminder.status,
          })),
        ...crm.interviews
          .filter((interview) => interview.status === "scheduled")
          .map((interview) => ({
            id: `interview_${interview.id}`,
            applicationRecordId: record.id,
            kind: "interview" as const,
            title: `${interview.title} · ${record.title} at ${record.company}`,
            startsAt: interview.startsAt,
            timeZone: interview.timeZone,
            endsAt: interview.endsAt,
            status: interview.status,
          })),
      ];
      if (crm.compensation.offerDeadlineAt) {
        entries.push({
          id: `offer_deadline_${record.id}`,
          applicationRecordId: record.id,
          kind: "offer_deadline",
          title: `Offer deadline · ${record.title} at ${record.company}`,
          startsAt: crm.compensation.offerDeadlineAt,
          endsAt: null,
          status: crm.compensation.offerStatus,
        });
      }
      return entries;
    })
    .sort(
      (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
    );
}

export function recommendApplicationCrmAction(input: {
  records: readonly ApplicationRecord[];
  now?: string;
}): ApplicationCrmRecommendedAction | null {
  const now = Date.parse(input.now ?? new Date().toISOString());
  const calendar = buildApplicationCrmCalendar(input.records);
  const overdueReminder = calendar.find(
    (entry) => entry.kind === "reminder" && Date.parse(entry.startsAt) <= now,
  );
  if (overdueReminder) {
    return {
      applicationRecordId: overdueReminder.applicationRecordId,
      kind: "overdue_reminder",
      title: overdueReminder.title,
      reason: "This follow-up reminder is due now.",
      dueAt: overdueReminder.startsAt,
    };
  }

  const upcomingInterview = calendar.find(
    (entry) => entry.kind === "interview" && Date.parse(entry.startsAt) > now,
  );
  if (upcomingInterview) {
    return {
      applicationRecordId: upcomingInterview.applicationRecordId,
      kind: "upcoming_interview",
      title: upcomingInterview.title,
      reason: "This is the next scheduled interview.",
      dueAt: upcomingInterview.startsAt,
    };
  }

  const activeRecords = input.records.filter(
    (record) => !record.crm?.archivedAt,
  );
  const ready = activeRecords.find(isApplicationAwaitingUserApproval);
  if (ready) {
    return {
      applicationRecordId: ready.id,
      kind: "ready_for_approval",
      title: `Review ${ready.title} at ${ready.company}`,
      reason: "The application is prepared and waiting for your approval.",
      dueAt: null,
    };
  }

  const followUp = activeRecords.find(
    (record) => getApplicationCrmData(record).stage === "no_response",
  );
  if (followUp) {
    return {
      applicationRecordId: followUp.id,
      kind: "follow_up",
      title: `Follow up with ${followUp.company}`,
      reason: "This application has reached its no-response follow-up point.",
      dueAt: null,
    };
  }

  const review = [...input.records]
    .filter((record) =>
      ["discovered", "reviewing", "shortlisted"].includes(
        getApplicationCrmData(record).stage,
      ),
    )
    .sort((left, right) =>
      left.lastUpdatedAt.localeCompare(right.lastUpdatedAt),
    )[0];
  return review
    ? {
        applicationRecordId: review.id,
        kind: "review_application",
        title: `Review ${review.title} at ${review.company}`,
        reason: "This is the oldest application still waiting for a decision.",
        dueAt: null,
      }
    : null;
}

export interface ApplicationCrmDashboardProjection {
  trackingProvenance: "user_recorded_local";
  appliedToday: number;
  appliedThisWeek: number;
  responseRate: number | null;
  interviewRate: number | null;
  rateDenominator: number;
  upcomingInterviews: readonly ApplicationCrmCalendarEntry[];
  pendingFollowUps: readonly ApplicationCrmCalendarEntry[];
  recommendedAction: ApplicationCrmRecommendedAction | null;
}

export function projectApplicationCrmDashboard(input: {
  records: readonly ApplicationRecord[];
  now?: string;
  minimumRateSample?: number;
}): ApplicationCrmDashboardProjection {
  const nowIso = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const nowDate = new Date(nowMs);
  const startOfToday = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
  );
  const startOfWeek = startOfToday - 6 * 86_400_000;
  const appliedRecords = input.records.filter((record) => {
    const appliedAt = getApplicationCrmData(record).appliedAt;
    return Boolean(appliedAt && Number.isFinite(Date.parse(appliedAt)));
  });
  const appliedToday = appliedRecords.filter((record) => {
    const appliedAt = Date.parse(getApplicationCrmData(record).appliedAt ?? "");
    return appliedAt >= startOfToday && appliedAt <= nowMs;
  }).length;
  const appliedThisWeek = appliedRecords.filter((record) => {
    const appliedAt = Date.parse(getApplicationCrmData(record).appliedAt ?? "");
    return appliedAt >= startOfWeek && appliedAt <= nowMs;
  }).length;
  const responseStages = new Set<ApplicationCrmStage>([
    "employer_viewed",
    "recruiter_contact",
    "assessment",
    "interview",
    "offer",
    "rejected",
  ]);
  const interviewStages = new Set<ApplicationCrmStage>(["interview", "offer"]);
  const responseCount = appliedRecords.filter((record) =>
    responseStages.has(getApplicationCrmData(record).stage),
  ).length;
  const interviewCount = appliedRecords.filter((record) =>
    interviewStages.has(getApplicationCrmData(record).stage),
  ).length;
  const minimumRateSample = input.minimumRateSample ?? 5;
  const hasEnoughRateData = appliedRecords.length >= minimumRateSample;
  const calendar = buildApplicationCrmCalendar(input.records);

  return {
    trackingProvenance: "user_recorded_local",
    appliedToday,
    appliedThisWeek,
    responseRate: hasEnoughRateData
      ? Math.round((responseCount / appliedRecords.length) * 100)
      : null,
    interviewRate: hasEnoughRateData
      ? Math.round((interviewCount / appliedRecords.length) * 100)
      : null,
    rateDenominator: appliedRecords.length,
    upcomingInterviews: calendar.filter(
      (entry) =>
        entry.kind === "interview" && Date.parse(entry.startsAt) >= nowMs,
    ),
    pendingFollowUps: calendar.filter((entry) => entry.kind === "reminder"),
    recommendedAction: recommendApplicationCrmAction({
      records: input.records,
      now: nowIso,
    }),
  };
}

function csvCell(value: string | number | null): string {
  const raw = value == null ? "" : String(value);
  const text = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportApplicationCrm(input: {
  records: readonly ApplicationRecord[];
  request: ApplicationCrmExportInput;
  exportedAt?: string;
  /** The person's named stages, so an export carries their words. */
  customStages?: readonly { id: string; label: string }[];
  outcomes?: readonly OutcomeEvent[];
  results?: readonly ApplyJobResult[];
  runs?: readonly ApplyRunSummary[];
}): ApplicationCrmExportResult {
  const customStageLabel = (customStageId: string | null | undefined) =>
    customStageId
      ? (input.customStages?.find((stage) => stage.id === customStageId)
          ?.label ?? null)
      : null;
  const request = ApplicationCrmExportInputSchema.parse(input.request);
  const selectedIds = new Set(request.applicationRecordIds);
  const records = projectApplicationRecordsActivity({
    records: input.records,
    results: input.results ?? [],
    runs: input.runs ?? [],
  }).filter((record) => selectedIds.size === 0 || selectedIds.has(record.id));
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const dateLabel = exportedAt.slice(0, 10);
  // One application exports under its own name, so the file says what it
  // holds; a list keeps the plural name.
  const single = records.length === 1 ? records[0] : null;
  const fileStem = single
    ? `application-${single.company}-${single.title}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 80)
    : "applications";

  if (request.format === "json") {
    return {
      format: "json",
      fileName: `${fileStem}-${dateLabel}.json`,
      mimeType: "application/json",
      content: JSON.stringify(
        {
          exportedAt,
          applications: records.map((record) => {
            const crm = getApplicationCrmData(record);
            const provenance = applicationCrmProvenance(record);
            return {
              id: record.id,
              jobId: record.jobId,
              title: record.title,
              company: record.company,
              status: record.status,
              lastAttemptState: record.lastAttemptState,
              outcomes: (input.outcomes ?? []).filter(
                (outcome) =>
                  outcome.applicationRecordId === record.id ||
                  (!outcome.applicationRecordId &&
                    outcome.jobId === record.jobId),
              ),
              lastUpdatedAt: record.lastUpdatedAt,
              crm: {
                ...crm,
                customStageLabel: customStageLabel(crm.customStageId),
                stageProvenance: provenance,
                appliedAtProvenance: crm.appliedAt ? provenance : null,
                externalVerification: "not_verified_with_employer_or_ats",
              },
            };
          }),
        },
        null,
        2,
      ),
      exportedCount: records.length,
    };
  }

  const header = [
    "Application ID",
    "Job ID",
    "Title",
    "Company",
    "Stage",
    "Your stage name",
    "Stage provenance",
    "Tags",
    "Applied at",
    "Applied at provenance",
    "External verification",
    "Next reminder",
    "Next interview",
    "Last updated",
    "Notes",
    "Offer amount",
    "Offer currency",
    "Offer period",
    "Offer deadline",
    "Offer status",
    "Reminders",
    "Interviews",
    "Archived at",
  ];
  const rows = records.map((record) => {
    const crm = getApplicationCrmData(record);
    const provenance =
      applicationCrmProvenance(record) === "user_recorded_local"
        ? "Recorded by you"
        : "Recorded by Nestor";
    const nextReminder = crm.reminders
      .filter((reminder) => reminder.status === "pending")
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))[0];
    const nextInterview = crm.interviews
      .filter((interview) => interview.status === "scheduled")
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt))[0];
    return [
      record.id,
      record.jobId,
      record.title,
      record.company,
      APPLICATION_CRM_STAGE_NAMES[crm.stage],
      customStageLabel(crm.customStageId),
      provenance,
      crm.tags.join("; "),
      crm.appliedAt,
      crm.appliedAt ? provenance : null,
      "Not checked with the employer",
      nextReminder?.dueAt ?? null,
      nextInterview?.startsAt ?? null,
      record.lastUpdatedAt,
      crm.notes.map((note) => note.body).join("\n"),
      crm.compensation.offerBase?.amount ?? null,
      crm.compensation.offerBase?.currency ?? null,
      crm.compensation.offerBase?.period ?? null,
      crm.compensation.offerDeadlineAt,
      crm.compensation.offerStatus,
      crm.reminders
        .map(
          (entry) =>
            `${entry.title} · ${entry.dueAt} · ${entry.status}${entry.note ? ` · ${entry.note}` : ""}`,
        )
        .join("; "),
      crm.interviews
        .map(
          (entry) =>
            `${entry.title} · ${entry.startsAt}${entry.timeZone ? ` (${entry.timeZone})` : ""} · ${entry.status}${entry.notes ? ` · ${entry.notes}` : ""}`,
        )
        .join("; "),
      crm.archivedAt ?? null,
    ];
  });
  return {
    format: "csv",
    fileName: `${fileStem}-${dateLabel}.csv`,
    mimeType: "text/csv;charset=utf-8",
    // Every row ends with a line break, the last one too, so line-counting
    // tools see one line per application (without it, `wc -l` reported one
    // application fewer than the file holds).
    content: [header, ...rows]
      .map((row) => `${row.map((value) => csvCell(value)).join(",")}\r\n`)
      .join(""),
    exportedCount: records.length,
  };
}
