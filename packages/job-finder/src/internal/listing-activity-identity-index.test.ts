import { expect, test } from "vitest";
import { createSeed } from "../workspace-service.test-support";
import { createListingActivityIdentityIndex } from "./listing-activity-identity-index";

test("status-only changes reuse identity resolutions and inventory changes invalidate ambiguity", () => {
  const base = createSeed().savedJobs[0]!;
  const job = Object.freeze({ ...base, id: "listing-one" });
  const identity = Object.freeze({ ...job });
  const index = createListingActivityIdentityIndex();
  const first = index.sync([job]).resolve(identity);
  expect(first.status).toBe("matched");
  const hidden = Object.freeze({ ...job, status: "archived" as const });
  expect(index.sync([hidden]).resolve(identity)).toBe(first);
  const duplicate = Object.freeze({ ...job, id: "listing-two" });
  expect(index.sync([hidden, duplicate]).resolve(identity).status).toBe(
    "ambiguous",
  );
  expect(index.sync([hidden]).resolve(identity).status).toBe("matched");
  // No immutable-row cache is used for a caller-owned row changed in place.
  const mutable = {
    ...job,
    canonicalUrl: "https://example.test/jobs/new",
    sourceJobId: "new-id",
  };
  const before = index.sync([mutable]).resolve(Object.freeze({ ...mutable }));
  mutable.company = "Updated company";
  const after = index.sync([mutable]).resolve(Object.freeze({ ...mutable }));
  expect(after).not.toBe(before);
  expect(after.status).toBe("matched");
});
