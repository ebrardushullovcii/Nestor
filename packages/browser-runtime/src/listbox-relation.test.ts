import { expect, test } from "vitest";
import {
  pickLookupList,
  heldItems,
  type ListboxFacts,
} from "./listbox-relation";

const list = (
  mark: string,
  relation: ListboxFacts["relation"],
  extra: Partial<ListboxFacts> = {},
): ListboxFacts => ({
  mark,
  relation,
  signature: `${mark}-rows`,
  depth: 3,
  adjacent: false,
  items: [],
  ...extra,
});

test("a field's own pills and another field's pills are never its lookup list", () => {
  // R8 J.D. Power: "How Did You Hear About Us?" was read from the phone
  // code's pill, Skills from its own pills.
  const pills = list("pills", "own", { items: ["React (Software)"] });
  const phone = list("phone", "other", { items: ["Kosovo (+386)"] });
  const before = { pills: pills.signature, phone: phone.signature };
  expect(pickLookupList([pills, phone], before)).toBeNull();
  const results = list("results", "popup", { adjacent: true });
  expect(pickLookupList([pills, phone, results], before)).toBe("results");
  expect(heldItems([pills, phone, results])).toEqual(["React (Software)"]);
  expect(heldItems([phone, results])).toBeNull();
});

test("the list the action opened or changed comes before lists already open", () => {
  const stale = list("stale", "popup", { adjacent: true });
  const opened = list("opened", "popup");
  expect(pickLookupList([stale, opened], { stale: stale.signature })).toBe(
    "opened",
  );
  // Already open beside the field and unchanged by the keys: still its list.
  expect(pickLookupList([stale], { stale: stale.signature })).toBe("stale");
  // Open elsewhere and unchanged: not this field's.
  const far = list("far", "popup");
  expect(pickLookupList([far], { far: far.signature })).toBeNull();
  // An inline list in the field's own box counts once it appears or changes.
  const inline = list("inline", "own");
  expect(pickLookupList([inline], {})).toBe("inline");
  expect(pickLookupList([inline], { inline: "inline-old" })).toBe("inline");
  // A list the field names wins.
  expect(pickLookupList([opened, list("named", "owned")], {})).toBe("named");
});
