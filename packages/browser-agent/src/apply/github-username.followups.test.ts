import { expect, test } from "vitest";
import { formatGithubAnswer } from "./github-username";

const url = "https://github.com/synthetic-alex";
test.each([
  ["GitHub username (username only, no URL)", "", "", "synthetic-alex"],
  ["GitHub username", "Not a link", "", "synthetic-alex"],
  ["GitHub username", "", "Without the URL", "synthetic-alex"],
  ["GitHub username", "No URL", "Full profile URL", url],
  [
    "GitHub username",
    "Not a link; provide the full URL of your profile",
    "",
    url,
  ],
  ["GitHub username or URL", "Without the URL", "", url],
])(
  "negated address wording never erases a positive address request: %s %s %s",
  (label, hint, placeholder, expected) => {
    expect(
      formatGithubAnswer({ label, hint, placeholder, groupLabel: "" }, url),
    ).toBe(expected);
  },
);
