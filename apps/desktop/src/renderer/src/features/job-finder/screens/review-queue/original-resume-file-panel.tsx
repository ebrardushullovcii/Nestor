import { useEffect, useState } from "react";
import type {
  CandidateAssetListResult,
  ResumeSourceDocument,
} from "@nestor/contracts";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@renderer/components/ui/card";
import { Button } from "@renderer/components/ui/button";
import { formatDateOnly } from "@renderer/features/job-finder/lib/job-finder-utils";

export function OriginalResumeFilePanel({
  source,
}: {
  source?: ResumeSourceDocument | undefined;
}) {
  const [file, setFile] =
    useState<CandidateAssetListResult["originalResumeFile"]>(null);
  const [status, setStatus] = useState<string | null>(null);
  const sourceId = source?.id;
  useEffect(() => {
    let active = true;
    setFile(null);
    setStatus(null);
    if (sourceId)
      void window.nestor.jobFinder
        .listCandidateAssets({
          includeDeleted: false,
          resumeSourceId: sourceId,
        })
        .then((result) => {
          if (active) {
            setFile(result.originalResumeFile ?? null);
            if (!result.originalResumeFile)
              setStatus(
                "Original file unavailable. Import it again in Profile.",
              );
          }
        })
        .catch(() => {
          if (active) setStatus("Could not load the original file. Try again.");
        });
    return () => {
      active = false;
    };
  }, [sourceId]);
  async function openFile() {
    if (!file) return;
    try {
      const result = await window.nestor.jobFinder.openCandidateAsset({
        assetId: file.id,
      });
      setStatus(
        result.outcome === "opened"
          ? null
          : "Could not open the original file. Try again.",
      );
    } catch {
      setStatus("Could not open the original file. Try again.");
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {file?.fileName ?? source?.fileName ?? "Original resume"}
        </CardTitle>
        <CardDescription>
          {file
            ? `${file.fileType} · ${(file.byteSize / 1024).toFixed(1)} KB · Imported ${formatDateOnly(file.importedAt)}`
            : (status ?? "Loading original file…")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="secondary"
          disabled={!file}
          onClick={() => void openFile()}
        >
          Open file
        </Button>
        {file && status ? <p role="status">{status}</p> : null}
      </CardContent>
    </Card>
  );
}
