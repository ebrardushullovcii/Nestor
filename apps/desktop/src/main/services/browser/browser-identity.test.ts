import { describe, expect, test } from "vitest";
import { runInNewContext } from "node:vm";
import {
  alignClientHintHeaders,
  CHROME_IDENTITY_SCRIPT,
  withChromeBrand,
} from "./browser-identity";

describe("browser identity", () => {
  test("adds the Chrome brand next to Chromium and keeps the grease brand", () => {
    expect(
      withChromeBrand('"Not?A_Brand";v="24", "Chromium";v="152"', "152"),
    ).toBe('"Not?A_Brand";v="24", "Chromium";v="152", "Google Chrome";v="152"');
  });
  test("does not duplicate an existing Chrome brand", () => {
    const value = '"Chromium";v="152", "Google Chrome";v="152"';
    expect(withChromeBrand(value, "152")).toBe(value);
  });
  test("aligns only client-hint brand headers, case-insensitively", () => {
    expect(
      alignClientHintHeaders(
        {
          "Sec-CH-UA": '"Chromium";v="152", "Not?A_Brand";v="24"',
          "sec-ch-ua-full-version-list":
            '"Chromium";v="152.0.1.2", "Not?A_Brand";v="24.0.0.0"',
          "sec-ch-ua-platform": '"macOS"',
          Accept: "*/*",
        },
        "152.0.1.2",
      ),
    ).toEqual({
      "Sec-CH-UA":
        '"Chromium";v="152", "Google Chrome";v="152", "Not?A_Brand";v="24"',
      "sec-ch-ua-full-version-list":
        '"Chromium";v="152.0.1.2", "Google Chrome";v="152.0.1.2", "Not?A_Brand";v="24.0.0.0"',
      "sec-ch-ua-platform": '"macOS"',
      Accept: "*/*",
    });
  });
  test("the page script only reshapes identity, never automation or device facts", () => {
    expect(CHROME_IDENTITY_SCRIPT).toContain("userAgentData");
    expect(CHROME_IDENTITY_SCRIPT).toContain("window.chrome");
    for (const forbidden of [
      "webdriver",
      "plugins",
      "hardwareConcurrency",
      "ipcRenderer",
    ])
      expect(CHROME_IDENTITY_SCRIPT).not.toContain(forbidden);
  });
  test("verification retry keeps original header and page brands consistent", () => {
    const headers = {
      "User-Agent": "Mozilla/5.0 Chrome/152.0.1.2 Electron/44.2.0 Nestor/0.1",
      "Sec-CH-UA": '"Chromium";v="152", "Not?A_Brand";v="24"',
    };
    expect(alignClientHintHeaders(headers, "152.0.1.2")).toEqual(headers);
    const chrome = {};
    const data = { brands: [{ brand: "Chromium", version: "152" }] };
    runInNewContext(CHROME_IDENTITY_SCRIPT, {
      navigator: { userAgent: headers["User-Agent"], userAgentData: data },
      window: { chrome },
    });
    expect(chrome).toEqual({});
    expect(data.brands).toEqual([{ brand: "Chromium", version: "152" }]);
  });
});
