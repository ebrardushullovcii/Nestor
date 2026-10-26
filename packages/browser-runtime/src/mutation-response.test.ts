import { expect, test } from "vitest";
import replay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/mutation-response.json";
import typesReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/mutation-response-types.json";
import {
  inspectMutationResponse as inspectStructuralResponse,
  type MutationResponsePermit,
  mutationResponseSaysError,
} from "./mutation-response";

const endpoint = "https://storage.example.test/upload";
const carrier = {
  method: () => "POST",
  url: () => endpoint,
  frame: () => ({ url: () => "https://form.example.test/apply" }),
};
const permit: MutationResponsePermit = {
  actionKind: "upload",
  frameOrigin: "https://form.example.test",
  method: "POST",
  endpoint,
  authorizedCarrier: carrier,
  file: {
    field: "resume",
    name: "synthetic.pdf",
    size: 123,
    sha256: "a".repeat(64),
  },
  uploadLeg: "file",
};
const inspectMutationResponse = (
  response: Parameters<typeof inspectStructuralResponse>[0],
) =>
  inspectStructuralResponse(
    { ...response, url: () => endpoint, request: () => carrier },
    { permit },
  );

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

test.each(replay.plainText)(
  "a plain-text response is judged by refusal wording: $text",
  async ({ text, accepted }) => {
    expect(
      await inspectMutationResponse({
        status: () => 200,
        headers: () => ({ "content-type": "text/plain; charset=utf-8" }),
        text: () => Promise.resolve(text),
      }),
    ).toMatchObject({ accepted });
  },
);

test.each(typesReplay.cases)("response-type replay: $name", async (entry) => {
  const checked = await inspectMutationResponse({
    status: () => entry.status,
    headers: () => (entry.type ? { "content-type": entry.type } : {}),
    text: () => Promise.resolve(entry.body),
  });
  expect(checked.judgment).toBe(entry.judgment);
  expect(checked.accepted).toBe(entry.judgment === "accepted");
});

test("an unreadable response is unconfirmed rather than accepted", async () => {
  expect(
    await inspectMutationResponse({
      status: () => 200,
      headers: () => ({ "content-type": "application/octet-stream" }),
      text: () => Promise.reject(new Error("Body unavailable")),
    }),
  ).toMatchObject({ judgment: "unconfirmed", accepted: false });
});

test("acceptance requires the permit for this exact carrier and structural upload proof", async () => {
  const response = {
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    text: () => Promise.resolve('{"uploadId":"synthetic-upload-1"}'),
    url: () => endpoint,
    request: () => carrier,
  };
  expect((await inspectStructuralResponse(response)).judgment).toBe(
    "unconfirmed",
  );
  expect((await inspectStructuralResponse(response, { permit })).judgment).toBe(
    "accepted",
  );
  expect(
    (
      await inspectStructuralResponse(
        { ...response, request: () => ({ ...carrier }) },
        { permit },
      )
    ).judgment,
  ).toBe("unconfirmed");
  expect(
    (
      await inspectStructuralResponse(
        { ...response, url: () => endpoint + "/other" },
        { permit },
      )
    ).judgment,
  ).toBe("unconfirmed");
  expect(
    (
      await inspectStructuralResponse(response, {
        permit: { ...permit, file: { ...permit.file, sha256: "wrong" } },
      })
    ).judgment,
  ).toBe("unconfirmed");
  for (const body of [
    '{"success":true}',
    '{"status":"completed"}',
    '{"id":"application-42"}',
    '{"location":"Remote"}',
    '"Upload complete"',
    "{}",
    "[]",
  ]) {
    expect(
      (
        await inspectStructuralResponse(
          { ...response, text: () => Promise.resolve(body) },
          { permit },
        )
      ).accepted,
    ).toBe(false);
  }
});

test("S3 empty 204 and PostResponse need the exact-file upload permit", async () => {
  const response = {
    status: () => 204,
    headers: () => ({}),
    text: () => Promise.resolve(""),
    url: () => endpoint,
    request: () => carrier,
  };
  expect((await inspectStructuralResponse(response)).accepted).toBe(false);
  expect((await inspectStructuralResponse(response, { permit })).accepted).toBe(
    true,
  );
  const xml = {
    ...response,
    status: () => 201,
    text: () =>
      Promise.resolve(
        "<PostResponse><Key>uploads/synthetic.pdf</Key></PostResponse>",
      ),
  };
  expect((await inspectStructuralResponse(xml)).accepted).toBe(false);
  expect((await inspectStructuralResponse(xml, { permit })).accepted).toBe(
    true,
  );
});

test("a presign response is not a confirmed attachment", async () => {
  const response = {
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    text: () => Promise.resolve('{"key":"uploads/file.pdf"}'),
    url: () => endpoint,
    request: () => carrier,
  };
  expect(
    (
      await inspectStructuralResponse(response, {
        permit: { ...permit, uploadLeg: "presign" } as MutationResponsePermit,
      })
    ).judgment,
  ).toBe("unconfirmed");
});

test("property: generated successful statuses and wording never substitute for a permit or receipt", async () => {
  const words = [
    "completed",
    "complete",
    "done",
    "sent",
    "applied",
    "abgeschlossen",
    "terminé",
    "enviado",
    "concluído",
    "完了",
  ];
  const wrappers = [
    "data",
    "result",
    "response",
    "payload",
    "body",
    "attachment",
    "upload",
    "anything",
  ];
  for (const word of words)
    for (const wrapper of wrappers) {
      const response = {
        status: () => 200,
        headers: () => ({ "content-type": "application/json" }),
        text: () =>
          Promise.resolve(
            JSON.stringify({ [wrapper]: { status: word, success: true } }),
          ),
        url: () => endpoint,
        request: () => carrier,
      };
      expect((await inspectStructuralResponse(response)).accepted).toBe(false);
      expect(
        (await inspectStructuralResponse(response, { permit })).accepted,
      ).toBe(false);
    }
});
