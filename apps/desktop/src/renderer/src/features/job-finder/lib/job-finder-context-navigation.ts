export const JOB_FINDER_CONTEXT_QUERY_KEYS = {
  applicationRecordId: "applicationRecordId",
  jobId: "jobId",
  targetId: "targetId",
} as const;

export type JobFinderContextQueryKey =
  (typeof JOB_FINDER_CONTEXT_QUERY_KEYS)[keyof typeof JOB_FINDER_CONTEXT_QUERY_KEYS];

export type JobFinderNavigationContext = {
  applicationRecordId: string | null;
  jobId: string | null;
  targetId: string | null;
};

export type JobFinderContextRouteQuery = Partial<JobFinderNavigationContext>;

export function selectJobFinderContext<T>(
  entries: readonly T[],
  requestedId: string | null,
  selectedId: string | null | undefined,
  getId: (entry: T) => string,
): T | null {
  if (requestedId) {
    return entries.find((entry) => getId(entry) === requestedId) ?? null;
  }

  return (
    entries.find((entry) => getId(entry) === selectedId) ?? entries[0] ?? null
  );
}

export function buildJobFinderContextRoute(
  path: string,
  context: JobFinderContextRouteQuery,
): string {
  const [pathnamePart, existingSearch = ""] = path.split("?", 2);
  const pathname = pathnamePart ?? path;
  const search = new URLSearchParams(existingSearch);

  setContextQueryValue(
    search,
    JOB_FINDER_CONTEXT_QUERY_KEYS.applicationRecordId,
    context.applicationRecordId,
  );
  setContextQueryValue(
    search,
    JOB_FINDER_CONTEXT_QUERY_KEYS.jobId,
    context.jobId,
  );
  setContextQueryValue(
    search,
    JOB_FINDER_CONTEXT_QUERY_KEYS.targetId,
    context.targetId,
  );

  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function readJobFinderNavigationContext(
  search: URLSearchParams,
): JobFinderNavigationContext {
  return {
    applicationRecordId: readContextQueryValue(
      search,
      JOB_FINDER_CONTEXT_QUERY_KEYS.applicationRecordId,
    ),
    jobId: readContextQueryValue(search, JOB_FINDER_CONTEXT_QUERY_KEYS.jobId),
    targetId: readContextQueryValue(
      search,
      JOB_FINDER_CONTEXT_QUERY_KEYS.targetId,
    ),
  };
}

export function clearJobFinderContextQuery(
  search: URLSearchParams,
  key: JobFinderContextQueryKey,
): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete(key);
  return next;
}

function setContextQueryValue(
  search: URLSearchParams,
  key: JobFinderContextQueryKey,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined || value.length === 0) {
    search.delete(key);
    return;
  }

  search.set(key, value);
}

function readContextQueryValue(
  search: URLSearchParams,
  key: JobFinderContextQueryKey,
): string | null {
  const value = search.get(key)?.trim() ?? "";
  return value.length > 0 ? value : null;
}
