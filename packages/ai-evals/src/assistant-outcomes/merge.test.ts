import { expect, test } from "vitest";
import { combineOutcomeArtifacts } from "./merge";
const environment = {
  buildCommit: "same-built-head",
  buildChangesHash: null,
  label: "short-run",
  ai: "live",
  net: "replica",
  doctorPassed: true,
};
const artifact = (actual: string) => ({
  version: 1,
  environment,
  observations: [
    {
      id: "home.navigation.home",
      actionId: "navigation.home",
      request: "Show Home",
      expected: "completed",
      throughChat: true,
      assertions: [
        {
          kind: "visible_state",
          label: "Heading",
          source: "Visible main heading",
          actual,
          expected: "Home",
          passed: true,
        },
      ],
    },
  ],
});
test("short runs can combine only when their app build and replica guard agree", () => {
  expect(() =>
    combineOutcomeArtifacts([
      artifact("Home"),
      {
        ...artifact("Home"),
        environment: { ...environment, buildCommit: "different-head" },
      },
    ]),
  ).toThrow("different builds");
  expect(() =>
    combineOutcomeArtifacts([
      { ...artifact("Home"), environment: { ...environment, net: "web" } },
    ]),
  ).toThrow();
});
test("a later good attempt does not hide an earlier wrong screen or unexercised actions", () => {
  const result = combineOutcomeArtifacts([
    artifact("Profile"),
    artifact("Home"),
  ]);
  expect(
    result.report.actions.find((action) => action.id === "navigation.home"),
  ).toMatchObject({ outcome: "failed", passed: false });
  expect(
    result.report.actions.find((action) => action.id === "navigation.settings"),
  ).toMatchObject({ outcome: "failed", passed: false });
  expect(result.report.passed).toBe(false);
});
