import { useEffect, useRef, useState } from "react";

/** Coalesce typing, serialize writes, and flush the latest edit when leaving. */
export function useProfileAutosave<T>(input: {
  value: T | null;
  blocked: boolean;
  save: (value: T) => Promise<boolean | void> | void;
}) {
  const latest = useRef(input),
    mounted = useRef(true),
    pending = useRef(false),
    attempted = useRef<string | null>(null);
  latest.current = input;
  const [completed, setCompleted] = useState(0),
    [error, setError] = useState<string | null>(null);
  const key = input.value === null ? null : JSON.stringify(input.value);
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    const current = latest.current;
    if (pending.current || current.blocked || current.value === null) return;
    const fingerprint = JSON.stringify(current.value);
    if (fingerprint === attempted.current) return;
    attempted.current = fingerprint;
    pending.current = true;
    if (mounted.current) setError(null);
    void Promise.resolve()
      .then(() => current.save(current.value!))
      .then((ok) => {
        if (ok === false && mounted.current)
          setError("Your latest changes could not be saved.");
      })
      .catch((reason: unknown) => {
        if (mounted.current)
          setError(
            reason instanceof Error
              ? reason.message
              : "Your latest changes could not be saved.",
          );
      })
      .finally(() => {
        pending.current = false;
        if (mounted.current) setCompleted((version) => version + 1);
        else flush.current();
      });
  };
  useEffect(() => {
    if (key === null || input.blocked) return;
    const timer = setTimeout(() => flush.current(), 350);
    return () => clearTimeout(timer);
  }, [key, input.blocked, completed]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flush.current();
    };
  }, []);
  return {
    error,
    retry: () => {
      attempted.current = null;
      flush.current();
    },
  };
}
