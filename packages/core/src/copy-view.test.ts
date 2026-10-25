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

test("a material change replaces a lazy field without reading or mutating its owner", () => {
  let reads = 0;
  const preparation = Symbol("preparation");
  const row = Object.freeze({
    [preparation]: "carried",
    get description() {
      reads++;
      return "previous body";
    },
  });
  const view = copyView(row, { description: "new body" });
  expect(view.description).toBe("new body");
  expect(view[preparation]).toBe("carried");
  expect(reads).toBe(0);
  expect(row.description).toBe("previous body");
  expect(reads).toBe(1);
});
