import { expect, test } from "vitest";
import { runInNewContext } from "node:vm";
import {
  hasApplicationSubmissionConfirmation,
  submissionConfirmationSummary,
  readApplicationSubmissionConfirmationEvidence,
  applicationSubmissionConfirmationMessages,
} from "./submission-confirmation";

test.each([
  "Your application has been received.",
  "We've received your application.",
  "We received your application and will be in touch.",
  "Thank you for submitting your application.",
  "Thanks for your application!",
  "You have successfully applied for this position.",
  "Application submitted successfully.",
  "Your application has been sent to our recruitment team.",
  "Your application has been accepted.",
  "You have submitted your application successfully.",
  "You have successfully submitted your application.",
  "Your application for Software Engineer has been received.",
  "Your application for the Designer position was submitted successfully.",
  "We have received your application. The form could not send a confirmation email.",
  "We have received your application. FAQ: If your application is not received, contact support.",
])("recognizes an employer acknowledgement: %s", (text) => {
  expect(hasApplicationSubmissionConfirmation(text)).toBe(true);
});

test.each([
  "Application complete",
  "Your application is complete. Review your answers before sending.",
  "If your application is submitted, we will email you.",
  "When your application has been received, this page will update.",
  "Your application has not been received.",
  "Your application was not successfully submitted.",
  "No application submitted.",
  "No thanks for applying message has appeared yet.",
  "We could not send your application. Thank you for applying.",
  "Your application is ready to be submitted.",
  "Click Submit to see 'Thank you for applying'.",
  "Your previous application was received last year.",
  "Thank you for applying. We could not send your application.",
  "You successfully applied the changes to your application.",
  "Previous application received. This new application is not sent.",
  "Application submitted? Check your email to find out.",
  "Your application is submitted only after you click the button.",
  "Your application is submitted by clicking Send.",
  "Thank you for applying changes to your profile.",
  "The application was submitted yesterday. Start a new one below.",
  "Example success screen:\nYour application has been received.",
  "When you see the following message, you are done:\nYour application has been received.",
  "Your application could not be submitted. Thank you for applying.",
  "Thank you for applying. There was a problem sending your application.",
  "Thank you for applying. Not submitted to the employer yet.",
  "Thank you for applying. Submission pending.",
  "Your application is accepted only if all documents are validated.",
  "If your application for Software Engineer has been received, we will email you.",
])(
  "does not mistake form progress, guidance or refusal for receipt: %s",
  (text) => {
    expect(hasApplicationSubmissionConfirmation(text)).toBe(false);
  },
);
test("keeps the site's labelled confirmation reference without inventing one", () => {
  expect(
    submissionConfirmationSummary("Application received. Reference: SYN-105"),
  ).toBe("The site confirmed receipt. Reference: SYN-105.");
  expect(
    submissionConfirmationSummary(
      "Thanks for applying. Confirmation number: ABC_25",
    ),
  ).toContain("ABC_25");
  expect(submissionConfirmationSummary("Thank you for applying")).not.toContain(
    "Reference:",
  );
});

test("the trusted browser reader is self-contained and returns bounded receipt phrases", () => {
  const serialized: unknown = runInNewContext(
    `(${readApplicationSubmissionConfirmationEvidence.toString()})`,
  );
  expect(typeof serialized).toBe("function");
  const read =
    serialized as typeof readApplicationSubmissionConfirmationEvidence;
  expect(
    read(
      "We have received your application. Robin, your email is synthetic@example.test.",
    ).messages,
  ).toEqual(["we have received your application"]);
  expect(
    applicationSubmissionConfirmationMessages(
      "Your application was received. We have received your application.",
    ),
  ).toEqual([
    "your application was received",
    "we have received your application",
  ]);
});

test("job references outside the receipt are not application receipt numbers", () => {
  expect(
    submissionConfirmationSummary(
      "Job Reference: REQ-123. We have received your application. Confirmation: C-456.",
    ),
  ).toBe("The site confirmed receipt. Reference: C-456.");
  expect(
    submissionConfirmationSummary(
      "Job Reference: REQ-123. We have received your application.",
    ),
  ).toBe("The site confirmed receipt of the application.");
});
