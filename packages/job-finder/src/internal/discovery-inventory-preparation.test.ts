import { afterEach, expect, test } from "vitest";
import {
  SavedJobSchema,
  type DiscoveryInventoryPosting,
} from "@nestor/contracts";
import {
  runDiscoveryCpuTask,
  warmDiscoveryInventory,
} from "./discovery-inventory-preparation";
import { setDiscoveryInventoryExecutor } from "./discovery-feed-executor";
import { createMatchAssessmentPostingInput } from "./match-assessment-posting-input";
import { createMatchAssessmentPostingFingerprint } from "./match-assessment-session";
import { buildJobIdentityAliases, compactJobIdentity } from "./job-identity";
import { createSeed } from "../workspace-service.test-fixtures";

afterEach(() => setDiscoveryInventoryExecutor(null));
test("inventory preparation preserves exact assessment fingerprints, source aliases and content evidence", async () => {
  const seed = createSeed();
  const job = SavedJobSchema.parse(seed.savedJobs?.[0]);
  job.description =
    "The engineer designs and tests reliable software with a team across locations. ".repeat(
      20,
    );
  const facts: DiscoveryInventoryPosting = {
    ...createMatchAssessmentPostingInput(job),
    source: job.source,
    sourceJobId: job.sourceJobId,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl,
    providerKey: job.providerKey,
    providerBoardToken: job.providerBoardToken,
    providerIdentifier: job.providerIdentifier,
    postedAt: job.postedAt,
    postedAtText: job.postedAtText,
    alternateListingUrls: ["https://example.test/alternate/job"],
  };
  const fingerprint = createMatchAssessmentPostingFingerprint(job);
  const response = await runDiscoveryCpuTask({
    kind: "inventory",
    postings: [facts],
  });
  expect(response.kind).toBe("inventory");
  if (response.kind !== "inventory") throw new Error("Unexpected response");
  expect(response.result[0]?.postingFingerprint).toBe(fingerprint);
  expect(response.result[0]?.aliases.acrossSources).toEqual(
    buildJobIdentityAliases({ ...facts, matchAcrossSources: true }),
  );
  expect(response.result[0]?.content?.digest).toBe(
    compactJobIdentity(job).exactContent?.digest,
  );
  Object.freeze(job);
  setDiscoveryInventoryExecutor(async (postings) => {
    const prepared = await runDiscoveryCpuTask({ kind: "inventory", postings });
    if (prepared.kind !== "inventory") throw new Error("Unexpected response");
    return prepared.result;
  });
  await warmDiscoveryInventory([job], new AbortController().signal);
  expect(createMatchAssessmentPostingFingerprint(job)).toBe(fingerprint);
});
