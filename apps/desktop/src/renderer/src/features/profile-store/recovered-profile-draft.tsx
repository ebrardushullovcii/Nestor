import { useEffect, useState } from "react";
import { ProfileRecordSchema, type ProfileEditsDraft } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";

const labels: Record<string, string> = {
  experiences: "Work history",
  spokenLanguages: "Languages",
  proofBank: "Evidence",
  employmentTypes: "Hours",
};
const label = (key: string) =>
  labels[key] ??
  key
    .split(".")
    .map((part) => {
      const words = part.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(" · ");
const value = (item: unknown): string => {
  if (Array.isArray(item))
    return item
      .filter((part: unknown): part is string => typeof part === "string")
      .join(", ");
  if (item === null || item === undefined) return "Cleared";
  return typeof item === "string" ||
    typeof item === "number" ||
    typeof item === "boolean"
    ? String(item)
    : "Updated";
};
function leaf(input: unknown, key: string): unknown {
  for (const part of key.split("."))
    input =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)[part]
        : undefined;
  return input;
}

/** A conflict never applies itself. The person can inspect and recover the kept changes. */
export function RecoveredProfileDraft({
  onRestored,
}: {
  onRestored: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProfileEditsDraft | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void window.nestor.jobs
      .run("get_profile_draft", {})
      .then((row) => {
        if (live) setDraft(row);
      })
      .catch((reason: unknown) => {
        if (live)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load kept edits.",
          );
      });
    return () => {
      live = false;
    };
  }, []);
  if (!draft) return error ? <p role="alert">{error}</p> : null;
  const edits = draft.edits;
  const rows = [
    ...Object.entries({
      ...edits.profile?.fields,
      ...edits.profile?.lists,
    }).map(([key, item]) => [`Profile · ${key}`, item] as const),
    ...Object.entries({ ...edits.goals?.fields, ...edits.goals?.lists }).map(
      ([key, item]) => [`Preferences · ${key}`, item] as const,
    ),
  ];
  const recordEdits = edits.upsert.map((row) => {
    const before = edits.expectedRecords.find(
      (expected) =>
        expected.collection === row.collection && expected.id === row.record.id,
    )?.value;
    const fields = Object.fromEntries(
      Object.entries(row.record).filter(
        ([key, item]) =>
          key !== "id" &&
          (!before ||
            JSON.stringify(leaf(before.record, key)) !== JSON.stringify(item)),
      ),
    );
    return { row, fields };
  });
  async function recover() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const [profile, goals] = await Promise.all([
        window.nestor.jobs.run("get_profile", {}),
        window.nestor.jobs.run("get_profile_goals", {}),
      ]);
      const expectedRecords = await Promise.all(
        edits.expectedRecords.map(async (row) => ({
          ...row,
          value: await window.nestor.jobs.run("get_profile_record", {
            collection: row.collection,
            id: row.id,
          }),
        })),
      );
      await window.nestor.jobs.run("commit_profile_edits", {
        ...edits,
        draftId: draft.id,
        requireCurrentDraft: true,
        expectedRecords,
        upsert: recordEdits.map(({ row, fields }) => {
          const current = expectedRecords.find(
            (expected) =>
              expected.collection === row.collection &&
              expected.id === row.record.id,
          )?.value;
          return current
            ? ProfileRecordSchema.parse({
                collection: row.collection,
                record: { ...current.record, ...fields },
              })
            : row;
        }),
        profile: edits.profile
          ? {
              ...edits.profile,
              expected: Object.fromEntries(
                Object.keys(edits.profile.fields).map((key) => [
                  key,
                  profile.fields[key as keyof typeof profile.fields],
                ]),
              ),
              expectedLists: Object.fromEntries(
                Object.keys(edits.profile.lists).map((key) => [
                  key,
                  profile.lists[key as keyof typeof profile.lists] ?? [],
                ]),
              ),
            }
          : undefined,
        goals: edits.goals
          ? {
              ...edits.goals,
              expected: Object.fromEntries(
                Object.keys(edits.goals.fields).map((key) => [
                  key,
                  leaf(goals, key),
                ]),
              ),
              expectedLists: Object.fromEntries(
                Object.keys(edits.goals.lists).map((key) => [
                  key,
                  leaf(goals, key) ?? [],
                ]),
              ),
            }
          : undefined,
        expectedWorkPermissions: edits.workPermissions
          ? profile.limitedWorkPermissions
          : undefined,
      });
      setDraft(null);
      await onRestored();
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not restore your edits.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside
      className="mb-4 rounded-lg border p-4"
      aria-label="Recovered profile edits"
    >
      <p>
        Your unsaved edits were kept. Review them before replacing the current
        saved values.
      </p>
      <details>
        <summary>Review kept changes</summary>
        <ul>
          {rows.map(([key, item]) => (
            <li key={key}>
              {label(key)}: {value(item)}
            </li>
          ))}
          {recordEdits.map(({ row, fields }) => (
            <li key={`${row.collection}:${row.record.id}`}>
              {label(row.collection)}:{" "}
              {Object.entries(fields)
                .map(([key, item]) => `${label(key)}: ${value(item)}`)
                .join(" · ")}
            </li>
          ))}
          {edits.remove.map((row) => (
            <li key={`${row.collection}:${row.id}`}>
              Remove one {label(row.collection)} record
            </li>
          ))}
          {edits.workPermissions ? (
            <li>
              Work permissions:{" "}
              {edits.workPermissions
                .map((row) => `${row.country}: ${row.conditions}`)
                .join("; ")}
            </li>
          ) : null}
        </ul>
      </details>
      {error ? <p role="alert">{error}</p> : null}
      <Button disabled={busy} onClick={() => void recover()}>
        Restore my edits
      </Button>
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void window.nestor.jobs
            .run("clear_profile_draft", { id: draft.id })
            .then(() => setDraft(null))
            .catch((reason: unknown) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not discard kept edits.",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        Discard kept edits
      </Button>
    </aside>
  );
}
