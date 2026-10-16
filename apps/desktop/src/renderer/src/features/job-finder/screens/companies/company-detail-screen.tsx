import { useMemo, useState, type ReactNode } from "react";
import type {
  ApplicationRecord,
  CompanyContact,
  CompanyEntity,
  CompanyIntelligenceMutationInput,
  CompanyNote,
  CompanyPreference,
  CompanySalaryOfferEvidence,
  ReviewCompanyMergeInput,
  JobListRow,
} from "@nordri/contracts";
import { isGenericCompanyName, normalizeCompanyName } from "@nordri/contracts";
import {
  projectCompanyApplicationHistory,
  projectCompanyDuplicateJobs,
  projectCompanyOpenings,
} from "../../lib/company-projections";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { EmptyState } from "../../components/empty-state";
import { ExternalUrlLink } from "../../components/open-outside-links";
import { StatusBadge } from "../../components/status-badge";
import {
  formatStatusLabel,
  getPostedDateLabel,
} from "../../lib/job-finder-utils";
import { presentListingActivity } from "../../lib/listing-activity-presentation";
import { recordedJobSourceName } from "../../lib/job-source-display-name";
import {
  BoundedCollectionList,
  BoundedCollectionPagination,
  BOUNDED_COLLECTION_PAGE_SIZE,
  useBoundedCollection,
} from "../actions/bounded-collection";
import {
  companyPreferenceLabels,
  companyPreferenceScopeDescription,
  companySalaryOfferEvidenceKindLabels,
  companySourceHistoryLabel,
  describeCompanySalaryOfferEvidence,
} from "./company-presentation";

interface CompanyDetailScreenProps {
  actionMessage: string | null;
  applicationRecords: readonly ApplicationRecord[];
  companies: readonly CompanyEntity[];
  company: CompanyEntity;
  companyId: string;
  discoveryJobs: readonly JobListRow[];
  selectedJobId?: string | null;
  selectedApplicationRecordId?: string | null;
  isMergePending: (companyId: string) => boolean;
  isMutationPending: (companyId: string) => boolean;
  isPreferencePending: (companyId: string) => boolean;
  onBack: () => void;
  onMutateCompanyIntelligence: (
    command: CompanyIntelligenceMutationInput,
  ) => Promise<void>;
  onNavigate: (path: string) => void;
  onOpenApplication: (recordId: string) => void;
  onOpenJob: (jobId: string) => void;
  onReviewCompanyMerge: (input: ReviewCompanyMergeInput) => Promise<void>;
  onSetCompanyPreference: (input: {
    companyId: string;
    preference: CompanyPreference;
  }) => Promise<void>;
  activeCapLimitReached?: boolean;
  onOpenSafeguards?: () => void;
}

function SectionCard(props: {
  children?: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="surface-card-tint grid content-start gap-2 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="font-semibold text-(--text-headline)">{props.title}</h2>
        {props.description ? (
          <p className="text-(length:--text-tiny) leading-4 text-foreground-muted">
            {props.description}
          </p>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

type CompanyDetailJob = JobListRow;

function JobRow(props: {
  job: CompanyDetailJob;
  onOpen: (jobId: string) => void;
}) {
  const listingDate = getPostedDateLabel(props.job);
  const activity = presentListingActivity(
    props.job.listingActivity ?? { status: "unknown" },
  );

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-field) border border-border-subtle px-3 py-2">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="min-w-0 break-words text-sm font-medium text-foreground">
          {props.job.title}
        </p>
        <p className="text-(length:--text-tiny) text-foreground-muted">
          {props.job.location} · Workflow: {formatStatusLabel(props.job.status)}
          {listingDate ? ` · ${listingDate.label} ${listingDate.value}` : ""}
        </p>
        <div className="mt-1 flex min-w-0 flex-wrap items-start gap-2">
          <StatusBadge tone={activity.tone}>{activity.label}</StatusBadge>
          <p className="min-w-0 flex-1 break-words text-(length:--text-tiny) leading-5 text-foreground-muted">
            {activity.description}
          </p>
        </div>
      </div>
      <Button
        onClick={() => props.onOpen(props.job.id)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Open job
      </Button>
    </li>
  );
}

function ApplicationRow(props: {
  record: ApplicationRecord;
  onOpen: (recordId: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-field) border border-border-subtle px-3 py-2">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="min-w-0 break-words text-sm font-medium text-foreground">
          {props.record.title}
        </p>
        <p className="text-(length:--text-tiny) text-foreground-muted">
          {formatStatusLabel(props.record.status)} · Updated{" "}
          {props.record.lastUpdatedAt.slice(0, 10)}
        </p>
      </div>
      <Button
        onClick={() => props.onOpen(props.record.id)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Open application
      </Button>
    </li>
  );
}

function ContactsSection(props: {
  company: CompanyEntity;
  isPending: boolean;
  onMutate: (command: CompanyIntelligenceMutationInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Partial<CompanyContact>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const reset = () => {
    setDraft({});
    setEditingId(null);
  };

  const startEdit = (contact: CompanyContact) => {
    setEditingId(contact.id);
    setDraft({ ...contact });
  };

  const save = () => {
    if (!draft.name?.trim()) return;
    const now = new Date().toISOString();
    const contact: CompanyContact = {
      id: editingId ?? `contact_${crypto.randomUUID()}`,
      name: draft.name.trim(),
      role: draft.role?.trim() || null,
      email: draft.email?.trim() || null,
      phone: draft.phone?.trim() || null,
      notes: draft.notes?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    void props
      .onMutate({
        companyId: props.company.id,
        expectedUpdatedAt: props.company.updatedAt,
        mutation: { type: "upsert_contact", contact },
      })
      .then(reset)
      .catch(() => {});
  };

  return (
    <SectionCard
      description="People you have contacted or plan to contact."
      title="Contacts"
    >
      {props.company.contacts.length > 0 ? (
        <BoundedCollectionList
          collection={props.company.contacts}
          resetKey={props.company.id}
          itemLabel="contacts"
          getId={(contact) => contact.id}
          selectedId={editingId}
        >
          {(contact) => (
            <li
              className="flex flex-wrap items-start justify-between gap-2 rounded-(--radius-field) border border-border-subtle px-3 py-2"
              key={contact.id}
            >
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="text-sm font-medium text-foreground">
                  {contact.name}
                  {contact.role ? ` — ${contact.role}` : ""}
                </p>
                <p className="text-(length:--text-tiny) text-foreground-muted">
                  {[contact.email, contact.phone].filter(Boolean).join(" · ") ||
                    "No contact details"}
                </p>
                {contact.notes ? (
                  <p className="mt-1 text-(length:--text-small) text-foreground-soft">
                    {contact.notes}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  onClick={() => startEdit(contact)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Edit
                </Button>
                <Button
                  aria-label={`Remove contact ${contact.name}`}
                  onClick={() =>
                    void props
                      .onMutate({
                        companyId: props.company.id,
                        expectedUpdatedAt: props.company.updatedAt,
                        mutation: {
                          type: "remove_contact",
                          contactId: contact.id,
                        },
                      })
                      .catch(() => {})
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </li>
          )}
        </BoundedCollectionList>
      ) : (
        <p className="text-(length:--text-small) text-foreground-soft">
          No contacts recorded yet.
        </p>
      )}

      <div className="grid gap-2 rounded-(--radius-field) border border-border-subtle p-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span>Name</span>
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="Recruiter or contact name"
            value={draft.name ?? ""}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Role</span>
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, role: event.target.value }))
            }
            placeholder="Recruiter, hiring manager…"
            value={draft.role ?? ""}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Email</span>
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, email: event.target.value }))
            }
            placeholder="name@example.com"
            type="email"
            value={draft.email ?? ""}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Phone</span>
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, phone: event.target.value }))
            }
            placeholder="+44 7700 900123"
            value={draft.phone ?? ""}
          />
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          <span>Notes</span>
          <Input
            onChange={(event) =>
              setDraft((current) => ({ ...current, notes: event.target.value }))
            }
            placeholder="How you met, what they mentioned…"
            value={draft.notes ?? ""}
          />
        </label>
        <div className="flex justify-end gap-2 sm:col-span-2">
          {editingId ? (
            <Button onClick={reset} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
          ) : null}
          <Button
            disabled={!draft.name?.trim() || props.isPending}
            onClick={save}
            pending={props.isPending}
            size="sm"
            type="button"
          >
            {editingId ? "Save contact" : "Add contact"}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

function NotesSection(props: {
  company: CompanyEntity;
  isPending: boolean;
  onMutate: (command: CompanyIntelligenceMutationInput) => Promise<void>;
}) {
  const [body, setBody] = useState("");

  const addNote = () => {
    if (!body.trim()) return;
    const now = new Date().toISOString();
    const note: CompanyNote = {
      id: `note_${crypto.randomUUID()}`,
      body: body.trim(),
      createdAt: now,
      updatedAt: now,
    };
    void props
      .onMutate({
        companyId: props.company.id,
        expectedUpdatedAt: props.company.updatedAt,
        mutation: { type: "add_note", note },
      })
      .then(() => setBody(""))
      .catch(() => {});
  };

  return (
    <SectionCard description="Private notes about this employer." title="Notes">
      {props.company.notes.length > 0 ? (
        <BoundedCollectionList
          collection={props.company.notes}
          resetKey={props.company.id}
          itemLabel="notes"
          getId={(note) => note.id}
        >
          {(note) => (
            <li
              className="flex items-start justify-between gap-2 rounded-(--radius-field) border border-border-subtle px-3 py-2"
              key={note.id}
            >
              <p className="min-w-0 flex-1 break-words text-sm leading-5 text-foreground">
                {note.body}
              </p>
              <Button
                aria-label="Remove note"
                className="shrink-0"
                onClick={() =>
                  void props
                    .onMutate({
                      companyId: props.company.id,
                      expectedUpdatedAt: props.company.updatedAt,
                      mutation: { type: "remove_note", noteId: note.id },
                    })
                    .catch(() => {})
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            </li>
          )}
        </BoundedCollectionList>
      ) : (
        <p className="text-(length:--text-small) text-foreground-soft">
          No notes yet.
        </p>
      )}

      <div className="flex gap-2">
        <Input
          aria-label="New note"
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addNote();
          }}
          placeholder="Write a note…"
          value={body}
        />
        <Button
          disabled={!body.trim() || props.isPending}
          onClick={addNote}
          pending={props.isPending}
          size="sm"
          type="button"
        >
          <Plus aria-hidden="true" className="size-4" />
          Add
        </Button>
      </div>
    </SectionCard>
  );
}

function normalizeCompanyDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.+$/u, "")
    .replace(/^www\./u, "");
}

function resolveCurrentCompanyId(
  companies: readonly CompanyEntity[],
  job: JobListRow,
): string | null {
  const name = normalizeCompanyName(job.company);
  if (!name || isGenericCompanyName(name)) {
    return null;
  }

  const nameMatches = companies.filter(
    (company) =>
      normalizeCompanyName(company.canonicalName) === name ||
      company.aliases.some(
        (alias) =>
          alias.identityAuthority === "user_approved_merge" &&
          alias.normalized === name,
      ),
  );
  if (nameMatches.length !== 1) {
    return null;
  }

  const domainMatches = job.employerDomain?.trim()
    ? companies.filter((company) =>
        company.domains.some(
          (candidate) =>
            normalizeCompanyDomain(candidate.domain) ===
            normalizeCompanyDomain(job.employerDomain!),
        ),
      )
    : [];

  if (
    domainMatches.length === 1 &&
    domainMatches[0]!.id !== nameMatches[0]!.id
  ) {
    return null;
  }
  return nameMatches[0]!.id;
}

function EvidenceSection(props: {
  applicationRecords: readonly ApplicationRecord[];
  companies: readonly CompanyEntity[];
  company: CompanyEntity;
  jobs: readonly JobListRow[];
  isPending: boolean;
  onMutate: (command: CompanyIntelligenceMutationInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Partial<CompanySalaryOfferEvidence>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const jobIds = useMemo(
    () => new Set(props.company.jobIds),
    [props.company.jobIds],
  );
  const applicationIds = useMemo(
    () => new Set(props.company.applicationRecordIds),
    [props.company.applicationRecordIds],
  );
  const companyJobs = props.jobs.filter(
    (job) =>
      jobIds.has(job.id) &&
      resolveCurrentCompanyId(props.companies, job) === props.company.id,
  );
  const selectedJobId = draft.jobId ?? "";
  const applicationRecords = props.applicationRecords.filter(
    (record) => record.jobId === selectedJobId && applicationIds.has(record.id),
  );
  const jobPage = useBoundedCollection(
    companyJobs,
    props.company.id,
    companyJobs.findIndex((job) => job.id === selectedJobId),
    selectedJobId,
    selectedJobId && companyJobs.length > BOUNDED_COLLECTION_PAGE_SIZE
      ? BOUNDED_COLLECTION_PAGE_SIZE - 1
      : BOUNDED_COLLECTION_PAGE_SIZE,
  );
  const applicationPage = useBoundedCollection(
    applicationRecords,
    `${props.company.id}:${selectedJobId}`,
    applicationRecords.findIndex(
      (record) => record.id === draft.applicationRecordId,
    ),
    draft.applicationRecordId,
    draft.applicationRecordId &&
      applicationRecords.length > BOUNDED_COLLECTION_PAGE_SIZE
      ? BOUNDED_COLLECTION_PAGE_SIZE - 1
      : BOUNDED_COLLECTION_PAGE_SIZE,
  );
  // A chosen option stays in the native select while the person browses other
  // pages. Selection remains a draft fact, independent of the visible window.
  const selectedJob = companyJobs.find((job) => job.id === selectedJobId);
  const selectedApplication = applicationRecords.find(
    (record) => record.id === draft.applicationRecordId,
  );
  const jobOptions =
    selectedJob && !jobPage.items.includes(selectedJob)
      ? [selectedJob, ...jobPage.items]
      : jobPage.items;
  const applicationOptions =
    selectedApplication && !applicationPage.items.includes(selectedApplication)
      ? [selectedApplication, ...applicationPage.items]
      : applicationPage.items;
  const requiresJob = draft.kind === "listed_salary" || draft.kind === "offer";
  const requiresApplication = draft.kind === "offer";
  const reset = () => {
    setDraft({});
    setEditingId(null);
  };
  const startEdit = (evidence: CompanySalaryOfferEvidence) => {
    setEditingId(evidence.id);
    setDraft({ ...evidence });
  };
  const actionContext = (evidence: CompanySalaryOfferEvidence) => {
    const job = props.jobs.find((entry) => entry.id === evidence.jobId);
    return `${companySalaryOfferEvidenceKindLabels[evidence.kind]} "${evidence.summary}" for ${props.company.canonicalName}${job ? `, ${job.title}` : ""}; ${describeCompanySalaryOfferEvidence(evidence)}; recorded ${evidence.recordedAt.slice(0, 10)}`;
  };

  const save = () => {
    if (!draft.summary?.trim()) return;
    const now = new Date().toISOString();
    const evidence: CompanySalaryOfferEvidence = {
      id: editingId ?? `evidence_${crypto.randomUUID()}`,
      kind: draft.kind ?? "note",
      summary: draft.summary.trim(),
      currency: draft.currency?.trim() || null,
      minimum: draft.minimum ?? null,
      maximum: draft.maximum ?? null,
      period: draft.period ?? null,
      offerStatus: draft.offerStatus ?? null,
      jobId: draft.jobId?.trim() || null,
      applicationRecordId: draft.applicationRecordId?.trim() || null,
      source: "manual",
      recordedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    void props
      .onMutate({
        companyId: props.company.id,
        expectedUpdatedAt: props.company.updatedAt,
        mutation: { type: "upsert_salary_offer_evidence", evidence },
      })
      .then(reset)
      .catch(() => {});
  };

  return (
    <SectionCard
      description="Ranges, offers, and benefits you have seen or received."
      title="Salary / offer evidence"
    >
      {props.company.salaryOfferEvidence.length > 0 ? (
        <BoundedCollectionList
          collection={props.company.salaryOfferEvidence}
          resetKey={props.company.id}
          itemLabel="salary / offer evidence"
          getId={(evidence) => evidence.id}
          selectedId={editingId}
        >
          {(evidence) => (
            <li
              className="flex flex-wrap items-start justify-between gap-2 rounded-(--radius-field) border border-border-subtle px-3 py-2"
              key={evidence.id}
            >
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="text-sm font-medium text-foreground">
                  {companySalaryOfferEvidenceKindLabels[evidence.kind]} —{" "}
                  {evidence.summary}
                </p>
                <p className="text-(length:--text-tiny) text-foreground-muted">
                  {describeCompanySalaryOfferEvidence(evidence)}
                </p>
                {evidence.jobId || evidence.applicationRecordId ? (
                  <p className="text-(length:--text-tiny) text-foreground-muted">
                    Linked to{" "}
                    {[
                      evidence.jobId && `job ${evidence.jobId}`,
                      evidence.applicationRecordId &&
                        `application ${evidence.applicationRecordId}`,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  aria-label={`Edit ${actionContext(evidence)}`}
                  onClick={() => startEdit(evidence)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Edit
                </Button>
                <Button
                  aria-label={`Remove ${actionContext(evidence)}`}
                  onClick={() =>
                    void props
                      .onMutate({
                        companyId: props.company.id,
                        expectedUpdatedAt: props.company.updatedAt,
                        mutation: {
                          type: "remove_salary_offer_evidence",
                          evidenceId: evidence.id,
                        },
                      })
                      .catch(() => {})
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </li>
          )}
        </BoundedCollectionList>
      ) : (
        <p className="text-(length:--text-small) text-foreground-soft">
          No salary or offer evidence recorded yet. Offers are local facts and
          never grant submission authority.
        </p>
      )}

      <div className="grid gap-2 rounded-(--radius-field) border border-border-subtle p-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm sm:col-span-2">
          <span>Summary</span>
          <Input
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                summary: event.target.value,
              }))
            }
            placeholder="Verbal offer of 190k, or Glassdoor range"
            value={draft.summary ?? ""}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Kind</span>
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                kind: event.target.value as CompanySalaryOfferEvidence["kind"],
              }))
            }
            value={draft.kind ?? "note"}
          >
            {(
              Object.keys(companySalaryOfferEvidenceKindLabels) as Array<
                CompanySalaryOfferEvidence["kind"]
              >
            ).map((kind) => (
              <option key={kind} value={kind}>
                {companySalaryOfferEvidenceKindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>Currency</span>
          <Input
            maxLength={3}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                currency: event.target.value.toUpperCase(),
              }))
            }
            placeholder="USD"
            value={draft.currency ?? ""}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Minimum</span>
          <Input
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                minimum:
                  event.target.value === "" ? null : Number(event.target.value),
              }))
            }
            min={0}
            placeholder="180000"
            type="number"
            value={draft.minimum ?? ""}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Maximum</span>
          <Input
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                maximum:
                  event.target.value === "" ? null : Number(event.target.value),
              }))
            }
            min={0}
            placeholder="220000"
            type="number"
            value={draft.maximum ?? ""}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Period</span>
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                period:
                  event.target.value === ""
                    ? null
                    : (event.target
                        .value as CompanySalaryOfferEvidence["period"]),
              }))
            }
            value={draft.period ?? ""}
          >
            <option value="">Not specified</option>
            <option value="hour">Hour</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>Offer status</span>
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                offerStatus:
                  event.target.value === ""
                    ? null
                    : (event.target
                        .value as CompanySalaryOfferEvidence["offerStatus"]),
              }))
            }
            value={draft.offerStatus ?? ""}
          >
            <option value="">Not specified</option>
            <option value="none">None</option>
            <option value="active">Active</option>
            <option value="accepted">Accepted</option>
            <option value="declined">Declined</option>
            <option value="expired">Expired</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          <span>Job{requiresJob ? " (required)" : " (optional)"}</span>
          <select
            aria-label="Evidence job"
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                jobId: event.target.value || null,
                applicationRecordId: null,
              }))
            }
            value={selectedJobId}
          >
            <option value="">No job selected</option>
            {/* R10: this option read "Remote Customer Support - $20/hr+
                (job_target_site_weworkremotely_com_listing_ads_13_click)".
                A stored id is not a name; the job is named by its title,
                its employer, and where it came from. */}
            {jobOptions.map((job) => (
              <option key={job.id} value={job.id}>
                {`${job.title} · ${
                  job.company?.trim() || recordedJobSourceName(job.source)
                }`}
              </option>
            ))}
          </select>
        </label>
        {companyJobs.length > jobPage.pageSize ? (
          <div className="sm:col-span-2">
            <BoundedCollectionPagination
              {...jobPage}
              itemLabel="evidence jobs"
            />
          </div>
        ) : null}
        {selectedJobId ? (
          <label className="grid gap-1 text-sm sm:col-span-2">
            <span>
              Application record
              {requiresApplication ? " (required for offers)" : " (optional)"}
            </span>
            <select
              aria-label="Evidence application record"
              className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  applicationRecordId: event.target.value || null,
                }))
              }
              value={draft.applicationRecordId ?? ""}
            >
              <option value="">
                {applicationRecords.length === 0
                  ? "No application records for this job"
                  : "Job only (not application-derived)"}
              </option>
              {applicationOptions.map((record) => (
                <option key={record.id} value={record.id}>
                  {`${record.title} · ${record.company}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {selectedJobId &&
        applicationRecords.length > applicationPage.pageSize ? (
          <div className="sm:col-span-2">
            <BoundedCollectionPagination
              {...applicationPage}
              itemLabel="evidence application records"
            />
          </div>
        ) : null}
        <div className="flex justify-end gap-2 sm:col-span-2">
          {editingId ? (
            <Button onClick={reset} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
          ) : null}
          <Button
            disabled={
              !draft.summary?.trim() ||
              props.isPending ||
              (requiresJob && !selectedJobId) ||
              (requiresApplication && !draft.applicationRecordId)
            }
            onClick={save}
            pending={props.isPending}
            size="sm"
            type="button"
          >
            {editingId ? "Save evidence" : "Add evidence"}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

function MergeReviewSection(props: {
  company: CompanyEntity;
  companies: readonly CompanyEntity[];
  isPending: (companyId: string) => boolean;
  onReview: (input: ReviewCompanyMergeInput) => Promise<void>;
}) {
  const pending = props.company.mergeReviewCandidates.filter(
    (candidate) => candidate.decision === "pending",
  );

  if (pending.length === 0) {
    return null;
  }

  return (
    <SectionCard
      description="Merge only when certain; every alias, job, application, contact, note, and evidence record is preserved."
      title="Duplicate employer review"
    >
      <BoundedCollectionList
        collection={pending}
        resetKey={props.company.id}
        itemLabel="duplicate employers"
        getId={(candidate) => candidate.candidateCompanyId}
      >
        {(candidate) => {
          const candidateCompany = props.companies.find(
            (company) => company.id === candidate.candidateCompanyId,
          );
          return (
            <li
              className="grid gap-2 rounded-(--radius-field) border border-border-subtle px-3 py-2"
              key={candidate.candidateCompanyId}
            >
              <p className="text-(length:--text-small) leading-5 text-foreground">
                {candidate.reason}
              </p>
              {candidateCompany ? (
                <p className="text-(length:--text-tiny) text-foreground-muted">
                  Would absorb “{candidateCompany.canonicalName}” (
                  {candidateCompany.jobIds.length} jobs,{" "}
                  {candidateCompany.applicationRecordIds.length} applications).
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  disabled={props.isPending(props.company.id)}
                  onClick={() => {
                    void props.onReview({
                      companyId: props.company.id,
                      candidateId: candidate.candidateCompanyId,
                      decision: "rejected",
                    });
                  }}
                  pending={props.isPending(props.company.id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Reject
                </Button>
                <Button
                  disabled={props.isPending(props.company.id)}
                  onClick={() => {
                    void props.onReview({
                      companyId: props.company.id,
                      candidateId: candidate.candidateCompanyId,
                      decision: "accepted",
                    });
                  }}
                  pending={props.isPending(props.company.id)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Merge
                </Button>
              </div>
            </li>
          );
        }}
      </BoundedCollectionList>
    </SectionCard>
  );
}

export function CompanyDetailScreen(props: CompanyDetailScreenProps) {
  const { company } = props;
  const [mutationError, setMutationError] = useState<string | null>(null);
  const domains = useBoundedCollection(company.domains, company.id);
  const jobsById = useMemo(
    () => new Map(props.discoveryJobs.map((job) => [job.id, job])),
    [props.discoveryJobs],
  );

  const openings = useMemo(
    () =>
      projectCompanyOpenings({
        company,
        jobs: props.discoveryJobs,
      }),
    [company, props.discoveryJobs],
  );
  const duplicateGroups = useMemo(
    () =>
      projectCompanyDuplicateJobs({
        company,
        jobs: props.discoveryJobs,
      }),
    [company, props.discoveryJobs],
  );
  const applicationHistory = useMemo(
    () =>
      projectCompanyApplicationHistory({
        company,
        applicationRecords: props.applicationRecords,
      }),
    [company, props.applicationRecords],
  );

  const handleMutate = (command: CompanyIntelligenceMutationInput) => {
    setMutationError(null);
    return props
      .onMutateCompanyIntelligence(command)
      .catch((error: unknown) => {
        setMutationError(
          error instanceof Error
            ? error.message
            : "The company change could not be saved. Refresh and try again.",
        );
        throw error;
      });
  };

  if (!company) {
    return (
      <EmptyState
        title="Company not found"
        description="This company is no longer in your workspace. Return to the company list and refresh from jobs."
      />
    );
  }

  return (
    <section className="grid content-start gap-4 pb-8">
      <header className="surface-panel-shell flex flex-wrap items-center gap-x-4 gap-y-2 rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-3">
        <Button onClick={props.onBack} size="sm" type="button" variant="ghost">
          <ArrowLeft aria-hidden="true" className="size-4" />
          All companies
        </Button>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h1 className="min-w-0 break-words font-semibold tracking-[-0.03em] text-(--text-headline)">
            {company.canonicalName}
          </h1>
          {company.domains.length > 0 ? (
            <p className="min-w-0 break-all text-(length:--text-tiny) text-foreground-muted">
              {domains.items.map((domain, index) => (
                <span key={domain.domain}>
                  {index > 0 ? ", " : null}
                  <ExternalUrlLink
                    label={domain.domain}
                    url={`https://${domain.domain}`}
                  />
                </span>
              ))}
            </p>
          ) : null}
          {company.domains.length > domains.pageSize ? (
            <BoundedCollectionPagination
              {...domains}
              itemLabel="company domains"
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {props.activeCapLimitReached ? (
            <StatusBadge tone="critical">Application cap reached</StatusBadge>
          ) : null}
          <StatusBadge tone="neutral">
            {company.aliases.length} alias
            {company.aliases.length === 1 ? "" : "es"}
          </StatusBadge>
          {props.activeCapLimitReached && props.onOpenSafeguards ? (
            <Button
              onClick={props.onOpenSafeguards}
              size="sm"
              type="button"
              variant="outline"
            >
              Open Safeguards
            </Button>
          ) : null}
        </div>
        <div className="grid shrink-0 gap-1">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
              Company tracking
            </span>
            <select
              aria-describedby="company-preference-scope"
              aria-label={`Company tracking preference for ${company.canonicalName}`}
              className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              disabled={props.isPreferencePending(company.id)}
              onChange={(event) =>
                void props.onSetCompanyPreference({
                  companyId: company.id,
                  preference: event.target.value as CompanyPreference,
                })
              }
              value={company.preference}
            >
              {(
                Object.keys(companyPreferenceLabels) as CompanyPreference[]
              ).map((preference) => (
                <option key={preference} value={preference}>
                  {companyPreferenceLabels[preference]}
                </option>
              ))}
            </select>
          </label>
          <p
            className="max-w-80 text-(length:--text-tiny) leading-4 text-foreground-muted"
            id="company-preference-scope"
          >
            {companyPreferenceScopeDescription}
          </p>
        </div>
      </header>

      {props.actionMessage ? (
        <p
          aria-atomic="true"
          aria-live="polite"
          className="min-w-0 break-words rounded-(--radius-small) border border-primary/25 bg-primary/5 px-3 py-2 text-(length:--text-small) leading-6 text-foreground"
          role="status"
        >
          {props.actionMessage}
        </p>
      ) : null}

      {mutationError ? (
        <p
          aria-atomic="true"
          aria-live="assertive"
          className="min-w-0 break-words rounded-(--radius-small) border border-destructive/30 bg-destructive/10 px-3 py-2 text-(length:--text-small) leading-6 text-destructive"
          role="alert"
        >
          {mutationError}
        </p>
      ) : null}

      <MergeReviewSection
        company={company}
        companies={props.companies}
        isPending={props.isMergePending}
        onReview={props.onReviewCompanyMerge}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          description={`${openings.lastSeenAvailableCount} last seen available · ${openings.needsVerificationCount} need verification · ${openings.reportedClosedCount} reported closed`}
          title={`Openings (${openings.totalCount})`}
        >
          {openings.lastSeenAvailable.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                Last seen available
              </p>
              <BoundedCollectionList
                collection={openings.lastSeenAvailable}
                resetKey={company.id}
                itemLabel="last seen available openings"
                getId={(job) => job.id}
                selectedId={props.selectedJobId}
              >
                {(job) => (
                  <JobRow job={job} key={job.id} onOpen={props.onOpenJob} />
                )}
              </BoundedCollectionList>
            </div>
          ) : (
            <p className="text-(length:--text-small) text-foreground-soft">
              No openings were last seen available.
            </p>
          )}
          {openings.needsVerification.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                Needs verification
              </p>
              <BoundedCollectionList
                collection={openings.needsVerification}
                resetKey={company.id}
                itemLabel="openings needing verification"
                getId={(job) => job.id}
                selectedId={props.selectedJobId}
              >
                {(job) => (
                  <JobRow job={job} key={job.id} onOpen={props.onOpenJob} />
                )}
              </BoundedCollectionList>
            </div>
          ) : null}
          {openings.reportedClosed.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                Reported closed
              </p>
              <BoundedCollectionList
                collection={openings.reportedClosed}
                resetKey={company.id}
                itemLabel="reported closed openings"
                getId={(job) => job.id}
                selectedId={props.selectedJobId}
              >
                {(job) => (
                  <JobRow job={job} key={job.id} onOpen={props.onOpenJob} />
                )}
              </BoundedCollectionList>
            </div>
          ) : null}
          {openings.totalCount === 0 ? (
            <p className="text-(length:--text-small) text-foreground-soft">
              No jobs are linked to this company yet.
            </p>
          ) : null}
        </SectionCard>

        <SectionCard
          description="Stage and outcome history tracked locally."
          title={`Applications (${applicationHistory.totalCount})`}
        >
          {applicationHistory.records.length > 0 ? (
            <BoundedCollectionList
              collection={applicationHistory.records}
              resetKey={company.id}
              itemLabel="company applications"
              getId={(record) => record.id}
              selectedId={props.selectedApplicationRecordId}
            >
              {(record) => (
                <ApplicationRow
                  key={record.id}
                  onOpen={props.onOpenApplication}
                  record={record}
                />
              )}
            </BoundedCollectionList>
          ) : (
            <p className="text-(length:--text-small) text-foreground-soft">
              No application records yet.
            </p>
          )}
        </SectionCard>

        <SectionCard
          description="Repeat postings surfaced for your review, never auto-merged."
          title={`Duplicate jobs (${duplicateGroups.length})`}
        >
          {duplicateGroups.length > 0 ? (
            <BoundedCollectionList
              collection={duplicateGroups}
              resetKey={company.id}
              itemLabel="duplicate jobs"
              getId={(group) => group.id}
            >
              {(group) => (
                <li
                  className="grid gap-2 rounded-(--radius-field) border border-border-subtle px-3 py-2"
                  key={group.id}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      tone={group.kind === "exact" ? "critical" : "neutral"}
                    >
                      {group.kind === "exact"
                        ? "Exact match"
                        : "Possible match"}
                    </StatusBadge>
                  </div>
                  <p className="text-(length:--text-small) leading-5 text-foreground">
                    {group.reason}
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {group.jobIds.map((jobId) => {
                      const job = jobsById.get(jobId);
                      return (
                        <li key={jobId}>
                          <Button
                            disabled={!job}
                            onClick={() => job && props.onOpenJob(job.id)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            {job?.title ?? jobId}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              )}
            </BoundedCollectionList>
          ) : (
            <p className="text-(length:--text-small) text-foreground-soft">
              No duplicate postings detected for this employer.
            </p>
          )}
        </SectionCard>

        <SectionCard
          description="Sources that contributed jobs or applications."
          title={`Source history (${company.sourceHistory.length})`}
        >
          {company.sourceHistory.length > 0 ? (
            <BoundedCollectionList
              collection={company.sourceHistory}
              resetKey={company.id}
              itemLabel="source history"
              getId={(ref) => ref.id}
            >
              {(ref) => (
                <li
                  className="grid gap-0.5 rounded-(--radius-field) border border-border-subtle px-3 py-2"
                  key={ref.id}
                >
                  <p className="text-sm font-medium text-foreground">
                    {companySourceHistoryLabel(ref.sourceId)}
                  </p>
                  <p className="text-(length:--text-tiny) text-foreground-muted">
                    First seen {ref.firstSeenAt.slice(0, 10)} · Last seen{" "}
                    {ref.lastSeenAt.slice(0, 10)} ·{" "}
                    {ref.applicationRecordIds.length} application
                    {ref.applicationRecordIds.length === 1 ? "" : "s"}
                  </p>
                </li>
              )}
            </BoundedCollectionList>
          ) : (
            <p className="text-(length:--text-small) text-foreground-soft">
              No source history yet.
            </p>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4">
        <ContactsSection
          company={company}
          isPending={props.isMutationPending(company.id)}
          onMutate={handleMutate}
        />
        <NotesSection
          company={company}
          isPending={props.isMutationPending(company.id)}
          onMutate={handleMutate}
        />
        <EvidenceSection
          applicationRecords={props.applicationRecords}
          companies={props.companies}
          company={company}
          jobs={props.discoveryJobs}
          isPending={props.isMutationPending(company.id)}
          onMutate={handleMutate}
        />
      </div>
    </section>
  );
}
