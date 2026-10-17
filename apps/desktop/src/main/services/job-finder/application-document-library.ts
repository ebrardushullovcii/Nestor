import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ApplicationDocumentListResultSchema,
  ApplicationDocumentRevisionSchema,
  type ApplicationDocumentKind,
  type ApplicationDocumentQuestionLineage,
  type ApplicationDocumentRevision,
  type ApplicationQuestionRecord,
  type ApplicationRecord,
  type CandidateProfile,
  type ListApplicationDocumentsInput,
  type SavedJob,
} from "@nestor/contracts";
import type { CandidateAssetLibrary } from "./candidate-asset-library";

interface ApplicationDocumentIndex {
  version: 1;
  revisions: ApplicationDocumentRevision[];
}

export interface ApplicationDocumentGrounding {
  profile: CandidateProfile;
  job: SavedJob;
  applicationRecord: ApplicationRecord;
  question: ApplicationQuestionRecord | null;
}

function fileNameSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
}

/** "cover-letter-cedar-compass-operations-coordinator-v3.txt" */
function approvedDocumentFileName(document: ApplicationDocumentRevision) {
  const kind =
    document.kind === "cover_letter" ? "cover-letter" : "application-answer";
  const parts = [
    kind,
    fileNameSegment(document.job.company),
    fileNameSegment(document.job.title),
    `v${document.revision}`,
  ].filter(Boolean);
  return `${parts.join("-")}.txt`;
}

export class ApplicationDocumentLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationDocumentLibraryError";
  }
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseIndex(value: unknown): ApplicationDocumentIndex {
  if (!value || typeof value !== "object") {
    throw new ApplicationDocumentLibraryError(
      "The application document index is invalid.",
    );
  }
  const candidate = value as { version?: unknown; revisions?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.revisions)) {
    throw new ApplicationDocumentLibraryError(
      "The application document index is invalid.",
    );
  }
  return {
    version: 1,
    revisions: candidate.revisions.map((revision) =>
      ApplicationDocumentRevisionSchema.parse(revision),
    ),
  };
}

function collectGroundedEvidence(profile: CandidateProfile) {
  const evidence: ApplicationDocumentRevision["evidence"] = [];
  const summary =
    profile.professionalSummary.fullSummary ??
    profile.professionalSummary.shortValueProposition ??
    profile.summary;
  if (summary?.trim()) {
    evidence.push({
      id: "profile.summary",
      source: "profile_summary",
      label: "Approved profile summary",
      text: summary.trim(),
    });
  }

  for (const entry of profile.proofBank) {
    const text = [entry.claim, entry.heroMetric, entry.supportingContext]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" ");
    if (!text) continue;
    evidence.push({
      id: `proof.${entry.id}`,
      source: "proof_bank",
      label: entry.title,
      text,
    });
  }

  for (const experience of profile.experiences) {
    const text = [experience.summary, ...experience.achievements]
      .filter((value): value is string => Boolean(value?.trim()))
      .slice(0, 2)
      .join(" ");
    if (!text) continue;
    evidence.push({
      id: `experience.${experience.id}`,
      source: "experience",
      label:
        [experience.title, experience.companyName]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(" at ") || "Approved experience",
      text,
    });
  }

  for (const project of profile.projects) {
    const text = [project.summary, project.outcome]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" ");
    if (!text) continue;
    evidence.push({
      id: `project.${project.id}`,
      source: "project",
      label: project.name,
      text,
    });
  }

  if (evidence.length === 0 && profile.skills.length > 0) {
    evidence.push({
      id: "profile.skills",
      source: "skill",
      label: "Approved profile skills",
      text: profile.skills.slice(0, 12).join(", "),
    });
  }

  if (evidence.length === 0) {
    throw new ApplicationDocumentLibraryError(
      "Add an approved profile summary, experience, project, proof, or skill before generating a document.",
    );
  }
  return evidence;
}

const relevanceStopWords = new Set([
  "and",
  "are",
  "for",
  "from",
  "have",
  "role",
  "that",
  "the",
  "this",
  "with",
  "your",
]);

function tokenize(value: string) {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9+#.]{3,}/g)
      ?.filter((token) => !relevanceStopWords.has(token)) ?? [],
  );
}

function selectRelevantEvidence(input: {
  evidence: ApplicationDocumentRevision["evidence"];
  job: SavedJob;
  question: ApplicationQuestionRecord | null;
}) {
  const targetTokens = tokenize(
    [
      input.job.title,
      input.job.summary,
      input.job.description,
      ...input.job.keySkills,
      ...input.job.responsibilities,
      ...input.job.minimumQualifications,
      ...input.job.preferredQualifications,
      input.question?.prompt,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  const deduplicated = input.evidence.filter((entry, index, all) => {
    const normalized = entry.text.toLowerCase().replace(/\W+/g, " ").trim();
    return (
      all.findIndex(
        (candidate) =>
          candidate.text.toLowerCase().replace(/\W+/g, " ").trim() ===
          normalized,
      ) === index
    );
  });
  const ranked = deduplicated
    .map((entry, index) => ({
      entry,
      index,
      score: [...tokenize(`${entry.label} ${entry.text}`)].reduce(
        (total, token) => total + (targetTokens.has(token) ? 1 : 0),
        0,
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.entry.source === "profile_summary") -
          Number(left.entry.source === "profile_summary") ||
        left.index - right.index,
    );
  const summary = ranked.find(
    ({ entry }) => entry.source === "profile_summary",
  );
  const selected = [
    ...(summary ? [summary.entry] : []),
    ...ranked
      .filter(({ entry }) => entry.id !== summary?.entry.id)
      .slice(0, summary ? 2 : 3)
      .map(({ entry }) => entry),
  ];
  return selected.slice(0, 3);
}

function normalizeSentence(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function splitSentences(value: string) {
  return (
    value
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []
  ).map(normalizeSentence);
}

const firstPersonVerbForms = new Map<string, string>([
  ["built", "built"],
  ["builds", "build"],
  ["created", "created"],
  ["creates", "create"],
  ["delivered", "delivered"],
  ["delivers", "deliver"],
  ["designed", "designed"],
  ["designs", "design"],
  ["developed", "developed"],
  ["develops", "develop"],
  ["drove", "drove"],
  ["drives", "drive"],
  ["implemented", "implemented"],
  ["implements", "implement"],
  ["led", "led"],
  ["leads", "lead"],
  ["maintained", "maintained"],
  ["maintains", "maintain"],
  ["managed", "managed"],
  ["manages", "manage"],
  ["owned", "owned"],
  ["owns", "own"],
  ["supported", "supported"],
  ["supports", "support"],
  ["worked", "worked"],
  ["works", "work"],
]);

function renderInFirstPerson(value: string) {
  if (/^(?:I|I'm|I've|My)\b/i.test(value)) return value;
  const match = value.match(/^([A-Za-z]+)(\b.*)$/);
  if (!match) return value;
  const verb = firstPersonVerbForms.get(match[1]!.toLowerCase());
  if (!verb) return value;
  return normalizeSentence(`I ${verb}${match[2]}`);
}

const sentenceSimilarityStopWords = new Set([
  "across",
  "and",
  "for",
  "from",
  "into",
  "the",
  "their",
  "this",
  "with",
]);

function sentenceTokens(value: string) {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((token) => !sentenceSimilarityStopWords.has(token))
      .map((token) =>
        token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token,
      ),
  );
}

function isSubstantiallyDuplicate(left: string, right: string) {
  const leftTokens = sentenceTokens(left);
  const rightTokens = sentenceTokens(right);
  const smallerSize = Math.min(leftTokens.size, rightTokens.size);
  if (smallerSize === 0) return false;
  const shared = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  return shared / smallerSize >= 0.72;
}

function composeGroundedSentences(
  evidence: ApplicationDocumentRevision["evidence"],
  limit: number,
) {
  const sentences: string[] = [];
  for (const entry of evidence) {
    for (const rawSentence of splitSentences(entry.text)) {
      const sentence = renderInFirstPerson(rawSentence);
      const duplicateIndex = sentences.findIndex((candidate) =>
        isSubstantiallyDuplicate(candidate, sentence),
      );
      if (duplicateIndex < 0) {
        sentences.push(sentence);
        continue;
      }
      if (
        sentenceTokens(sentence).size >
        sentenceTokens(sentences[duplicateIndex]!).size
      ) {
        sentences[duplicateIndex] = sentence;
      }
    }
  }
  return sentences.slice(0, limit);
}

function renderDocument(input: {
  kind: ApplicationDocumentKind;
  profile: CandidateProfile;
  job: SavedJob;
  question: ApplicationQuestionRecord | null;
  evidence: ApplicationDocumentRevision["evidence"];
}) {
  const groundedSentences = composeGroundedSentences(
    input.evidence,
    input.kind === "short_response" ? 3 : 4,
  );
  if (input.kind === "short_response") {
    return groundedSentences.join(" ");
  }
  return [
    "Dear Hiring Team,",
    "",
    `I am applying for the ${input.job.title} role at ${input.job.company}.`,
    "",
    groundedSentences.join(" "),
    "",
    "Thank you for your consideration.",
    "",
    input.profile.fullName,
  ].join("\n");
}

function safeFileSegment(value: string) {
  return value
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class ApplicationDocumentLibrary {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rootDirectory: string,
    private readonly candidateAssets: CandidateAssetLibrary,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(input: ListApplicationDocumentsInput) {
    const index = await this.readIndex();
    const latestById = new Map<string, ApplicationDocumentRevision>();
    const approvedById = new Map<string, ApplicationDocumentRevision>();
    for (const revision of index.revisions) {
      if (
        revision.job.jobId !== input.jobId ||
        revision.job.applicationRecordId !== input.applicationRecordId
      ) {
        continue;
      }
      if (revision.approvedAt !== null && revision.status !== "proposed") {
        const approved = approvedById.get(revision.id);
        if (!approved || approved.revision < revision.revision)
          approvedById.set(revision.id, revision);
      }
      const current = latestById.get(revision.id);
      if (!current || current.revision < revision.revision) {
        latestById.set(revision.id, revision);
      }
    }
    return ApplicationDocumentListResultSchema.parse({
      approvedRevisions: [...approvedById.values()].filter(
        (approved) =>
          (latestById.get(approved.id)?.revision ?? 0) > approved.revision,
      ),
      documents: [...latestById.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    });
  }

  async getLatestApprovedCoverLetter(
    jobId: string,
    applicationRecordId?: string,
  ) {
    const index = await this.readIndex();
    const approved = index.revisions
      .filter(
        (document) =>
          document.kind === "cover_letter" &&
          document.job.jobId === jobId &&
          document.status !== "proposed" &&
          document.approvedAt !== null,
      )
      .sort(
        (left, right) =>
          right.approvedAt!.localeCompare(left.approvedAt!) ||
          right.revision - left.revision,
      );
    return (
      approved.find(
        (document) => document.job.applicationRecordId === applicationRecordId,
      ) ??
      approved[0] ??
      null
    );
  }

  propose(input: {
    kind: ApplicationDocumentKind;
    documentId?: string;
    /** Capture an attached or unchecked draft once without overwriting edits. */
    createDocumentId?: string;
    reviewReason?: string | null;
    expectedRevision?: number;
    grounding: ApplicationDocumentGrounding;
    /**
     * Text the model wrote from the same profile and posting. When absent the
     * draft is assembled from the selected evidence, as before.
     */
    writtenContent?: string | null;
  }): Promise<ApplicationDocumentRevision> {
    return this.runExclusive(async () => {
      const index = await this.readIndex();
      const documentId =
        input.documentId ??
        input.createDocumentId ??
        `application_document_${randomUUID()}`;
      const latest = index.revisions
        .filter((revision) => revision.id === documentId)
        .sort((left, right) => right.revision - left.revision)[0];
      if (input.createDocumentId && latest) {
        if (
          latest.job.jobId !== input.grounding.job.id ||
          latest.job.applicationRecordId !==
            input.grounding.applicationRecord.id
        ) {
          throw new ApplicationDocumentLibraryError(
            "This document belongs to another application.",
          );
        }
        return latest;
      }
      if (input.documentId) {
        if (!latest || latest.revision !== input.expectedRevision) {
          throw new ApplicationDocumentLibraryError(
            "This document changed after it was opened. Reload before revising it.",
          );
        }
      } else if (latest) {
        throw new ApplicationDocumentLibraryError(
          "Document ID already exists.",
        );
      }

      const { profile, job, applicationRecord, question } = input.grounding;
      if (applicationRecord.jobId !== job.id) {
        throw new ApplicationDocumentLibraryError(
          "The application record does not belong to the selected job.",
        );
      }
      const evidence = selectRelevantEvidence({
        evidence: collectGroundedEvidence(profile),
        job,
        question,
      });
      const timestamp = this.now().toISOString();
      const questionLineage: ApplicationDocumentQuestionLineage | null =
        question
          ? {
              runId: question.runId,
              questionId: question.id,
              prompt: question.prompt,
            }
          : null;
      const document = ApplicationDocumentRevisionSchema.parse({
        id: documentId,
        revision: (latest?.revision ?? 0) + 1,
        kind: input.kind,
        status: "proposed",
        createdAt: latest?.createdAt ?? timestamp,
        updatedAt: timestamp,
        job: {
          jobId: job.id,
          applicationRecordId: applicationRecord.id,
          sourceJobId: job.sourceJobId,
          canonicalUrl: job.canonicalUrl,
          title: job.title,
          company: job.company,
          jobDigest: digest({
            id: job.id,
            sourceJobId: job.sourceJobId,
            canonicalUrl: job.canonicalUrl,
            title: job.title,
            company: job.company,
            description: job.description,
          }),
        },
        question: questionLineage,
        content:
          input.writtenContent?.trim() ||
          renderDocument({
            kind: input.kind,
            profile,
            job,
            question,
            evidence,
          }),
        evidence,
        evidenceDigest: digest(evidence),
        authorship: "system_grounded",
        requiresGroundingReview: Boolean(input.reviewReason),
        reviewReason: input.reviewReason?.slice(0, 2_000) ?? null,
        approvedAt: null,
        outputAsset: null,
        lastExportedAt: null,
      });
      index.revisions.push(document);
      await this.writeIndex(index);
      return document;
    });
  }

  edit(
    documentId: string,
    expectedRevision: number,
    content: string,
  ): Promise<ApplicationDocumentRevision> {
    return this.runExclusive(async () => {
      const index = await this.readIndex();
      const current = this.getCurrent(index, documentId, expectedRevision);
      if (current.status !== "proposed") {
        throw new ApplicationDocumentLibraryError(
          "Only a proposed document can be edited. Create a new proposal first.",
        );
      }
      const timestamp = this.now().toISOString();
      const edited = ApplicationDocumentRevisionSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "proposed",
        updatedAt: timestamp,
        content,
        authorship: "user_edited",
        requiresGroundingReview: true,
        approvedAt: null,
        outputAsset: null,
        lastExportedAt: null,
      });
      index.revisions.push(edited);
      await this.writeIndex(index);
      return edited;
    });
  }

  approve(documentId: string, expectedRevision: number) {
    return this.runExclusive(async () => {
      const index = await this.readIndex();
      const document = this.getCurrent(index, documentId, expectedRevision);
      if (document.status !== "proposed") {
        return document;
      }
      // The saved file keeps a name a person can read in Profile › Files and
      // an employer sees on upload: what it is, for which job, which version.
      const temporaryDirectory = path.join(
        this.rootDirectory,
        `${document.id}-r${document.revision}`,
      );
      const temporaryPath = path.join(
        temporaryDirectory,
        approvedDocumentFileName(document),
      );
      await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, document.content, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        const imported = await this.candidateAssets.importFromSourcePath(
          temporaryPath,
          {
            kind:
              document.kind === "cover_letter"
                ? "cover_letter"
                : "application_response",
            sensitivity: "sensitive",
            consentScope: "job_application_attachment",
            retention: "until_deleted",
            forJob: {
              jobId: document.job.jobId,
              title: document.job.title.slice(0, 300),
              company: document.job.company.slice(0, 300),
            },
          },
        );
        if (imported.status !== "imported") {
          throw new ApplicationDocumentLibraryError(
            "The approved document could not be added to candidate assets.",
          );
        }
        const approved = ApplicationDocumentRevisionSchema.parse({
          ...document,
          status: "approved",
          updatedAt: this.now().toISOString(),
          approvedAt: this.now().toISOString(),
          outputAsset: imported.asset,
        });
        this.replaceRevision(index, approved);
        await this.writeIndex(index);
        return approved;
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    });
  }

  async getApproved(documentId: string, expectedRevision: number) {
    const index = await this.readIndex();
    const document = this.getCurrent(index, documentId, expectedRevision);
    if (document.status === "proposed" || !document.outputAsset) {
      throw new ApplicationDocumentLibraryError(
        "Approve this exact revision before exporting it.",
      );
    }
    return document;
  }

  recordExport(documentId: string, expectedRevision: number) {
    return this.runExclusive(async () => {
      const index = await this.readIndex();
      const document = this.getCurrent(index, documentId, expectedRevision);
      if (document.status === "proposed" || !document.outputAsset) {
        throw new ApplicationDocumentLibraryError(
          "Approve this exact revision before exporting it.",
        );
      }
      const exported = ApplicationDocumentRevisionSchema.parse({
        ...document,
        status: "exported",
        updatedAt: this.now().toISOString(),
        lastExportedAt: this.now().toISOString(),
      });
      this.replaceRevision(index, exported);
      await this.writeIndex(index);
      return exported;
    });
  }

  buildDefaultFileName(document: ApplicationDocumentRevision) {
    const kind = document.kind === "cover_letter" ? "Cover letter" : "Response";
    const title = safeFileSegment(document.job.title);
    const company = safeFileSegment(document.job.company);
    return `${kind} - ${title} - ${company}.txt`;
  }

  private getCurrent(
    index: ApplicationDocumentIndex,
    documentId: string,
    expectedRevision: number,
  ) {
    const latest = index.revisions
      .filter((revision) => revision.id === documentId)
      .sort((left, right) => right.revision - left.revision)[0];
    if (!latest || latest.revision !== expectedRevision) {
      throw new ApplicationDocumentLibraryError(
        "This document changed after it was opened. Reload before continuing.",
      );
    }
    return latest;
  }

  private replaceRevision(
    index: ApplicationDocumentIndex,
    document: ApplicationDocumentRevision,
  ) {
    const position = index.revisions.findIndex(
      (revision) =>
        revision.id === document.id && revision.revision === document.revision,
    );
    if (position < 0) {
      throw new ApplicationDocumentLibraryError(
        "Document revision was not found.",
      );
    }
    index.revisions[position] = document;
  }

  private async readIndex(): Promise<ApplicationDocumentIndex> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const indexPath = path.join(this.rootDirectory, "index.json");
    const raw = await readFile(indexPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (raw === null) return { version: 1, revisions: [] };
    try {
      return parseIndex(JSON.parse(raw));
    } catch {
      throw new ApplicationDocumentLibraryError(
        "The application document index is invalid.",
      );
    }
  }

  private async writeIndex(index: ApplicationDocumentIndex) {
    const parsed = parseIndex(index);
    const temporaryPath = path.join(
      this.rootDirectory,
      `index.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, JSON.stringify(parsed, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, path.join(this.rootDirectory, "index.json"));
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
