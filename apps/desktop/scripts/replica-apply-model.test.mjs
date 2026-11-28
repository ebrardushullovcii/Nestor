import assert from "node:assert/strict";
import { test } from "node:test";
import { decideReplicaAction } from "./replica-apply-model.mjs";

const page = (body) => ({
  role: "user",
  content: `Page: http://127.0.0.1:47961/workday/apply/3\n\n${body}`,
});

test("refuses to drive a non-loopback application", () => {
  assert.throws(() =>
    decideReplicaAction([
      {
        role: "user",
        content: "Page: https://employer.example.test/apply\n\nFields:",
      },
    ]),
  );
});

test("waits for Save and continue before inspecting the next step", () => {
  assert.deepEqual(
    decideReplicaAction([
      page("Buttons:\n- a1: Save and continue (disabled)\n\nSaving…"),
    ]),
    { name: "wait", args: { milliseconds: 300 } },
  );
});

test("uses the stored No answer on its matching radio rather than unchecking Yes", () => {
  assert.deepEqual(
    decideReplicaAction([
      page(
        "Fields:\n- [radio group] · Are you authorized to work here?\n  - c3 [radio] · Yes · required · empty\n  - c4 [radio] · No · required · empty\n- [radio group] · Will you require sponsorship?\n  - c1 [radio] · Yes · required · empty\n  - c2 [radio] · No · required · empty",
      ),
      {
        role: "assistant",
        tool_calls: [
          {
            id: "answer",
            function: { name: "suggest_answer", arguments: '{"ref":"c1"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "answer",
        content:
          '"Will you require sponsorship?": No — from your answer to this question.',
      },
    ]),
    { name: "set_checkbox", args: { ref: "c2", checked: true } },
  );
});

test("uses another saved role instead of treating the resume attachment as work history", () => {
  assert.deepEqual(
    decideReplicaAction([
      {
        role: "user",
        content: JSON.stringify({
          savedApplicationFacts: { experiences: [{}, {}] },
        }),
      },
      page(
        "Fields:\n- c1 [text] · Work experience 1 — Job title · required · already answered\n- c2 [text] · Work experience 1 — Company · required · already answered\n\nButtons:\n- a1: Add\n- a2: Save and continue",
      ),
    ]),
    { name: "click", args: { ref: "a1" } },
  );
});

test("leaves a completed review for the product submission boundary", () => {
  assert.deepEqual(
    decideReplicaAction([
      page(
        "Fields:\n- c1 [checkbox] · Review — Terms · required · already answered\n\nButtons:\n- a1: Save and continue\n- a2: Submit",
      ),
    ]),
    { name: "submit_application", args: { ref: "a2" } },
  );
});

test("answers the replica terms checkbox from its label", () => {
  assert.deepEqual(
    decideReplicaAction([
      page(
        "Fields:\n- c1 [checkbox] · Voluntary Disclosures — I consent to the terms and conditions* · required · empty",
      ),
    ]),
    { name: "set_checkbox", args: { ref: "c1", checked: true } },
  );
});

test("finishes after the prepare-only boundary confirms the form is ready", () => {
  assert.deepEqual(
    decideReplicaAction([
      page("Buttons:\n- a2: Submit"),
      {
        role: "assistant",
        tool_calls: [
          {
            id: "ready",
            function: { name: "submit_application", arguments: '{"ref":"a2"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "ready",
        content:
          "This application is set to fill in only, so Job Finder stopped before sending it.",
      },
    ]),
    {
      name: "finish",
      args: { reason: "The replica form is complete and ready for review." },
    },
  );
});
