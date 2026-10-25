if (process.env.JOB_FINDER_LOCAL_REPLICA === "1") {
  const { runReplicaHarness } =
    await import("./test-job-finder-replica-apply.mjs");
  await runReplicaHarness("complete-flow");
  process.exit(0);
}

const boardToken =
  process.env.JOB_FINDER_COMPLETE_FLOW_BOARD_TOKEN ?? "gleanwork";
const preferredTitle =
  process.env.JOB_FINDER_COMPLETE_FLOW_TITLE ?? "Software Engineer";

const response = await fetch(
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`,
);

if (!response.ok) {
  throw new Error(
    `Greenhouse board lookup failed with status ${response.status}.`,
  );
}

const payload = await response.json();
const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
const selectedJob =
  jobs.find(
    (job) =>
      typeof job?.title === "string" &&
      job.title.toLowerCase() === preferredTitle.toLowerCase() &&
      typeof job?.absolute_url === "string",
  ) ??
  jobs.find(
    (job) =>
      typeof job?.title === "string" &&
      /\bsoftware engineer\b/iu.test(job.title) &&
      typeof job?.absolute_url === "string",
  );

if (!selectedJob) {
  throw new Error(
    `No current Software Engineer vacancy was available on Greenhouse board '${boardToken}'.`,
  );
}

const authorizedWriteDiagnostic =
  process.env.JOB_FINDER_COMPLETE_FLOW_AUTHORIZED_WRITE_DIAGNOSTIC === "1";
const baseLabel =
  process.env.JOB_FINDER_PREPARE_ONLY_LABEL ??
  "complete-flow-current-greenhouse";

if (authorizedWriteDiagnostic) {
  process.env.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES = "1";
  process.env.JOB_FINDER_PREPARE_ONLY_LABEL = /diagnostic[-_]only/u.test(
    baseLabel,
  )
    ? baseLabel
    : `${baseLabel}-diagnostic-only`;
} else {
  process.env.JOB_FINDER_PREPARE_ONLY_LABEL = baseLabel;
  process.env.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES = "0";
  process.stdout.write(
    `${baseLabel}: strict prepare-only mode leaves intermediate ATS writes unauthorized, so resume upload autosave stays blocked and resumeUploadVerified is not expected evidence.\n`,
  );
}

process.env.JOB_FINDER_PREPARE_ONLY_EXPECT_EXACT_SOURCE_JOB = "1";
process.env.JOB_FINDER_PREPARE_ONLY_REQUIRE_FINAL_CHECKPOINT = "1";
process.env.JOB_FINDER_PREPARE_ONLY_RESUME_MODE =
  process.env.JOB_FINDER_PREPARE_ONLY_RESUME_MODE ?? "original_resume";
process.env.JOB_FINDER_PREPARE_ONLY_USE_LIVE_DISCOVERY_AI = "0";
process.env.JOB_FINDER_PREPARE_ONLY_SOURCE_ID = `target_greenhouse_${boardToken}_complete_flow`;
process.env.JOB_FINDER_PREPARE_ONLY_SOURCE_LABEL = `${boardToken} Greenhouse`;
process.env.JOB_FINDER_PREPARE_ONLY_SOURCE_URL = selectedJob.absolute_url;
process.env.JOB_FINDER_PREPARE_ONLY_TARGET_ROLES = selectedJob.title;

await import("./test-job-finder-prepare-only.mjs");
