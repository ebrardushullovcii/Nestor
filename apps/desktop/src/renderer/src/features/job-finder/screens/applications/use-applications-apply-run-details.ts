import { useCallback, useEffect, useRef, useState } from "react";
import type { ApplyRunDetails } from "@nestor/contracts";
import { pickLatestIsoTimestamp } from "./applications-screen-helpers";

interface UseApplicationsApplyRunDetailsInput {
  applicationRecordId: string | null;
  jobId: string | null;
  onGetApplyRunDetails: (input: {
    runId: string;
    jobId: string;
    applicationRecordId: string;
  }) => Promise<ApplyRunDetails>;
  runId: string | null;
  runUpdatedAt: string | null;
}

export function useApplicationsApplyRunDetails(
  input: UseApplicationsApplyRunDetailsInput,
) {
  const {
    applicationRecordId,
    jobId,
    onGetApplyRunDetails,
    runId,
    runUpdatedAt,
  } = input;
  const [applyRunDetails, setApplyRunDetails] =
    useState<ApplyRunDetails | null>(null);
  const [applyRunDetailsTarget, setApplyRunDetailsTarget] = useState<{
    applicationRecordId: string;
    jobId: string;
    runId: string;
    runUpdatedAt: string | null;
  } | null>(null);
  const [applyRunDetailsStatus, setApplyRunDetailsStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [applyRunDetailsError, setApplyRunDetailsError] = useState<
    string | null
  >(null);
  const lastFetchedApplyRunRef = useRef<{
    applicationRecordId: string;
    jobId: string;
    runId: string;
    updatedAt: string | null;
  } | null>(null);
  const statusRef = useRef(applyRunDetailsStatus);
  const targetRef = useRef(applyRunDetailsTarget);

  useEffect(() => {
    statusRef.current = applyRunDetailsStatus;
    targetRef.current = applyRunDetailsTarget;
  }, [applyRunDetailsStatus, applyRunDetailsTarget]);

  useEffect(() => {
    let cancelled = false;

    if (!applicationRecordId || !jobId || !runId) {
      lastFetchedApplyRunRef.current = null;
      setApplyRunDetails(null);
      setApplyRunDetailsTarget(null);
      setApplyRunDetailsStatus("idle");
      setApplyRunDetailsError(null);
      return () => {
        cancelled = true;
      };
    }

    const currentTarget = targetRef.current;
    const currentStatus = statusRef.current;
    const lastFetchedUpdatedAt = lastFetchedApplyRunRef.current?.updatedAt;
    const selectedRunUpdatedAtMs =
      runUpdatedAt == null ? Number.NaN : Date.parse(runUpdatedAt);
    const lastFetchedUpdatedAtMs =
      lastFetchedUpdatedAt == null
        ? Number.NaN
        : Date.parse(lastFetchedUpdatedAt);
    const hasValidParsedUpdatedAt =
      !Number.isNaN(selectedRunUpdatedAtMs) &&
      !Number.isNaN(lastFetchedUpdatedAtMs);

    if (
      lastFetchedApplyRunRef.current?.jobId === jobId &&
      lastFetchedApplyRunRef.current?.applicationRecordId ===
        applicationRecordId &&
      lastFetchedApplyRunRef.current?.runId === runId &&
      currentTarget?.jobId === jobId &&
      currentTarget?.applicationRecordId === applicationRecordId &&
      currentTarget?.runId === runId &&
      currentTarget?.runUpdatedAt === runUpdatedAt &&
      (runUpdatedAt == null ||
        (lastFetchedUpdatedAt != null &&
          hasValidParsedUpdatedAt &&
          selectedRunUpdatedAtMs <= lastFetchedUpdatedAtMs))
    ) {
      return () => {
        cancelled = true;
      };
    }

    if (
      currentStatus === "loading" &&
      currentTarget?.jobId === jobId &&
      currentTarget?.applicationRecordId === applicationRecordId &&
      currentTarget?.runId === runId &&
      currentTarget?.runUpdatedAt === runUpdatedAt
    ) {
      return () => {
        cancelled = true;
      };
    }

    setApplyRunDetails(null);
    setApplyRunDetailsTarget({
      applicationRecordId,
      jobId,
      runId,
      runUpdatedAt,
    });
    setApplyRunDetailsStatus("loading");
    setApplyRunDetailsError(null);

    void onGetApplyRunDetails({ runId, jobId, applicationRecordId })
      .then((details) => {
        if (cancelled) {
          return;
        }

        lastFetchedApplyRunRef.current = {
          applicationRecordId,
          jobId,
          runId,
          updatedAt: pickLatestIsoTimestamp(
            details.run.updatedAt,
            details.result?.updatedAt,
            runUpdatedAt,
          ),
        };
        setApplyRunDetails(details);
        setApplyRunDetailsStatus("ready");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        lastFetchedApplyRunRef.current = null;
        setApplyRunDetails(null);
        setApplyRunDetailsTarget(null);
        setApplyRunDetailsStatus("error");
        setApplyRunDetailsError(
          error instanceof Error
            ? error.message
            : "Apply run details could not be loaded.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [applicationRecordId, jobId, onGetApplyRunDetails, runId, runUpdatedAt]);

  const replaceApplyRunDetails = useCallback((details: ApplyRunDetails) => {
    const nextJobId = details.result?.jobId ?? details.run.jobIds[0] ?? null;
    const nextApplicationRecordId = details.result?.applicationRecordId ?? null;
    if (!nextJobId || !nextApplicationRecordId) {
      return;
    }
    const updatedAt = pickLatestIsoTimestamp(
      details.run.updatedAt,
      details.result?.updatedAt,
    );
    lastFetchedApplyRunRef.current = {
      applicationRecordId: nextApplicationRecordId,
      jobId: nextJobId,
      runId: details.run.id,
      updatedAt,
    };
    setApplyRunDetails(details);
    setApplyRunDetailsTarget({
      applicationRecordId: nextApplicationRecordId,
      jobId: nextJobId,
      runId: details.run.id,
      runUpdatedAt: updatedAt,
    });
    setApplyRunDetailsStatus("ready");
    setApplyRunDetailsError(null);
  }, []);

  return {
    applyRunDetails,
    applyRunDetailsError,
    applyRunDetailsStatus,
    applyRunDetailsTarget,
    replaceApplyRunDetails,
  };
}
