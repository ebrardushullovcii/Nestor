import { expect, test } from "vitest";
import {
  FILL_FIELDS_TOOL_DEFINITION,
  parseFillFields,
  parseApplyProposal,
} from "./apply-tools";

test("batch entries parse to the same proposals as the single-field tools", () => {
  const fields = [
    { tool: "type", ref: "c0", text: "Robin Ashford", groundedIn: ["profile"] },
    { tool: "select", ref: "c1", option: "Manchester" },
    { tool: "set_checkbox", ref: "c2", checked: false },
    { tool: "set_checkbox", ref: "c3", checked: true },
    { tool: "upload", ref: "c4", documentId: "synthetic_resume" },
    { tool: "click", ref: "e0", reason: "Dismiss the cookie banner" },
  ];
  expect(parseFillFields(JSON.stringify({ fields }))).toEqual({
    ok: true,
    fields,
  });
  for (const field of fields) {
    expect(parseApplyProposal(field.tool, JSON.stringify(field))).toEqual({
      ok: true,
      proposal: field,
    });
  }
  expect(FILL_FIELDS_TOOL_DEFINITION.function.description).toContain("radio");
});

test.each([
  "not json",
  "{}",
  '{"fields":[]}',
  JSON.stringify({ fields: [{ tool: "type", ref: "c0" }] }),
  JSON.stringify({
    fields: [{ tool: "set_checkbox", ref: "c0", checked: "false" }],
  }),
  JSON.stringify({ fields: [{ tool: "upload", ref: "c0" }] }),
  JSON.stringify({ fields: [{ tool: "click" }] }),
  ...["navigate", "submit_application", "finish"].map((tool) =>
    JSON.stringify({
      fields: [
        {
          tool,
          ref: "a0",
          text: "send",
          documentId: "cv",
          url: "https://example.test",
        },
      ],
    }),
  ),
])("invalid or non-field actions cannot enter a batch: %s", (input) => {
  expect(parseFillFields(input).ok).toBe(false);
});

test("thenContinue accepts a ref and rejects malformed refs before any field is run", () => {
  const fields = [{ tool: "type", ref: "c0", text: "Robin Ashford" }];
  expect(
    parseFillFields(JSON.stringify({ fields, thenContinue: "a0" })),
  ).toEqual({ ok: true, fields, thenContinue: "a0" });
  for (const thenContinue of [true, 12, null, {}, "", "   "]) {
    expect(parseFillFields(JSON.stringify({ fields, thenContinue })).ok).toBe(
      false,
    );
  }
  expect(
    FILL_FIELDS_TOOL_DEFINITION.function.parameters.properties,
  ).toHaveProperty("thenContinue");
});

test("stored fact references survive single-field and batch parsing", () => {
  for (const field of [
    { tool: "type", ref: "c0", text: "Li", storedFactId: "profile.firstName" },
    {
      tool: "select",
      ref: "c1",
      option: "Go",
      storedFactId: "profile.skills.0",
    },
    {
      tool: "set_checkbox",
      ref: "c2",
      checked: true,
      storedFactId: "profile.skills.1",
    },
  ]) {
    const single = parseApplyProposal(field.tool, JSON.stringify(field));
    expect(single).toEqual({ ok: true, proposal: field });
    expect(parseFillFields(JSON.stringify({ fields: [field] }))).toEqual({
      ok: true,
      fields: [field],
    });
  }
});

test("finishing a fill batch is explicit and cannot also advance a step", () => {
  const fields = [{ tool: "type", ref: "c0", text: "Robin Ashford" }];
  expect(
    parseFillFields(JSON.stringify({ fields, finishWhenReady: true })),
  ).toEqual({ ok: true, fields, finishWhenReady: true });
  expect(
    parseFillFields(JSON.stringify({ fields, finishWhenReady: "true" })).ok,
  ).toBe(false);
  expect(
    parseFillFields(
      JSON.stringify({ fields, finishWhenReady: true, thenContinue: "a0" }),
    ).ok,
  ).toBe(false);
});
