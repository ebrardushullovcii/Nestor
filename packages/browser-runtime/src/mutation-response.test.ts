import { expect, test } from "vitest";
import replay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/mutation-response.json";
import {
  inspectMutationResponse,
  mutationResponseSaysError,
} from "./mutation-response";

test.each(replay.refused)(
  "a successful HTTP status cannot override refusal %j",
  async (body) => {
    expect(mutationResponseSaysError(body)).toBe(true);
    expect(
      await inspectMutationResponse({
        status: () => 200,
        headers: () => ({ "content-type": "application/json" }),
        text: () => Promise.resolve(JSON.stringify(body)),
      }),
    ).toMatchObject({ accepted: false });
  },
);
test.each(replay.accepted)(
  "an ordinary successful response is accepted %j",
  async (body) => {
    expect(
      await inspectMutationResponse({
        status: () => 200,
        headers: () => ({ "content-type": "application/json" }),
        text: () => Promise.resolve(JSON.stringify(body)),
      }),
    ).toMatchObject({ accepted: true, body });
  },
);
test("a redirect or unreadable JSON body alone cannot confirm a save", async () => {
  for (const [status, body] of [
    [302, ""],
    [200, "{"],
  ] as const)
    expect(
      await inspectMutationResponse({
        status: () => status,
        headers: () => ({ "content-type": "application/json" }),
        text: () => Promise.resolve(body),
      }),
    ).toMatchObject({ accepted: false });
});
