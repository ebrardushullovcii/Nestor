import { expect, test } from "vitest";
import { copyView } from "./copy-view";
test("adding display facts preserves lazy immutable detail properties", () => {
  let reads = 0;
  const row = Object.freeze({
    id: "a",
    get description() {
      reads++;
      return "body";
    },
  });
  const view = Object.freeze(copyView(row, { status: "shortlisted" }));
  expect(reads).toBe(0);
  expect(view.id).toBe("a");
  expect(view.description).toBe("body");
  expect(reads).toBe(1);
});
