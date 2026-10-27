import { describe, expect, test } from "vitest";
import {
  classifyStrictFillRead,
  uploadHopStaysOnEndpoint,
} from "./application-fill-request-policy";

// "PT" is a native select's value for the declared "Portugal".
const prepared = ["Robin Ashford", "robin@example.test", "Portugal", "PT"];
const read = (
  method: string,
  resourceType: string,
  url: string,
): ReturnType<typeof classifyStrictFillRead>["reason"] =>
  classifyStrictFillRead({
    method,
    resourceType,
    url,
    preparedValues: prepared,
  }).reason;

describe("Fill in for me: the read decision table", () => {
  // Every row that is not a plain read ends in a refusal.
  test.each([
    // A navigation the page started (a script, a link it followed).
    [
      "GET",
      "document",
      "https://jobs.example.test/jobs/1/apply",
      "final_signal",
    ],
    [
      "GET",
      "document",
      "https://jobs.example.test/api/submit?applicationId=42",
      "final_signal",
    ],
    ["GET", "document", "https://jobs.example.test/jobs/1", "plain_read"],
    ["GET", "fetch", "https://jobs.example.test/api/jobs/1", "plain_read"],
    [
      "GET",
      "script",
      "https://jobs.example.test/js/register-form.js",
      "plain_read",
    ],
    ["GET", "image", "https://jobs.example.test/logo.png", "plain_read"],
    ["OPTIONS", "fetch", "https://storage.example.test/upload", "plain_read"],
    ["POST", "fetch", "https://jobs.example.test/api/save", "not_a_read"],
    ["PUT", "xhr", "https://jobs.example.test/api/answers", "not_a_read"],
    ["PATCH", "fetch", "https://jobs.example.test/api/draft", "not_a_read"],
    ["DELETE", "fetch", "https://jobs.example.test/api/draft", "not_a_read"],
    ["POST", "document", "https://jobs.example.test/apply", "not_a_read"],
    [
      "GET",
      "websocket",
      "wss://jobs.example.test/socket",
      "denied_resource_type",
    ],
    [
      "GET",
      "eventsource",
      "https://jobs.example.test/events",
      "denied_resource_type",
    ],
    ["GET", "ping", "https://jobs.example.test/ping", "denied_resource_type"],
    [
      "GET",
      "image",
      "https://jobs.example.test/pixel.gif?e=submit",
      "beacon_query",
    ],
    ["GET", "other", "https://jobs.example.test/collect?x=1", "beacon_query"],
    [
      "GET",
      "fetch",
      "https://jobs.example.test/api/submit?applicationId=42",
      "final_signal",
    ],
    [
      "GET",
      "xhr",
      "https://jobs.example.test/api/application/finalize",
      "final_signal",
    ],
    [
      "GET",
      "fetch",
      "https://jobs.example.test/api/x?status=submitted",
      "final_signal",
    ],
    ["GET", "fetch", "https://jobs.example.test/api/%73ubmit", "final_signal"],
    [
      "GET",
      "fetch",
      "https://jobs.example.test/api/echo?name=Robin%20Ashford",
      "carries_answer",
    ],
    [
      "GET",
      "document",
      "https://jobs.example.test/apply?email=robin@example.test",
      "carries_answer",
    ],
    ["GET", "fetch", "not a url", "unreadable_url"],
    [
      "GET",
      "fetch",
      "https://jobs.example.test/api/save?country=PT",
      "carries_answer",
    ],
    [
      "GET",
      "fetch",
      "https://jobs.example.test/api/cities/PT",
      "carries_answer",
    ],
    [
      "GET",
      "fetch",
      "https://jobs.example.test/api/applications?status=open",
      "plain_read",
    ],
  ])("%s %s %s -> %s", (method, type, url, reason) => {
    expect(read(method, type, url)).toBe(reason);
  });

  test("no generated write method is ever a read", () => {
    for (const method of [
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "post",
      " Post ",
      "PROPFIND",
      "",
    ])
      for (const type of ["fetch", "xhr", "document", "other", "beacon"])
        expect(
          classifyStrictFillRead({
            method,
            resourceType: type,
            url: "https://jobs.example.test/api/anything",
            preparedValues: prepared,
          }).allowed,
        ).toBe(false);
  });

  test("a scripted GET naming a final action in any casing or encoding is refused", () => {
    for (const word of [
      "submit",
      "Submit",
      "SUBMIT",
      "submitted",
      "finalize",
      "finalise",
    ])
      for (const shape of [
        `/api/${word}`,
        `/api/x?action=${word}`,
        `/api/x?${encodeURIComponent(`step=${word}`)}`,
      ])
        expect(
          read("GET", "fetch", `https://jobs.example.test${shape}`),
          shape,
        ).toBe("final_signal");
  });
});

describe("Fill in for me: navigations the run itself opened", () => {
  const run = (url: string) =>
    classifyStrictFillRead({
      method: "GET",
      resourceType: "document",
      url,
      preparedValues: prepared,
      navigation: "run",
    }).reason;
  test.each([
    // The form it was started on may live at /apply; nothing may submit.
    ["https://jobs.example.test/jobs/1/apply", "plain_read"],
    [
      "https://jobs.example.test/workday/apply/1?stage=application",
      "plain_read",
    ],
    ["https://jobs.example.test/api/submit?applicationId=42", "final_signal"],
    [
      "https://jobs.example.test/apply/1?action=submit&final=true",
      "final_signal",
    ],
    ["https://jobs.example.test/jobs/1/complete", "final_signal"],
    [
      "https://jobs.example.test/apply?email=robin%40example.test",
      "carries_answer",
    ],
  ])("%s -> %s", (url, reason) => {
    expect(run(url)).toBe(reason);
  });
});

describe("Fill in for me: GraphQL", () => {
  const graphQl = (query: string, resourceType = "fetch") =>
    classifyStrictFillRead({
      method: "POST",
      resourceType,
      url: "https://jobs.example.test/api/non-user-graphql?op=Posting",
      bodyText: JSON.stringify({ query }),
      preparedValues: prepared,
    }).reason;
  test.each([
    ["query Posting { posting { title } }", "fetch", "graphql_query"],
    ["{ posting { title } }", "xhr", "graphql_query"],
    [
      'query Check { exists(email: "robin@example.test") }',
      "fetch",
      "carries_answer",
    ],
    [
      "query SubmitApplication { submitApplication { id } }",
      "fetch",
      "final_signal",
    ],
    ["mutation Save { save { id } }", "fetch", "not_a_read"],
    // A comment ended by CR, and an anonymous query beside a mutation.
    ["{ a }\n# note\rmutation M { m }", "fetch", "not_a_read"],
    ["# note\rmutation M { m }", "fetch", "not_a_read"],
    [
      'query Q($e: String = "robin\\u0040example.test") { x(e: $e) }',
      "fetch",
      "carries_answer",
    ],
    ['query Q { country(code: "PT") { name } }', "fetch", "carries_answer"],
    ["query Posting { posting { title } }", "document", "not_a_read"],
    ["query Posting { posting { title } }", "other", "not_a_read"],
  ])("%s as %s -> %s", (query, type, reason) => {
    expect(graphQl(query, type)).toBe(reason);
  });
});

describe("an upload's redirect", () => {
  test.each([
    [
      "https://s.example.test/upload",
      "/upload?part=2",
      "https://s.example.test/upload?part=2",
    ],
    ["https://s.example.test/upload", "/api/submit", null],
    ["https://s.example.test/upload", "/upload?action=submit&final=true", null],
    [
      "https://s.example.test/upload",
      "/upload?email=robin%40example.test",
      null,
    ],
    [
      "https://s.example.test/upload",
      "https://other.example.test/upload",
      null,
    ],
    ["https://s.example.test/upload", "/upload/../apply", null],
    ["https://s.example.test/upload", "", "https://s.example.test/upload"],
    ["https://s.example.test/upload", "http://[bad", null],
  ])(
    "from %s to %j stays only on the same endpoint",
    (from, location, next) => {
      expect(uploadHopStaysOnEndpoint(from, location, prepared)).toBe(next);
    },
  );
});

describe("Fill in for me: a list that depends on a picker choice", () => {
  // The run just chose "Portugal" (submitted as "PT") in a country picker.
  const dependent = (
    url: string,
    overrides: Partial<Parameters<typeof classifyStrictFillRead>[0]> = {},
  ) =>
    classifyStrictFillRead({
      method: "GET",
      resourceType: "fetch",
      url,
      preparedValues: prepared,
      pickerChoices: ["Portugal", "PT"],
      frameOrigin: "https://jobs.example.test",
      ...overrides,
    }).reason;

  test.each([
    ["https://jobs.example.test/api/regions?country=PT", "dependent_list"],
    [
      "https://jobs.example.test/api/countries/Portugal/cities",
      "dependent_list",
    ],
    // Another origin, or an answer that is not the choice, stays refused.
    ["https://other.example.test/api/regions?country=PT", "carries_answer"],
    [
      "https://jobs.example.test/api/regions?country=PT&email=robin@example.test",
      "carries_answer",
    ],
    // An address that names a write is refused whatever it carries.
    ["https://jobs.example.test/api/regions/save?country=PT", "carries_answer"],
    [
      "https://jobs.example.test/api/regions?country=PT&action=update",
      "carries_answer",
    ],
    ["https://jobs.example.test/api/autoSave?country=PT", "carries_answer"],
    ["https://jobs.example.test/api/postRegion?country=PT", "carries_answer"],
    ["https://jobs.example.test/apply/regions?country=PT", "carries_answer"],
  ])("%s → %s", (url, reason) => {
    expect(dependent(url)).toBe(reason);
  });

  test("only a just-made choice, only from the page's own scripts, only a GET", () => {
    const url = "https://jobs.example.test/api/regions?country=PT";
    expect(dependent(url, { pickerChoices: [] })).toBe("carries_answer");
    expect(dependent(url, { resourceType: "document" })).toBe("carries_answer");
    expect(dependent(url, { resourceType: "image" })).toBe("beacon_query");
    expect(dependent(url, { method: "POST" })).toBe("not_a_read");
  });
});
