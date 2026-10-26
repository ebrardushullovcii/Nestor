import { describe, expect, test } from "vitest";

import { describeApplicationPreparationProgress } from "./application-preparation-progress";

describe("application preparation progress", () => {
  test("names the form's step and says a slow or retried step carries on", () => {
    expect(
      describeApplicationPreparationProgress(
        'form step 2 of 5: fill_fields → Filled in "Phone". +1 555 0100',
      ),
    ).toBe("Step 2 of 5: filling in form fields");
    expect(
      describeApplicationPreparationProgress(
        "form step 3 of 6: asking the assistant what to do next",
      ),
    ).toBe("Step 3 of 6: thinking about the next form step");
    expect(
      describeApplicationPreparationProgress(
        "the assistant did not answer before this turn's time limit",
      ),
    ).toBe("The assistant is slow to answer; asking again");
    expect(
      describeApplicationPreparationProgress(
        "retrying the same assistant turn after a temporary service failure",
      ),
    ).toBe("The AI service had a brief problem; asking again");
    expect(
      describeApplicationPreparationProgress("fill_fields → took too long"),
    ).toBe("The page is slow to respond; looking again");
    expect(
      describeApplicationPreparationProgress(
        'click → browser failure: The page did not answer "Phone".',
      ),
    ).toBe("A form step needs another approach");
    expect(
      describeApplicationPreparationProgress("reading the application form"),
    ).toBe("Opening the application form");
  });

  test("uses only fixed safe labels", () => {
    expect(
      describeApplicationPreparationProgress(
        'fill_fields → Filled in "Name". "Jamie Rivers, jamie@example.test"',
      ),
    ).toBe("Filling in form fields");
  });
});
