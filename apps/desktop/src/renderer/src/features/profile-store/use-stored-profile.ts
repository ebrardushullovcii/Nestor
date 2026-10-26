import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProfileOverview,
  ProfileRecord,
  ProfileRecordCollection,
  ProfileRecordPage,
  JobSearchPreferences,
  CommitProfileEditsInput,
} from "@nestor/contracts";
import { getJobFinderErrorDetail } from "@renderer/features/job-finder/lib/describe-failure";

/** Personal fields have a small read. History is fetched only in requested pages. */
export function useStoredProfile() {
  const [overview, setOverview] = useState<ProfileOverview | null>(null),
    [goals, setGoals] = useState<JobSearchPreferences | null>(null),
    [error, setError] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  const live = useRef(true),
    request = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++request.current;
    try {
      const [next, nextGoals] = await Promise.all([
        window.nestor.jobs.run("get_profile", {}),
        window.nestor.jobs.run("get_profile_goals", {}),
      ]);
      if (live.current && request.current === seq) {
        setOverview(next);
        setGoals(nextGoals);
        setError(null);
      }
    } catch (reason: unknown) {
      if (live.current && request.current === seq)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load your profile.",
        );
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void refresh();
    const off = window.nestor.jobs.onChange((change) => {
      if (change.cause === "profile") void refresh();
    });
    return () => {
      live.current = false;
      request.current++;
      off();
    };
  }, [refresh]);
  const save = useCallback(
    async (input: CommitProfileEditsInput) => {
      setSaving(true);
      try {
        await window.nestor.jobs.run("commit_profile_edits", input);
        await refresh();
        return true;
      } catch (reason: unknown) {
        if (live.current)
          // The store explains a refused save (a conflict, a bad range) in
          // its own words; only the IPC wrapper around them is dropped.
          setError(
            getJobFinderErrorDetail(reason) ?? "Could not save your profile.",
          );
        return false;
      } finally {
        if (live.current) setSaving(false);
      }
    },
    [refresh],
  );
  return { overview, goals, error, saving, save, refresh };
}
const EMPTY: ProfileRecordPage = { rows: [], total: 0, nextCursor: null };
export function useProfileRecordPage(
  collection: ProfileRecordCollection,
  enabled = true,
) {
  const [query, setQuery] = useState({ text: "", cursors: [0], index: 0 });
  const { text, cursors, index } = query;
  const after = cursors[index] ?? 0;
  const queryKey = `${collection}:${text}:${after}`;
  const [result, setResult] = useState({ page: EMPTY, key: "" });
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void window.nestor.jobs
      .run("list_profile_records", { collection, text, after, limit: 25 })
      .then((page) => {
        if (!live) return;
        // Removing the final row on a later page returns to the preceding page.
        if (page.rows.length === 0 && index > 0) {
          setQuery((previous) => ({
            ...previous,
            index: Math.max(0, previous.index - 1),
          }));
        } else setResult({ page, key: queryKey });
        setError(null);
      })
      .catch((reason: unknown) => {
        if (live) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load these records.",
          );
        }
      });
    return () => {
      live = false;
    };
  }, [collection, enabled, text, after, index, revision, queryKey]);
  useEffect(
    () =>
      window.nestor.jobs.onChange((change) => {
        if (change.cause === "profile") setRevision((value) => value + 1);
      }),
    [],
  );
  return {
    ...result.page,
    collection,
    text,
    index,
    error,
    loading: enabled && !error && result.key !== queryKey,
    refresh: () => setRevision((value) => value + 1),
    setText: (value: string) =>
      setQuery({ text: value, cursors: [0], index: 0 }),
    previous: () =>
      setQuery((previous) => ({
        ...previous,
        index: Math.max(0, previous.index - 1),
      })),
    next: () => {
      const cursor = result.page.nextCursor;
      if (cursor !== null)
        setQuery((previous) => ({
          ...previous,
          cursors: [...previous.cursors.slice(0, previous.index + 1), cursor],
          index: previous.index + 1,
        }));
    },
  };
}

const RECORD_COLLECTIONS = [
  "experiences",
  "education",
  "certifications",
  "links",
  "projects",
  "spokenLanguages",
  "proofBank",
] as const satisfies readonly ProfileRecordCollection[];

/**
 * Every record of every collection, for guided setup, which edits the whole
 * profile at once. Read again after each profile change.
 */
export function useAllProfileRecords(revision: unknown) {
  const [records, setRecords] = useState<Partial<
    Record<ProfileRecordCollection, ProfileRecord[]>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const readAll = async (collection: ProfileRecordCollection) => {
      const rows: ProfileRecord[] = [];
      let after = 0;
      for (;;) {
        const page = await window.nestor.jobs.run("list_profile_records", {
          collection,
          after,
          limit: 100,
        });
        rows.push(...page.rows);
        if (page.nextCursor === null) return rows;
        after = page.nextCursor;
      }
    };
    void Promise.all(
      RECORD_COLLECTIONS.map(
        async (collection) => [collection, await readAll(collection)] as const,
      ),
    ).then(
      (entries) => {
        if (!live) return;
        setRecords(Object.fromEntries(entries));
        setError(null);
      },
      (reason: unknown) => {
        if (live)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load your profile records.",
          );
      },
    );
    return () => {
      live = false;
    };
  }, [revision]);
  return { records, error };
}
