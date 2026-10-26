import { expect, test } from "vitest";
import { formatGithubAnswer } from "./github-username";

const url = "https://github.com/synthetic-alex";
test.each([
  ["GitHub username (username only, no URL)", "", "", "synthetic-alex"],
  ["GitHub username", "Not a link", "", url],
  ["GitHub username", "", "Without the URL", url],
  ["GitHub", "Handle only, no URL", "", "synthetic-alex"],
  ["GitHub", "Just the username, not a link", "", "synthetic-alex"],
  ["GitHub username", "Please do not submit without a URL", "", url],
  ["GitHub username", "Do not enter your username instead of a URL", "", url],
  [
    "GitHub username (username only, no URL)",
    "Please provide the full URL",
    "",
    url,
  ],
  ["GitHub", "Please enter your username", "", "synthetic-alex"],
  ["GitHub", "Please provide your handle", "", "synthetic-alex"],
  ["What is your GitHub username?", "", "", "synthetic-alex"],
  ["GitHub", "", "e.g. octocat", url],
  ["GitHub", "Please do not provide your username", "", url],
  ["GitHub", "Do not enter your username", "", url],
  ["GitHub username", "No URL", "Full profile URL", url],
  [
    "GitHub username",
    "Not a link; provide the full URL of your profile",
    "",
    url,
  ],
  ["GitHub username or URL", "Without the URL", "", url],
])(
  "only an affirmative handle request converts an address: %s %s %s",
  (label, hint, placeholder, expected) => {
    expect(
      formatGithubAnswer({ label, hint, placeholder, groupLabel: "" }, url),
    ).toBe(expected);
  },
);

test("a handle-only instruction keeps its meaning inside a contact section", () => {
  expect(
    formatGithubAnswer(
      {
        label: "GitHub username (username only, no URL)",
        hint: "",
        placeholder: "",
        groupLabel: "Contact information",
      },
      url,
    ),
  ).toBe("synthetic-alex");
});
