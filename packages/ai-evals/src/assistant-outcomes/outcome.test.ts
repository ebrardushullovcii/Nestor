import { expect, test } from "vitest";
import {
  buildOutcomeReport,
  equalOutcome,
  judgeAction,
  type ObservedAction,
} from "./outcome";
const base: ObservedAction = {
  id: "headline",
  actionId: "profile.headline",
  request: "Change my headline",
  expected: "completed",
  throughChat: true,
  assertions: [],
};
test("a mapped call, question or refusal without an outcome cannot pass", () => {
  expect(judgeAction(base)).toMatchObject({ outcome: "failed", passed: false });
  expect(
    judgeAction({ ...base, unsupportedReason: "No tool can do this." }),
  ).toMatchObject({ outcome: "unsupported", passed: false });
});
test("matching seeded state cannot pass without an actual built-app chat request", () => {
  expect(
    judgeAction({
      ...base,
      throughChat: false,
      assertions: [
        equalOutcome("data", "Headline", "Profile store", "New", "New"),
      ],
    }),
  ).toMatchObject({ outcome: "failed", passed: false });
});
test("completion asserts the saved value, and ignores a forged assertion pass flag", () => {
  const assertion = equalOutcome(
    "data",
    "Saved headline",
    "Profile store: headline",
    "Old",
    "New",
  );
  expect(
    judgeAction({ ...base, assertions: [{ ...assertion, passed: true }] }),
  ).toMatchObject({ outcome: "failed", passed: false });
  expect(
    judgeAction({
      ...base,
      assertions: [
        equalOutcome(
          "data",
          "Saved headline",
          "Profile store: headline",
          "New",
          "New",
        ),
      ],
    }),
  ).toMatchObject({ outcome: "completed", passed: true });
});
test("a blocked case needs the actual guard and unchanged protected state", () => {
  const guarded: ObservedAction = {
    ...base,
    expected: "correctly_blocked",
    blockedReason: "The retained application form cannot be reloaded.",
    assertions: [
      equalOutcome(
        "guard",
        "Prepared-form guard",
        "Host browser_control result",
        "refused",
        "refused",
      ),
    ],
  };
  expect(judgeAction(guarded)).toMatchObject({
    outcome: "failed",
    passed: false,
  });
  expect(
    judgeAction({
      ...guarded,
      assertions: [
        ...guarded.assertions,
        equalOutcome(
          "unchanged",
          "Fields and attachment",
          "Retained form DOM",
          { name: "Synthetic", file: "synthetic.pdf" },
          { name: "Synthetic", file: "synthetic.pdf" },
        ),
      ],
    }),
  ).toMatchObject({ outcome: "correctly_blocked", passed: true });
});
test("the full map stays in the denominator, including unrun actions and explicit exclusions", () => {
  const report = buildOutcomeReport(
    [
      {
        id: base.actionId,
        screen: "Profile",
        action: "Headline",
        channels: [],
        coverage: { kind: "tools", tools: ["patch_profile"] },
      },
      {
        id: "browser.reload",
        screen: "Browser",
        action: "Reload",
        channels: [],
        coverage: { kind: "tools", tools: ["browser_control"] },
      },
      {
        id: "chat.stop",
        screen: "Assistant",
        action: "Stop generation",
        channels: [],
        coverage: {
          kind: "excluded",
          reason:
            "The person's interrupt remains directly controlled by the person.",
        },
      },
    ],
    [
      {
        ...base,
        assertions: [
          equalOutcome("data", "Headline", "Profile store", "New", "New"),
        ],
      },
    ],
  );
  expect(report).toMatchObject({
    inventoryTotal: 3,
    counts: { completed: 1, failed: 1 },
    passed: false,
  });
  expect(
    report.actions.find((action) => action.id === "browser.reload")?.cases[0]
      ?.outcome,
  ).toBe("failed");
  expect(report.excluded).toHaveLength(1);
});
