import { describe, expect, it } from "vitest";

import { describeMonthText, parseMonthText } from "./profile-form-primitives";

describe("month fields", () => {
  it("reads the common ways a month is typed as YYYY-MM", () => {
    expect(parseMonthText("2024-03")).toBe("2024-03");
    expect(parseMonthText("2024-3")).toBe("2024-03");
    expect(parseMonthText("03/2024")).toBe("2024-03");
    expect(parseMonthText("3/2024")).toBe("2024-03");
    expect(parseMonthText("Mar 2024")).toBe("2024-03");
    expect(parseMonthText("March 2024")).toBe("2024-03");
    expect(parseMonthText("sept. 2021")).toBe("2021-09");
    expect(parseMonthText(" 2020 ")).toBe("2020");
    expect(parseMonthText("")).toBe("");
    expect(parseMonthText("Present")).toBe("Present");
  });

  it("leaves what it cannot read alone, so nothing passes silently", () => {
    expect(parseMonthText("13/2024")).toBeNull();
    expect(parseMonthText("Smarch 2024")).toBeNull();
    expect(parseMonthText("last spring")).toBeNull();
  });

  it("says how a stored month was read", () => {
    expect(describeMonthText("2024-03")).toMatch(/March 2024|2024/u);
    expect(describeMonthText("2020")).toBe("2020");
  });
});
