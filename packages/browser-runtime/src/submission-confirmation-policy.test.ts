import { expect, test } from "vitest";
import {
  employerPageConfirmsSubmission,
  isFinalSubmissionRequest,
  type SubmissionPageState,
} from "./submission-confirmation-policy";

const origin = "https://apply.example.test";
const allowedOrigins = new Set([origin]);
const mutation = (field = "submitSingleApplicationFormAction") =>
  JSON.stringify({
    operationName: "ApiSubmitSingleApplicationFormAction",
    query: `mutation ApiSubmitSingleApplicationFormAction { ${field} { ok } }`,
  });
const request = (body: string | null = mutation()) => ({
  url: `${origin}/api/graphql`,
  method: "POST",
  body,
  mainFrame: true,
  navigation: false,
  allowedOrigins,
  nativeAction: null,
});
const before: SubmissionPageState = {
  url: `${origin}/application`,
  text: "Application form",
  ready: true,
  editableControls: 2,
};
const confirmed: SubmissionPageState = {
  ...before,
  text: "Your application was successfully submitted. We appreciate your patience as your application is under review.",
  editableControls: 0,
};

test("the real success wording is fresh page evidence for a selected final mutation", () => {
  expect(isFinalSubmissionRequest(request())).toBe(true);
  expect(
    employerPageConfirmsSubmission(before, confirmed, allowedOrigins),
  ).toBe(true);
});

test.each([
  "setFormValue",
  "saveApplication",
  "logAnalytics",
  "createFileUploadHandle",
])("a 2xx from %s is not the final response", (field) => {
  expect(isFinalSubmissionRequest(request(mutation(field)))).toBe(false);
});

test("the operation the server selects must actually submit, rather than just its name or variables", () => {
  const body = JSON.stringify({
    operationName: "Save",
    variables: { answer: "submit application" },
    query:
      "mutation Submit { submitApplication { ok } } mutation Save { saveApplication { id } }",
  });
  expect(isFinalSubmissionRequest(request(body))).toBe(false);
  expect(
    isFinalSubmissionRequest(
      request(
        JSON.stringify({
          query: "query SubmitApplication { application { id } }",
        }),
      ),
    ),
  ).toBe(false);
});

test.each(["other origin", "other frame", "read", "batch", "opaque"])(
  "unrelated or ambiguous request evidence stays unconfirmed: %s",
  (shape) => {
    const input = request();
    if (shape === "other origin")
      input.url = "https://other.example.test/api/graphql";
    if (shape === "other frame") input.mainFrame = false;
    if (shape === "read") input.method = "GET";
    if (shape === "batch") input.body = `[${mutation()},${mutation()}]`;
    if (shape === "opaque") input.body = "unknown body";
    expect(isFinalSubmissionRequest(input)).toBe(false);
  },
);

test("a native form navigation is tied to that form's exact destination", () => {
  const input = {
    ...request(null),
    navigation: true,
    nativeAction: { origin, safePath: "/api/receive" },
    url: `${origin}/api/receive?nonce=synthetic`,
  };
  expect(isFinalSubmissionRequest(input)).toBe(true);
  expect(
    isFinalSubmissionRequest({ ...input, url: `${origin}/api/other` }),
  ).toBe(false);
});

test("a confirmation-page transition supplies state evidence without guessing a receipt number", () => {
  expect(
    employerPageConfirmsSubmission(
      before,
      {
        ...before,
        url: `${origin}/application/confirmation`,
        text: "Your request is now in the queue.",
        editableControls: 0,
      },
      allowedOrigins,
    ),
  ).toBe(true);
  expect(
    employerPageConfirmsSubmission(
      before,
      {
        ...before,
        url: `${origin}/account/confirmation`,
        text: "Check your email.",
        editableControls: 0,
      },
      allowedOrigins,
    ),
  ).toBe(false);
});

test.each([
  "stale words",
  "failed words",
  "loading",
  "other origin",
  "form still present",
  "unknown before",
  "error state",
])(
  "a page without fresh employer confirmation stays uncertain: %s",
  (shape) => {
    let initial: SubmissionPageState | null = before;
    const page = { ...confirmed };
    if (shape === "stale words") initial = confirmed;
    if (shape === "failed words")
      page.text = "Your application was not successfully submitted.";
    if (shape === "loading") page.ready = false;
    if (shape === "other origin")
      page.url = "https://other.example.test/application/confirmation";
    if (shape === "form still present") {
      page.url = `${origin}/application/confirmation`;
      page.text = "Please enter your details.";
      page.editableControls = 2;
    }
    if (shape === "unknown before") initial = null;
    if (shape === "error state") {
      page.url = `${origin}/application/confirmation`;
      page.text = "Request unsuccessful";
    }
    expect(employerPageConfirmsSubmission(initial, page, allowedOrigins)).toBe(
      false,
    );
  },
);
