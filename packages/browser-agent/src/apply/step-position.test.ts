import { expect, test } from "vitest";
import { readStepPosition } from "./page-hands";

test("a progress bar that names every step is read at its current step", () => {
  // Workday's (R8 J.D. Power): every step was reported as "Step 1 of 5".
  const body =
    "Software Engineer completed step 1 of 5 My Information current step 2 of 5 My Experience step 3 of 5 Application Questions step 4 of 5 Voluntary Disclosures step 5 of 5 Review";
  expect(readStepPosition(null, body)).toEqual({
    label: null,
    index: 2,
    total: 5,
  });
  expect(
    readStepPosition(
      null,
      "completed step 1 of 5 completed step 2 of 5 step 3 of 5 step 4 of 5",
    ),
  ).toMatchObject({ index: 3, total: 5 });
  expect(readStepPosition(null, "Step 2 of 4: Experience")).toMatchObject({
    index: 2,
    total: 4,
  });
  expect(readStepPosition("Step 3 of 6: Review", "")).toMatchObject({
    index: 3,
    total: 6,
  });
});
