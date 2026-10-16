import { useEffect, useMemo, useState } from "react";
import type {
  CompanyEntity,
  CompanyIntelligenceMutationInput,
  CompanyPreference,
  ReviewCompanyMergeInput,
  JobListRow,
} from "@nordri/contracts";
import { isListableCompanyName } from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";
import { EmptyState } from "../../components/empty-state";
import {
  CollectionPagination,
  COLLECTION_PAGE_SIZE,
} from "../../components/collection-pagination";
import { PageHeaderStack } from "../../components/page-header";
import { StatusBadge } from "../../components/status-badge";
import {
  CollectionNoMatches,
  CollectionSearchToolbar,
  matchesCollectionSearch,
} from "../../components/collection-search-toolbar";
import {
  companyPreferenceLabels,
  companyPreferenceScopeDescription,
  companyPreferenceTones,
  companySearchTokens,
} from "./company-presentation";
import {
  indexCompanyJobs,
  projectCompanyOpenings,
  type CompanyJobIndex,
} from "../../lib/company-projections";

interface CompaniesScreenProps {
  actionMessage: string | null;
  companies: readonly CompanyEntity[];
  discoveryJobs: readonly JobListRow[];
  isLoading?: boolean;
  isMergePending: (companyId: string) => boolean;
  isMutationPending: (companyId: string) => boolean;
  isPreferencePending: (companyId: string) => boolean;
  isRefreshPending: boolean;
  onMutateCompanyIntelligence: (
    command: CompanyIntelligenceMutationInput,
  ) => Promise<void>;
  onNavigate: (path: string) => void;
  onRefresh: () => Promise<void>;
  onReviewCompanyMerge: (input: ReviewCompanyMergeInput) => Promise<void>;
  onSetCompanyPreference: (input: {
    companyId: string;
    preference: CompanyPreference;
  }) => Promise<void>;
}

function pendingMergeCount(company: CompanyEntity): number {
  return company.mergeReviewCandidates.filter(
    (candidate) => candidate.decision === "pending",
  ).length;
}

function CompanyCard(props: {
  company: CompanyEntity;
  jobById: CompanyJobIndex;
  jobs: readonly JobListRow[];
  isMutationPending: boolean;
  isPreferencePending: boolean;
  onNavigate: (path: string) => void;
  onSetPreference: (preference: CompanyPreference) => void;
}) {
  const { company } = props;
  const openings = projectCompanyOpenings({
    company,
    jobs: props.jobs,
    jobById: props.jobById,
  });
  const pendingMerges = pendingMergeCount(company);

  return (
    <article
      className="surface-panel-shell grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
      data-testid={`company-card-${company.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="min-w-0 break-words font-semibold text-(--text-headline)">
            {company.canonicalName}
          </h2>
          {company.domains.length > 0 ? (
            <p className="min-w-0 break-all text-(length:--text-small) text-foreground-soft">
              {company.domains.map((domain) => domain.domain).join(", ")}
            </p>
          ) : null}
          {company.aliases.length > 0 ? (
            <p className="min-w-0 break-words text-(length:--text-tiny) text-foreground-muted">
              Also known as:{" "}
              {company.aliases.map((alias) => alias.alias).join(", ")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={companyPreferenceTones[company.preference]}>
            {companyPreferenceLabels[company.preference]}
          </StatusBadge>
          {pendingMerges > 0 ? (
            <StatusBadge tone="critical">
              {pendingMerges} merge review{pendingMerges === 1 ? "" : "s"}
            </StatusBadge>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Last seen available
          </dt>
          <dd className="text-foreground-soft">
            {openings.lastSeenAvailableCount}
          </dd>
        </div>
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Needs verification
          </dt>
          <dd className="text-foreground-soft">
            {openings.needsVerificationCount}
          </dd>
        </div>
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Reported closed
          </dt>
          <dd className="text-foreground-soft">
            {openings.reportedClosedCount}
          </dd>
        </div>
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Applications
          </dt>
          <dd className="text-foreground-soft">
            {company.applicationRecordIds.length}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Company tracking
          </span>
          <select
            aria-describedby={`company-preference-scope-${company.id}`}
            aria-label={`Company tracking preference for ${company.canonicalName}`}
            className="h-9 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-2 text-sm outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            disabled={props.isPreferencePending}
            onChange={(event) =>
              props.onSetPreference(event.target.value as CompanyPreference)
            }
            value={company.preference}
          >
            {(Object.keys(companyPreferenceLabels) as CompanyPreference[]).map(
              (preference) => (
                <option key={preference} value={preference}>
                  {companyPreferenceLabels[preference]}
                </option>
              ),
            )}
          </select>
          <span
            className="max-w-72 text-(length:--text-tiny) leading-4 text-foreground-muted"
            id={`company-preference-scope-${company.id}`}
          >
            {companyPreferenceScopeDescription}
          </span>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={props.isMutationPending}
            onClick={() =>
              props.onNavigate(`/job-finder/companies/${company.id}`)
            }
            size="sm"
            type="button"
            variant="secondary"
          >
            View company
          </Button>
        </div>
      </div>
    </article>
  );
}

function MergeReviewSection(props: {
  companies: readonly CompanyEntity[];
  isPending: (companyId: string) => boolean;
  onNavigate: (path: string) => void;
  onReview: (input: ReviewCompanyMergeInput) => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const companyById = useMemo(
    () => new Map(props.companies.map((company) => [company.id, company])),
    [props.companies],
  );
  const pendingCandidates = useMemo(
    () =>
      props.companies.flatMap((company) =>
        company.mergeReviewCandidates
          .filter((candidate) => candidate.decision === "pending")
          .map((candidate) => ({ company, candidate })),
      ),
    [props.companies],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(pendingCandidates.length / COLLECTION_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount);
  const pendingCompanies = useMemo(() => {
    const groups = new Map<
      string,
      {
        company: CompanyEntity;
        candidates: CompanyEntity["mergeReviewCandidates"];
      }
    >();
    for (const { company, candidate } of pendingCandidates.slice(
      (currentPage - 1) * COLLECTION_PAGE_SIZE,
      currentPage * COLLECTION_PAGE_SIZE,
    )) {
      const group = groups.get(company.id);
      if (group) group.candidates.push(candidate);
      else groups.set(company.id, { company, candidates: [candidate] });
    }
    return [...groups.values()];
  }, [currentPage, pendingCandidates]);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  if (pendingCompanies.length === 0) {
    return (
      <section className="grid gap-3 rounded-(--radius-field) border border-border-subtle p-4">
        <h3 className="font-semibold text-(--text-headline)">
          Duplicate employer review
        </h3>
        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
          No ambiguous company identities need your decision right now. Company
          intelligence never merges employers silently; near matches always
          appear here for an explicit merge or reject.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="company-merge-review-heading"
      className="grid gap-3 rounded-(--radius-field) border border-destructive/25 p-4"
    >
      <div>
        <h3
          className="font-semibold text-(--text-headline)"
          id="company-merge-review-heading"
        >
          Duplicate employer review
        </h3>
        <p className="mt-1 text-(length:--text-small) leading-5 text-foreground-soft">
          These companies may be the same employer. Merge only when you are
          certain; rejecting keeps them separate. Aliases and history are
          preserved on merge.
        </p>
      </div>
      <ul className="grid gap-3">
        {pendingCompanies.map(({ company, candidates }) => (
          <li
            className="surface-card-tint grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-4"
            data-company-merge-review={company.id}
            key={company.id}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1">
                <p className="font-semibold text-(--text-headline)">
                  {company.canonicalName}
                </p>
                <p className="text-(length:--text-tiny) text-foreground-muted">
                  {company.aliases.map((alias) => alias.alias).join(", ") ||
                    "No aliases yet"}
                </p>
              </div>
              <Button
                onClick={() =>
                  props.onNavigate(`/job-finder/companies/${company.id}`)
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Review
              </Button>
            </div>
            <ul className="grid gap-2">
              {candidates.map((candidate) => (
                <li
                  className="flex flex-wrap items-start justify-between gap-3 rounded-(--radius-field) border border-border-subtle px-3 py-2"
                  data-company-merge-candidate={candidate.candidateCompanyId}
                  key={candidate.candidateCompanyId}
                >
                  <div className="grid min-w-0 flex-1 gap-1">
                    <p className="text-(length:--text-small) font-medium leading-5 text-foreground">
                      Possible match:{" "}
                      {companyById.get(candidate.candidateCompanyId)
                        ?.canonicalName ?? candidate.candidateCompanyId}
                    </p>
                    <p className="text-(length:--text-small) leading-5 text-foreground">
                      {candidate.reason}
                    </p>
                    <p className="text-(length:--text-tiny) text-foreground-muted">
                      Merging would combine every job, application, contact,
                      note, and evidence record into one company.
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      disabled={props.isPending(company.id)}
                      onClick={() => {
                        void props.onReview({
                          companyId: company.id,
                          candidateId: candidate.candidateCompanyId,
                          decision: "rejected",
                        });
                      }}
                      pending={props.isPending(company.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Reject
                    </Button>
                    <Button
                      disabled={props.isPending(company.id)}
                      onClick={() => {
                        void props.onReview({
                          companyId: company.id,
                          candidateId: candidate.candidateCompanyId,
                          decision: "accepted",
                        });
                      }}
                      pending={props.isPending(company.id)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Merge
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <CollectionPagination
        itemLabel="merge candidates"
        onPageChange={setPage}
        page={currentPage}
        pageSize={COLLECTION_PAGE_SIZE}
        totalCount={pendingCandidates.length}
      />
    </section>
  );
}

export function CompaniesScreen(props: CompaniesScreenProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const jobById = useMemo(
    () => indexCompanyJobs(props.discoveryJobs),
    [props.discoveryJobs],
  );

  const listableCompanies = useMemo(
    () =>
      props.companies.filter((company) =>
        isListableCompanyName(company.canonicalName),
      ),
    [props.companies],
  );

  const filteredCompanies = useMemo(
    () =>
      listableCompanies.filter((company) =>
        matchesCollectionSearch(query, companySearchTokens(company)),
      ),
    [listableCompanies, query],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(filteredCompanies.length / COLLECTION_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount);
  const pagedCompanies = useMemo(
    () =>
      filteredCompanies.slice(
        (currentPage - 1) * COLLECTION_PAGE_SIZE,
        currentPage * COLLECTION_PAGE_SIZE,
      ),
    [currentPage, filteredCompanies],
  );

  useEffect(() => {
    setPage(1);
  }, [query]);
  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount));
  }, [pageCount]);

  if (props.isLoading) {
    return (
      <main className="grid min-h-full place-items-center px-6 py-10">
        <EmptyState
          title="Loading companies"
          description="Reconciling employers from your saved jobs and applications."
        />
      </main>
    );
  }

  const handleRefresh = () => {
    setRefreshError(null);
    void props.onRefresh().catch((error: unknown) => {
      setRefreshError(
        error instanceof Error
          ? error.message
          : "What Job Finder knows about these employers could not be refreshed.",
      );
    });
  };

  return (
    <section className="grid gap-5 pb-8">
      <PageHeaderStack
        actions={
          listableCompanies.length > 0 ? (
            <Button
              onClick={handleRefresh}
              pending={props.isRefreshPending}
              size="sm"
              type="button"
              variant="secondary"
            >
              Refresh from jobs and applications
            </Button>
          ) : null
        }
        description="Review employers, openings, contacts, outcomes, notes, and duplicate records."
        title="Companies"
      />

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

      {refreshError ? (
        <p
          aria-atomic="true"
          aria-live="assertive"
          className="min-w-0 break-words rounded-(--radius-small) border border-destructive/30 bg-destructive/10 px-3 py-2 text-(length:--text-small) leading-6 text-destructive"
          role="alert"
        >
          {refreshError}
        </p>
      ) : null}

      <MergeReviewSection
        companies={props.companies}
        isPending={props.isMergePending}
        onNavigate={props.onNavigate}
        onReview={props.onReviewCompanyMerge}
      />

      {listableCompanies.length === 0 ? (
        <div className="grid gap-3">
          <EmptyState
            className="min-h-40 px-5 py-6"
            title="No companies reconciled yet"
            description="This is where the employers from your saved jobs and started applications appear. Choose Refresh from jobs and applications to build the list from what you already have."
          />
          <div className="flex justify-center">
            <Button
              onClick={handleRefresh}
              pending={props.isRefreshPending}
              type="button"
            >
              Refresh from jobs and applications
            </Button>
          </div>
        </div>
      ) : (
        <>
          <CollectionSearchToolbar
            className="px-0"
            label="Search companies"
            onQueryChange={setQuery}
            placeholder="Search name, alias, domain, contact, or preference"
            query={query}
            totalCount={listableCompanies.length}
            visibleCount={filteredCompanies.length}
          />
          {filteredCompanies.length === 0 ? (
            <CollectionNoMatches
              noun="companies"
              onClear={() => setQuery("")}
              query={query}
            />
          ) : (
            <>
              <div className="grid gap-3 xl:grid-cols-2">
                {pagedCompanies.map((company) => (
                  <CompanyCard
                    company={company}
                    isMutationPending={props.isMutationPending(company.id)}
                    isPreferencePending={props.isPreferencePending(company.id)}
                    jobById={jobById}
                    jobs={props.discoveryJobs}
                    key={company.id}
                    onNavigate={props.onNavigate}
                    onSetPreference={(preference) => {
                      void props.onSetCompanyPreference({
                        companyId: company.id,
                        preference,
                      });
                    }}
                  />
                ))}
              </div>
              <CollectionPagination
                itemLabel="companies"
                onPageChange={setPage}
                page={currentPage}
                pageSize={COLLECTION_PAGE_SIZE}
                totalCount={filteredCompanies.length}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
