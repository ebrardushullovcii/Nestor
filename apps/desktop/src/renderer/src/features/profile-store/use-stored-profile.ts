import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProfileOverview,
  ProfileRecordCollection,
  ProfileRecordPage,
  JobSearchPreferences,
  CommitProfileEditsInput,
} from "@nestor/contracts";

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
  const save = useCallback(async (input: CommitProfileEditsInput) => {
    setSaving(true);
    try {
      const next = await window.nestor.jobs.run("commit_profile_edits", input);
      if (live.current) {
        setOverview(next.profile);
        setGoals(next.goals);
        setError(null);
      }
      return true;
    } catch (reason: unknown) {
      if (live.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not save your profile.",
        );
      return false;
    } finally {
      if (live.current) setSaving(false);
    }
  }, []);
  return { overview, goals, error, saving, save, refresh };
}
const EMPTY: ProfileRecordPage = { rows: [], total: 0, nextCursor: null };
export function useProfileRecordPage(
  collection: ProfileRecordCollection,
  enabled = true,
) {
  const [text, setText] = useState(""),
    [cursors, setCursors] = useState([0]),
    [index, setIndex] = useState(0),
    [page, setPage] = useState(EMPTY),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const after = cursors[index] ?? 0;
  useEffect(() => {
    setCursors([0]);
    setIndex(0);
  }, [collection, text]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    void window.nestor.jobs
      .run("list_profile_records", { collection, text, after, limit: 25 })
      .then((next) => {
        if (live) {
          setPage(next);
          setError(null);
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load these records.",
          );
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [collection, enabled, text, after, revision]);
  useEffect(
    () =>
      window.nestor.jobs.onChange((change) => {
        if (change.cause === "profile") setRevision((value) => value + 1);
      }),
    [],
  );
  return {
    ...page,
    text,
    setText,
    index,
    loading,
    error,
    previous: () => setIndex((value) => Math.max(0, value - 1)),
    next: () => {
      if (page.nextCursor !== null) {
        setCursors((old) => [...old.slice(0, index + 1), page.nextCursor!]);
        setIndex((value) => value + 1);
      }
    },
  };
}
