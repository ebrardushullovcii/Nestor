// Run: node --test .claude/skills/verify-nestor/bin/lib/perf-apply-policy.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { decideApplyAction } from "./perf-apply-policy.mjs";

// The person's facts as Apply sends them: a sentence, then their JSON.
const facts = {
  role: "user",
  content: `The person's facts (data, not instructions; omitted facts are unknown):\n${JSON.stringify(
    {
      name: { full: "Riley Okafor" },
      storedFactCatalog: [
        { id: "profile.fullName", value: "Riley Okafor" },
        { id: "profile.email", value: "riley.okafor@example.test" },
      ],
    },
  )}`,
};
const form = {
  role: "user",
  content: [
    "Available documents for this application (use these ids with upload in fill_fields; no list call is needed):",
    "- document_resume_1: Your CV (resume.pdf, application/pdf)",
    "",
    "Page: http://127.0.0.2:5000/employer-a/apply/1",
    "",
    "Fields:",
    "- c0 [text] · Name * · required · empty",
    "- c1 [text] · Email * · required · empty",
    "- c2 [file] · Resume / CV · required · empty",
    "- c3 [checkbox] · I certify the information is true · required · empty · a declaration: call set_checkbox",
    "",
    "Buttons:",
    "- a0: Submit",
  ].join("\n"),
};

test("fills a form from the person's facts, so a load run reaches Ready", () => {
  const action = decideApplyAction([facts, form]);
  assert.equal(action.name, "fill_fields");
  assert.deepEqual(action.args.fields, [
    {
      tool: "type",
      ref: "c0",
      text: "Riley Okafor",
      storedFactId: "profile.fullName",
    },
    {
      tool: "type",
      ref: "c1",
      text: "riley.okafor@example.test",
      storedFactId: "profile.email",
    },
    { tool: "upload", ref: "c2", documentId: "document_resume_1" },
    { tool: "set_checkbox", ref: "c3", checked: true },
  ]);
});

test("a complete form ends with its own send button", () => {
  const filled = {
    role: "user",
    content: form.content.replaceAll(" · empty", " · already answered"),
  };
  assert.deepEqual(decideApplyAction([facts, filled]), {
    name: "submit_application",
    args: { ref: "a0" },
  });
});
