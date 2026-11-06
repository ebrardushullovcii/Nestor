import { expect, test } from "vitest";
import { screenKey } from "./form-replay";
import { buildApplyFormObservation } from "./page-hands";

test("a same-URL wizard's numbered body marker distinguishes screens without a step-label element", () => {
  const raw = {
    url: "https://replica.test/application",
    title: "Apply",
    bodyText: "Step 1 of 3: Contact",
    controls: [],
    actions: [],
    links: [],
    clickables: [],
    headings: [],
    openedTabs: [],
    validationErrors: [],
    loading: false,
    stepLabel: null,
  };
  const first = buildApplyFormObservation(raw, "2026-11-05T00:00:00Z");
  const second = buildApplyFormObservation(
    { ...raw, bodyText: "Step 2 of 3: Work preferences" },
    "2026-11-05T00:00:01Z",
  );
  expect(screenKey(first)).toBe("https://replica.test/application|Step 1 of 3");
  expect(screenKey(second)).toBe(
    "https://replica.test/application|Step 2 of 3",
  );
});
