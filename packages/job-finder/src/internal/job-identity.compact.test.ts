import { expect, test } from "vitest";
import {
  buildJobIdentityAliases,
  compactJobIdentity,
  createJobIdentityDigest,
  createJobIdentityIndex,
  hasEquivalentListingContentIdentity,
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
