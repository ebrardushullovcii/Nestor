import type {
  JobFinderSettings,
  PatchSettingsInput,
  SettingsFields,
  ResumeApproach,
  UpdateAiBehaviorInput,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import { SettingsFieldsSchema, SettingsListsSchema } from "@nestor/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

function leaf(value: unknown, path: string): unknown {
  for (const part of path.split("."))
    value =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[part]
        : undefined;
  return value;
}
/** Only supplied setting leaves cross IPC; untouched siblings never become a save payload. */
export function settingPatch(
  input: unknown,
  previous?: JobFinderSettings | null,
): PatchSettingsInput {
  const changed = ([key, value]: [string, unknown]) =>
    value !== undefined &&
    (!previous ||
      JSON.stringify(value) !== JSON.stringify(leaf(previous, key)));
  return {
    fields: SettingsFieldsSchema.parse(
      Object.fromEntries(
        Object.keys(SettingsFieldsSchema.shape)
          .map((key) => [key, leaf(input, key)])
          .filter(changed),
      ),
    ),
    lists: SettingsListsSchema.parse(
      Object.fromEntries(
        Object.keys(SettingsListsSchema.shape)
          .map((key) => [key, leaf(input, key)])
          .filter(changed),
      ),
    ),
  };
}
export function useStoredSettings() {
  const [settings, setSettings] = useState<JobFinderSettings | null>(null),
    [error, setError] = useState<string | null>(null);
  const current = useRef(settings);
  current.current = settings;
  const sequence = useRef(0),
    mounted = useRef(true);
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const next = await window.nestor.jobs.run("get_settings", {});
      if (mounted.current && sequence.current === seq) {
        setSettings(next);
        setError(null);
      }
    } catch (reason: unknown) {
      if (mounted.current && sequence.current === seq)
        setError(
          reason instanceof Error ? reason.message : "Could not load Settings.",
        );
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const off = window.nestor.jobs.onChange((change) => {
      if (change.cause === "settings") void refresh();
    });
    return () => {
      mounted.current = false;
      sequence.current++;
      off();
    };
  }, [refresh]);
  const patch = useCallback(
    async (input: PatchSettingsInput): Promise<boolean> => {
      const expected: SettingsFields = SettingsFieldsSchema.parse(
        Object.fromEntries(
          Object.keys(input.fields ?? {}).map((key) => [
            key,
            leaf(current.current, key),
          ]),
        ),
      );
      try {
        const next = await window.nestor.jobs.run("patch_settings", {
          ...input,
          expected,
        });
        if (mounted.current) {
          sequence.current++;
          current.current = next;
          setSettings(next);
          setError(null);
        }
        return true;
      } catch (reason: unknown) {
        if (mounted.current)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not save Settings.",
          );
        return false;
      }
    },
    [],
  );
  const updateResumeApproach = useCallback(async (approach: ResumeApproach) => {
    try {
      const next = await window.nestor.jobs.run("set_resume_approach", {
        approach,
      });
      if (mounted.current) {
        sequence.current++;
        current.current = next.settings;
        setSettings(next.settings);
        setError(null);
      }
      return true;
    } catch (reason: unknown) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not save the resume level.",
        );
      return false;
    }
  }, []);
  const updateAiBehavior = useCallback(
    async (input: UpdateAiBehaviorInput) => {
      if (input.resumeApproach) {
        if (!(await updateResumeApproach(input.resumeApproach))) return false;
      }
      return patch(settingPatch(input, current.current));
    },
    [patch, updateResumeApproach],
  );
  return {
    settings,
    error,
    refresh,
    updateResumeApproach,
    updateAppearanceTheme: useCallback(
      (appearanceTheme: JobFinderSettings["appearanceTheme"]) =>
        patch({ fields: { appearanceTheme } }),
      [patch],
    ),
    updateApplicationDefaults: useCallback(
      (input: UpdateApplicationDefaultsInput) =>
        patch(settingPatch(input, current.current)),
      [patch],
    ),
    updateWorkspaceBehavior: useCallback(
      (input: UpdateWorkspaceBehaviorInput) =>
        patch(settingPatch(input, current.current)),
      [patch],
    ),
    updateAiBehavior,
  };
}
