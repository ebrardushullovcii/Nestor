import { expect, test } from "vitest";
import { buildApplyFormObservation } from "./page-hands";
import { createQuestionOccurrences } from "./question-occurrences";

// Candidate 4 workday replica: the Review "terms" box was first recorded by a
// read that could not tell the step ([url, null], just after sign-in), then
// asked as "repeated question on step 4" although it exists only on Review.
test("an unknown step is not another step; two known steps still are", () => {
  const terms = (stepLabel: string | null) =>
    buildApplyFormObservation(
      {
        url: "https://replica.test/workday/apply/1?stage=application",
        title: "Apply",
        bodyText: "Review",
        stepLabel,
        loading: false,
        actions: [],
        links: [],
        clickables: [],
        headings: [],
        openedTabs: [],
        validationErrors: [],
        controls: [
          {
            index: 0,
            tagName: "input",
            inputType: "checkbox",
            role: "",
            id: "terms",
            name: "terms",
            label: "I have read and agree to the terms",
            groupLabel: "Review",
            placeholder: "",
            autocomplete: "",
            required: true,
            invalid: false,
            validationMessage: "",
            disabled: false,
            readOnly: false,
            visible: true,
            value: "yes",
            checked: false,
            multiple: false,
            options: [],
            selectedOptionLabel: "",
          },
        ],
      },
      "2026-11-03T00:00:00.000Z",
    );
  for (const resume of [false, true]) {
    let occurrences = createQuestionOccurrences();
    occurrences.observe(terms(null));
    if (resume)
      occurrences = createQuestionOccurrences(
        JSON.parse(JSON.stringify(occurrences.snapshot())) as ReturnType<
          typeof occurrences.snapshot
        >,
      );
    const review = terms("Step 4 of 4: Review");
    occurrences.observe(review);
    expect(review.controls[0]?.repeatedQuestion).toBeUndefined();
    // Unknown after known is not a repeat either.
    const between = terms(null);
    occurrences.observe(between);
    expect(between.controls[0]?.repeatedQuestion).toBeUndefined();
  }
  // Two known, different steps remain a repeat.
  const occurrences = createQuestionOccurrences();
  occurrences.observe(terms("Step 3 of 4: Application Questions"));
  const later = terms("Step 4 of 4: Review");
  occurrences.observe(later);
  expect(later.controls[0]?.repeatedQuestion).toBeDefined();
});
