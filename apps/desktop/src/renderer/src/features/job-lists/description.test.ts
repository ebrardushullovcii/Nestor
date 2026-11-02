import { describe, expect, it } from "vitest";

import { cleanDescription } from "./description";

const header = {
  title: "Senior Frontend Engineer",
  company: "Pine Ledger Co",
  location: "Berlin",
};

describe("cleanDescription", () => {
  it("drops opening lines that only repeat the header", () => {
    expect(
      cleanDescription(
        "Senior Frontend Engineer at Pine Ledger Co.\n\n\n\nYou will build and ship product UI with a small team.\n\n\nWhat we ask: TypeScript, React.",
        header,
      ),
    ).toEqual([
      "You will build and ship product UI with a small team.",
      "What we ask: TypeScript, React.",
    ]);
    expect(
      cleanDescription(
        "Senior Frontend Engineer\nPine Ledger Co · Berlin\n\nThe work.",
        header,
      ),
    ).toEqual(["The work."]);
    // The posting age and work mode are in the header's fact line too.
    expect(
      cleanDescription(
        "Pine Ledger Co · Remote, Berlin · Posted 6d ago\nSenior Frontend Engineer · Full-time\n\nThe work.",
        header,
      ),
    ).toEqual(["The work."]);
  });

  it("drops a banner line that leads into the header, and header lines after the first paragraph", () => {
    expect(
      cleanDescription(
        "We're hiring!\nSenior Frontend Engineer\n\nPine Ledger Co · Berlin\n\nThe work.",
        header,
      ),
    ).toEqual(["The work."]);
    expect(
      cleanDescription(
        "About the role\n\nSenior Frontend Engineer · Remote\nYou will build product UI.",
        header,
      ),
    ).toEqual(["About the role", "You will build product UI."]);
    // A short opening line that does not lead into the header stays.
    expect(
      cleanDescription("Join us!\nYou will build product UI.", header),
    ).toEqual(["Join us!\nYou will build product UI."]);
  });

  it("folds runs of blank lines and keeps line breaks inside a paragraph", () => {
    expect(
      cleanDescription("One.\r\n\r\n \r\n\r\nTwo\nthree.", header),
    ).toEqual(["One.", "Two\nthree."]);
  });

  it("keeps a description that is only about the job, and never empties it", () => {
    expect(cleanDescription("Pine Ledger Co", header)).toEqual([
      "Pine Ledger Co",
    ]);
    expect(
      cleanDescription(
        "Senior Frontend Engineer at Pine Ledger Co, building ledgers.",
        header,
      ),
    ).toEqual([
      "Senior Frontend Engineer at Pine Ledger Co, building ledgers.",
    ]);
  });
});
