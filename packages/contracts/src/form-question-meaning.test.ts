import { expect, test } from "vitest";
import replay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/saved-question-meanings.json";
import { savedQuestionMatches } from "./form-question-meaning";
test.each(replay.cases)("saved-question replay: $saved -> $asked", (entry) => {
  expect(savedQuestionMatches(entry.saved, entry.asked, entry.answer)).toBe(
    entry.matches,
  );
});
