import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

const KEY_PREFIX = "nestor.job-finder.remembered.";
const MAX_LENGTH = 200;

function readRemembered<T extends string>(
  key: string,
  initial: T,
  isAllowed: (value: string) => value is T,
): T {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    return raw !== null && raw.length <= MAX_LENGTH && isAllowed(raw)
      ? raw
      : initial;
  } catch {
    return initial;
  }
}

/**
 * A list's search text, tab or filter that is still there after moving to
 * another screen and back, and after a restart. Only values `isAllowed`
 * accepts come back; anything else starts from `initial`.
 */
export function useRememberedString<T extends string>(
  key: string,
  initial: T,
  isAllowed: (value: string) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    readRemembered(key, initial, isAllowed),
  );
  useEffect(() => {
    try {
      if (value === initial) window.localStorage.removeItem(KEY_PREFIX + key);
      else
        window.localStorage.setItem(
          KEY_PREFIX + key,
          value.slice(0, MAX_LENGTH),
        );
    } catch {
      // The list still works when renderer storage is unavailable.
    }
  }, [initial, key, value]);
  return [value, setValue];
}

export const isAnyString = (_value: string): _value is string => true;
