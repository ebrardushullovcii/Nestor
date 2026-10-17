import { describe, expect, test } from "vitest";
import {
  browserDisplayUrl,
  browserUserAgent,
  isBrowserNavigationAllowed,
  isSameBrowserNavigation,
  normalizeBrowserNavigation,
} from "./browser-navigation";

describe("embedded browser navigation boundary", () => {
  test.each([
    "file:///C:/Users/private.txt",
    "javascript:alert(1)",
    "data:text/html,hello",
    "devtools://devtools",
    "chrome://settings",
    "https://user:secret@example.com/",
  ])("rejects privileged or credential-bearing navigation: %s", (url) => {
    expect(isBrowserNavigationAllowed(url)).toBe(false);
  });
  test("accepts website addresses without a scheme and preserves navigation parameters", () => {
    expect(
      normalizeBrowserNavigation(" example.com/jobs?query=engineer#results "),
    ).toBe("https://example.com/jobs?query=engineer#results");
    expect(normalizeBrowserNavigation("about:blank")).toBe("about:blank");
  });
  test("redacts transient OAuth parameters from renderer display state", () => {
    expect(
      browserDisplayUrl(
        "https://accounts.example.com/callback?code=secret&state=private#token",
      ),
    ).toBe("https://accounts.example.com/callback");
    expect(browserDisplayUrl("about:blank")).toBe("about:blank");
  });
  test("matches an exact existing destination without dropping query or fragment state", () => {
    expect(
      isSameBrowserNavigation(
        "https://example.com/apply?id=job_1#review",
        " https://example.com/apply?id=job_1#review ",
      ),
    ).toBe(true);
    expect(
      isSameBrowserNavigation(
        "https://example.com/apply?id=job_1#review",
        "https://example.com/apply?id=job_2#review",
      ),
    ).toBe(false);
    expect(
      isSameBrowserNavigation(
        "https://example.com/apply?id=job_1#review",
        "https://example.com/apply?id=job_1#send",
      ),
    ).toBe(false);
  });
  test("removes packaging tokens without inventing a different browser or platform", () => {
    expect(
      browserUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Nestor/0.1.0 Chrome/152.0.7977.76 Electron/44.2.0 Safari/537.36",
        "Nestor",
      ),
    ).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.7977.76 Safari/537.36",
    );
  });
});
