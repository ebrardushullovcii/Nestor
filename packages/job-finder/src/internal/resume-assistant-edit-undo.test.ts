import { describe, expect, test } from "vitest";
import { mergeRevertingAssistantEdit } from "./resume-assistant-edit-undo";

const line = (id: string, text: string, updatedAt = "2026-01-01T00:00:00.000Z") => ({
  id,
  text,
  updatedAt,
});

describe("mergeRevertingAssistantEdit", () => {
  test("reverts an AI rewrite the person has not touched since", () => {
    const before = { bullets: [line("a", "one"), line("b", "two")] };
    const after = { bullets: [line("a", "one AI"), line("b", "two")] };
    const current = {
      bullets: [line("a", "one AI", "2026-02-01T00:00:00.000Z"), line("b", "two mine")],
    };
    expect(mergeRevertingAssistantEdit(before, after, current)).toEqual({
      bullets: [line("a", "one", "2026-01-01T00:00:00.000Z"), line("b", "two mine")],
    });
  });

  test("drops an AI-added line, restores an AI-removed line, and keeps a line the person added", () => {
    const before = { bullets: [line("a", "one"), line("b", "two")] };
    const after = { bullets: [line("a", "one"), line("c", "AI added")] };
    const current = {
      bullets: [line("a", "one"), line("c", "AI added"), line("d", "mine")],
    };
    expect(mergeRevertingAssistantEdit(before, after, current)).toEqual({
      bullets: [line("a", "one"), line("b", "two"), line("d", "mine")],
    });
  });

  test("puts back the original order when only the AI reordered", () => {
    const before = { bullets: [line("a", "one"), line("b", "two"), line("c", "three")] };
    const after = { bullets: [line("c", "three"), line("a", "one"), line("b", "two")] };
    const current = {
      bullets: [line("c", "three"), line("a", "one mine"), line("b", "two")],
    };
    expect(mergeRevertingAssistantEdit(before, after, current)).toEqual({
      bullets: [line("a", "one mine"), line("b", "two"), line("c", "three")],
    });
  });
});
