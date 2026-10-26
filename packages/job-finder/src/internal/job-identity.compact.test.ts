import { expect, test, vi } from "vitest";
import {
  readDiscoveryPreparation,
  readPreparedSavedJobIdentity,
  writeDiscoveryPreparation,
} from "@nestor/contracts";
import { createSeed } from "../test-fixtures";
import { prepareDiscoveryPosting } from "./discovery-posting-preparation";
import { toSightingIdentityInput } from "./matching";
import {
  buildJobIdentityAliases,
  compactJobIdentity,
  createJobIdentityDigest,
  createJobIdentityIndex,
  hasEquivalentListingContentIdentity,
  prepareListingContent,
  prepareJobIdentity,
  type JobIdentityInput,
} from "./job-identity";

const posting: JobIdentityInput = {
  source: "target_site",
  sourceJobId: "synthetic",
  canonicalUrl: "https://example.test/one",
  applicationUrl: "https://example.test/apply/one",
  company: "Synthetic Company",
  location: "Remote",
  title: "Engineer",
  seniority: "Senior",
  postedAt: "2026-10-23T00:00:00Z",
  description:
    "The engineer designs and tests reliable software with a team across locations. ".repeat(
      100,
    ),
};

test("transferred compressed evidence owns only its used bytes", () => {
  const evidence = prepareListingContent(posting.description!);
  expect(evidence).not.toBeNull();
  expect(evidence!.packed.byteLength).toBeLessThan(16384);
  expect(evidence!.packed.buffer.byteLength).toBe(evidence!.packed.byteLength);
});

test("saved-job indexes retain compressed identity evidence without posting carriers or bodies", () => {
  const job = prepareDiscoveryPosting({
    ...createSeed().savedJobs[0]!,
    description: posting.description!,
  });
  writeDiscoveryPreparation(job, { normalizedPosting: { ...job } });
  Object.freeze(job);
  const identity = toSightingIdentityInput(job);
  expect(toSightingIdentityInput(job)).toBe(identity);
  expect(identity.description).toBeUndefined();
  const preparation = readDiscoveryPreparation(identity)!;
  expect(preparation.content).toBeUndefined();
  expect(preparation.fingerprints).toBeUndefined();
  expect(preparation.normalizedPosting).toBeUndefined();
  expect(preparation.identity!.basis).not.toContain(job.description);
  expect(hasEquivalentListingContentIdentity(job, identity)).toBe(true);
});

test("saved identity round trips without opening a stored body and invalidates changed evidence", () => {
  const job = prepareDiscoveryPosting({
    ...createSeed().savedJobs[0]!,
    description: posting.description!,
  });
  const expected = toSightingIdentityInput(job);
  const saved = readPreparedSavedJobIdentity(job)!;
  expect(saved).not.toBeNull();
  const lazy = { ...job };
  writeDiscoveryPreparation(lazy, { savedIdentity: { owner: lazy, value: saved } });
  Object.defineProperty(lazy, "description", {
    enumerable: true,
    get() { throw new Error("Stored identity opened the body"); },
  });
  Object.freeze(lazy);
  const actual = toSightingIdentityInput(lazy);
  expect(buildJobIdentityAliases(actual)).toEqual(buildJobIdentityAliases(expected));
  expect(hasEquivalentListingContentIdentity(actual, expected)).toBe(true);
  expect(actual.description).toBeUndefined();
  for (const change of [
    { title: "Different role" },
    { company: "Different company" },
    { canonicalUrl: "https://example.test/changed" },
    { description: "Different body" },
    { provenance: [...job.provenance, { ...job.provenance[0]!, listingUrl: "https://example.test/alternate" }] },
  ]) {
    const changed = { ...job, ...change };
    expect(readPreparedSavedJobIdentity(changed)).toBeNull();
    expect(buildJobIdentityAliases(toSightingIdentityInput(changed))).toEqual(
      buildJobIdentityAliases({ ...changed, alternateListingUrls: changed.provenance.flatMap((entry) => entry.listingUrl && entry.listingUrl !== changed.canonicalUrl ? [entry.listingUrl] : []), matchAcrossSources: true }),
    );
  }
});

test("compacting digest-only preparation releases its raw text too", () => {
  const source = { ...posting };
  prepareJobIdentity(source);
  expect(
    readDiscoveryPreparation(source)!.content!.value!.packed,
  ).toBeUndefined();
  const compact = compactJobIdentity(source);
  source.description = "Changed after preparing";
  expect(hasEquivalentListingContentIdentity(posting, compact)).toBe(true);
  expect(readDiscoveryPreparation(compact)!.identity!.basis).not.toContain(
    posting.description,
  );
});

test("equal packed evidence proves content without inflating, while a hash collision still reads and rejects", () => {
  const compact = compactJobIdentity(posting);
  const other = compactJobIdentity({
    ...posting,
    description:
      "Different responsibilities in a different engineering role. ".repeat(50),
  });
  const read = vi.fn(() => compact.exactContent!.read());
  const readOther = vi.fn(() => other.exactContent!.read());
  const left = { ...compact, exactContent: { ...compact.exactContent!, read } };
  const equal = {
    ...compact,
    exactContent: {
      ...compact.exactContent!,
      packed: Uint8Array.from(compact.exactContent!.packed!),
      read,
    },
  };
  expect(hasEquivalentListingContentIdentity(left, equal)).toBe(true);
  expect(read).not.toHaveBeenCalled();
  const collision = {
    ...other,
    exactContent: {
      ...other.exactContent!,
      digest: compact.exactContent!.digest,
      read: readOther,
    },
  };
  expect(hasEquivalentListingContentIdentity(left, collision)).toBe(false);
  expect(read).toHaveBeenCalledOnce();
  expect(readOther).toHaveBeenCalledOnce();
});

test("compressed inspection evidence preserves aliases, ids and full content verification", () => {
  const compact = compactJobIdentity(posting);
  expect(compact.description).toBeUndefined();
  expect(buildJobIdentityAliases(compact)).toEqual(
    buildJobIdentityAliases(posting),
  );
  expect(createJobIdentityDigest(compact)).toBe(
    createJobIdentityDigest(posting),
  );
  expect(hasEquivalentListingContentIdentity(posting, compact)).toBe(true);
  const row = { ...compact, id: "kept_identity" };
  const index = createJobIdentityIndex([row], (value) => value);
  expect(index.find(posting)).toBe(row);
  // Deliberately give different text the same alias: a digest match alone
  // still cannot merge two listings.
  const forged = {
    ...compact,
    canonicalUrl: null,
    applicationUrl: null,
    sourceJobId: null,
    exactContent: {
      digest: compact.exactContent!.digest,
      read: () => "Different evidence",
    },
  };
  expect(hasEquivalentListingContentIdentity(posting, forged)).toBe(false);
  expect(
    createJobIdentityIndex([{ ...forged, id: "other" }], (value) => value).find(
      {
        ...posting,
        canonicalUrl: null,
        applicationUrl: null,
        sourceJobId: null,
      },
    ),
  ).toBeNull();
});
