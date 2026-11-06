import { describe, expect, test } from "vitest";

import type { ApplyFormControl } from "./types";
import {
  inferAttestationKind,
  inferQuestionKind,
  isControlAnswered,
} from "./control-classification";

describe("application declarations", () => {
  test.each(["I agree to the terms", "I have read and agree to the terms"])(
    "recognizes the terms checkbox: %s",
    (label) => {
      expect(
        inferAttestationKind({
          kind: "checkbox",
          label,
          groupLabel: "Review",
          placeholder: "",
        }),
      ).toBe("terms_acceptance");
    },
  );
});

function selectControl(
  input: Partial<ApplyFormControl> = {},
): ApplyFormControl {
  return {
    ref: "location",
    kind: "select",
    label: "Location",
    groupLabel: "",
    placeholder: "Select an option",
    required: true,
    disabled: false,
    readOnly: false,
    visible: true,
    value: "",
    credentialRole: null,
    checked: false,
    options: ["", "Remote Europe"],
    selectedOptionLabel: "Select an option",
    invalid: true,
    validationMessage: "Please select an item in the list.",
    questionKind: "location",
    answerControlType: "single_choice",
    attestationKind: null,
    answered: false,
    ...input,
  };
}

describe("application prose questions", () => {
  test("keeps a why-this-role question separate from a cover letter", () => {
    expect(
      inferQuestionKind({
        kind: "long_text",
        label: "Why do you want to work here?",
        groupLabel: "",
        placeholder: "",
      }),
    ).toBe("other");
  });

  test("still recognizes a field that explicitly asks for a cover letter", () => {
    expect(
      inferQuestionKind({
        kind: "long_text",
        label: "Cover letter",
        groupLabel: "",
        placeholder: "",
      }),
    ).toBe("cover_letter");
  });
});

describe("file questions", () => {
  test.each([
    ["Academic transcript", "other"],
    ["Upload your certificate", "other"],
    ["Work sample", "other"],
    ["Attachment", "other"],
    ["Resume/CV", "resume"],
    ["Cover letter", "cover_letter"],
    ["Portfolio", "portfolio"],
  ])("reads a file control labelled %s as %s", (label, kind) => {
    expect(
      inferQuestionKind({
        kind: "file",
        label,
        groupLabel: "",
        placeholder: "",
      }),
    ).toBe(kind);
  });
});

describe("experience questions", () => {
  test("recognizes an overall professional-experience select", () => {
    expect(
      inferQuestionKind({
        kind: "select",
        label: "Years of professional experience",
        groupLabel: "",
        placeholder: "Select an option",
      }),
    ).toBe("experience");
  });
});

describe("job-source questions", () => {
  test("does not mistake a Company website option for the candidate's portfolio", () => {
    expect(
      inferQuestionKind({
        kind: "select",
        label:
          "How did you hear about this job? Select an option Job board Company website Referral Other",
        groupLabel: "My Information",
        placeholder: "Select an option",
      }),
    ).toBe("other");
  });
});

describe("answered controls", () => {
  test("does not treat a native select placeholder as an answer", () => {
    expect(isControlAnswered(selectControl())).toBe(false);
  });

  test("accepts a valid native select value", () => {
    expect(
      isControlAnswered(
        selectControl({
          value: "remote-europe",
          selectedOptionLabel: "Remote Europe",
          invalid: false,
          validationMessage: "",
        }),
      ),
    ).toBe(true);
  });
});

test("privacy notice acknowledgement is a declaration, never a notice period", () => {
  const control = {
    kind: "checkbox" as const,
    label: "I acknowledge the privacy notice",
    groupLabel: "Review and send",
    placeholder: "",
  };
  expect(inferAttestationKind(control)).toBe("privacy_notice_acknowledgement");
  expect(inferQuestionKind(control)).toBe("other");
  expect(
    inferQuestionKind({
      ...control,
      kind: "text",
      label: "What is your notice period?",
    }),
  ).toBe("notice_period");
});

test("option matching preserves umlauts and letters in every script", async () => {
  const { normalizeSignal } = await import("./control-classification");
  const { matchOption } = await import("./option-match");
  for (const options of [
    ["Groß", "Größer"],
    ["是", "否"],
    ["نعم", "لا"],
    ["Да", "Нет"],
  ]) {
    expect(new Set(options.map(normalizeSignal)).size).toBe(options.length);
    expect(matchOption(options, options[1])).toBe(options[1]);
  }
  expect(normalizeSignal("Gru\u0308ße")).toBe(normalizeSignal("Grüße"));
});
