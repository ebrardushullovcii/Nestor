import { useCallback, useEffect, useRef, useState } from "react";
import type { CandidateAsset, CandidateAssetKind } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { FormSelect } from "../form-select";
import { getJobFinderErrorDetail } from "../../lib/describe-failure";
import { ProfileSectionHeader } from "./profile-section-header";

/**
 * The extra files Job Finder may attach to an application when a form asks
 * for one: a portfolio, a transcript, a certificate, a work sample. It used to
 * be its own "Documents" destination with three pickers per import (type,
 * consent, retention) and a confirm dialog before Trash. Nobody went there on
 * their own, and every file imported there was imported in order to be
 * attached. It is a Profile tab now, with one choice (what the file is), one
 * button, and a reversible Remove.
 */

const kindOptions: readonly { value: CandidateAssetKind; label: string }[] = [
  { value: "portfolio", label: "Portfolio" },
  { value: "work_sample", label: "Work sample" },
  { value: "cover_letter", label: "Cover letter" },
  { value: "transcript", label: "Transcript" },
  { value: "certificate", label: "Certificate" },
  { value: "image", label: "Image" },
  { value: "other", label: "Other file" },
];

/** Fired by Applications when it approves a letter into the person's files. */
const PROFILE_FILES_CHANGED_EVENT = "nestor:candidate-assets-changed";

function formatByteSize(byteSize: number) {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${Math.round(byteSize / 1024)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(timestamp),
  );
}

function formatKind(kind: CandidateAssetKind): string {
  return (
    kindOptions.find((option) => option.value === kind)?.label ??
    kind.replaceAll("_", " ")
  );
}

export function ProfileFilesTab({
  requestedKind = null,
}: {
  /**
   * The kinds a link asked for (`?kind=portfolio,transcript`). The picker
   * starts on the first one the person has no file of yet.
   */
  requestedKind?: string | null;
} = {}) {
  const mountedRef = useRef(true);
  const [assets, setAssets] = useState<readonly CandidateAsset[]>([]);
  const requestedKinds = (requestedKind ?? "")
    .split(",")
    .flatMap((value) =>
      kindOptions.filter((option) => option.value === value.trim()),
    )
    .map((option) => option.value);
  const requestedKey = requestedKinds.join(",");
  // Arriving from a card that asked for a transcript starts on Transcript.
  const [kind, setKind] = useState<CandidateAssetKind>(
    () => requestedKinds[0] ?? "portfolio",
  );
  useEffect(() => {
    if (!requestedKey) return;
    const kinds = requestedKey.split(",") as CandidateAssetKind[];
    const held = new Set(
      assets
        .filter((asset) => asset.deletedAt === null)
        .map((asset) => asset.kind),
    );
    setKind(kinds.find((value) => !held.has(value)) ?? kinds[0]!);
  }, [requestedKey, assets]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [status, setStatus] = useState<string | null>(null);

  const refreshAssets = useCallback(async (message?: string) => {
    try {
      const result = await window.nestor.jobFinder.listCandidateAssets({
        includeDeleted: true,
      });
      if (!mountedRef.current) return false;
      setAssets(result.assets);
      setLoadState("ready");
      setStatus(message ?? null);
      return true;
    } catch {
      if (!mountedRef.current) return false;
      setLoadState("error");
      setStatus("Your files could not be loaded.");
      return false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshAssets();
    const onChanged = () => void refreshAssets();
    window.addEventListener(PROFILE_FILES_CHANGED_EVENT, onChanged);
    return () => {
      mountedRef.current = false;
      window.removeEventListener(PROFILE_FILES_CHANGED_EVENT, onChanged);
    };
  }, [refreshAssets]);

  async function addFile() {
    if (pendingAction) return;
    setPendingAction("import");
    setStatus(null);
    try {
      const result = await window.nestor.jobFinder.importCandidateAsset({
        kind,
        sensitivity: "sensitive",
        // Every file added here is added in order to be attached; the old
        // "only stored on this device" choice hid the file from every form.
        consentScope: "job_application_attachment",
        retention: "until_deleted",
      });
      if (result.status === "cancelled") {
        setStatus(null);
      } else {
        await refreshAssets(`Added ${result.asset.originalName}.`);
      }
    } catch (error) {
      setStatus(
        getJobFinderErrorDetail(error) ?? "That file could not be added.",
      );
    } finally {
      if (mountedRef.current) setPendingAction(null);
    }
  }

  async function removeFile(asset: CandidateAsset) {
    if (pendingAction) return;
    setPendingAction(asset.id);
    setStatus(null);
    try {
      await window.nestor.jobFinder.deleteCandidateAsset({
        assetId: asset.id,
      });
      await refreshAssets(
        `Removed ${asset.originalName}. Restore it within 7 days if you change your mind.`,
      );
    } catch {
      setStatus(`${asset.originalName} could not be removed. Try again.`);
    } finally {
      if (mountedRef.current) setPendingAction(null);
    }
  }

  async function openFile(asset: CandidateAsset) {
    setStatus(null);
    try {
      const result = await window.nestor.jobFinder.openCandidateAsset({
        assetId: asset.id,
      });
      if (result.outcome !== "opened") {
        setStatus(
          result.outcome === "not_found"
            ? `${asset.originalName} is no longer saved. Add it again if you still need it.`
            : `${asset.originalName} could not be opened on this device.`,
        );
      }
    } catch {
      setStatus(`${asset.originalName} could not be opened. Try again.`);
    }
  }

  async function restoreFile(asset: CandidateAsset) {
    if (pendingAction) return;
    setPendingAction(`restore:${asset.id}`);
    setStatus(null);
    try {
      const result = await window.nestor.jobFinder.restoreCandidateAsset({
        assetId: asset.id,
        retention: asset.retention,
      });
      await refreshAssets(`Restored ${result.asset.originalName}.`);
    } catch {
      setStatus(
        `${asset.originalName} could not be restored. The saved copy may be gone.`,
      );
    } finally {
      if (mountedRef.current) setPendingAction(null);
    }
  }

  const activeAssets = assets.filter((asset) => asset.deletedAt === null);
  const removedAssets = assets.filter(
    (asset) =>
      asset.deletedAt !== null &&
      Date.parse(asset.deletedAt) > Date.now() - 7 * 24 * 60 * 60 * 1_000,
  );
  const controlsDisabled = pendingAction !== null || loadState === "loading";

  return (
    <section className="grid content-start gap-(--gap-card)">
      <ProfileSectionHeader
        description="Extra files an application form may ask for: a portfolio, transcript, certificate, or work sample. When a form has a matching upload, Job Finder attaches the file for you. Your resume is handled above. Files are copied into Job Finder's own folder on this device."
        eyebrow="Files"
        title="Files for applications"
      />

      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <div className="grid min-w-0 gap-1.5 text-sm text-foreground-soft">
          <label htmlFor="profile-file-kind">What is the file?</label>
          <FormSelect
            disabled={controlsDisabled}
            onValueChange={(value) => setKind(value as CandidateAssetKind)}
            options={kindOptions}
            triggerId="profile-file-kind"
            value={kind}
          />
        </div>
        <Button
          disabled={controlsDisabled}
          onClick={() => void addFile()}
          pending={pendingAction === "import"}
          type="button"
          variant="secondary"
        >
          Add a file
        </Button>
        {loadState === "error" ? (
          <Button
            disabled={pendingAction !== null}
            onClick={() => void refreshAssets()}
            size="compact"
            type="button"
            variant="ghost"
          >
            Retry
          </Button>
        ) : null}
      </div>

      {status ? (
        <p
          aria-live="polite"
          className="min-w-0 break-words text-(length:--text-description) text-foreground-soft"
          role="status"
        >
          {status}
        </p>
      ) : null}

      {loadState === "ready" && activeAssets.length === 0 ? (
        <p className="rounded-(--radius-field) border border-dashed border-(--border-strong) px-4 py-3 text-sm leading-6 text-foreground-soft">
          No files yet. Add one only if the applications you go for ask for it;
          most forms need just the resume.
        </p>
      ) : null}

      {activeAssets.length > 0 ? (
        <ul aria-label="Your files" className="grid gap-2">
          {activeAssets.map((asset) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3 py-3"
              key={asset.id}
            >
              <div className="min-w-0">
                <p className="min-w-0 break-words text-sm font-semibold text-(--text-headline)">
                  {asset.originalName}
                </p>
                <p className="text-(length:--text-description) text-foreground-soft">
                  {formatKind(asset.kind)} · {formatByteSize(asset.byteSize)} ·
                  Added {formatDate(asset.createdAt)}
                </p>
                {asset.forJob ? (
                  <p className="text-(length:--text-description) text-foreground-soft">
                    Written for {asset.forJob.title} at {asset.forJob.company};
                    only attached to that application.
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  aria-label={`Open ${asset.originalName}`}
                  disabled={controlsDisabled}
                  onClick={() => void openFile(asset)}
                  size="compact"
                  type="button"
                  variant="ghost"
                >
                  Open
                </Button>
                <Button
                  aria-label={`Remove ${asset.originalName}`}
                  disabled={controlsDisabled}
                  onClick={() => void removeFile(asset)}
                  pending={pendingAction === asset.id}
                  size="compact"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {removedAssets.length > 0 ? (
        <div className="grid min-w-0 gap-2 border-t border-(--surface-panel-border) pt-4">
          <h3 className="text-sm font-semibold text-(--text-headline)">
            Removed
          </h3>
          <p className="text-(length:--text-description) text-foreground-soft">
            Removed files are not attached to anything. Each one is deleted for
            good seven days after it was removed.
          </p>
          <ul aria-label="Removed files" className="grid gap-2">
            {removedAssets.map((asset) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3 py-3"
                key={asset.id}
              >
                <div className="min-w-0">
                  <p className="min-w-0 break-words text-sm font-semibold text-(--text-headline)">
                    {asset.originalName}
                  </p>
                  <p className="text-(length:--text-description) text-foreground-soft">
                    {formatKind(asset.kind)}
                    {asset.lifecycle?.purgeAt
                      ? ` · Deleted for good on ${formatDate(asset.lifecycle.purgeAt)}`
                      : ""}
                  </p>
                </div>
                <Button
                  aria-label={`Restore ${asset.originalName}`}
                  disabled={controlsDisabled}
                  onClick={() => void restoreFile(asset)}
                  pending={pendingAction === `restore:${asset.id}`}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
