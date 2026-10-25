import { describe, expect, test } from "vitest";
import {
  carriesPreparedValue,
  isGraphQlReadBody,
  isPageOwnedReadRequest,
  isTelemetryRequestUrl,
  requestUrlCarriesPreparedValue,
} from "./application-read-request-policy";

describe("page-owned read policy", () => {
  const prepared = ["Jamie Rivers", "jamie@example.com", "+49 555 0000000"];

  test("matches prepared URL query values without treating cache-buster keys as form data", () => {
    expect(
      requestUrlCarriesPreparedValue(
        "https://site.test/pixel?email=jamie%40example.com",
        prepared,
      ),
    ).toBe(true);
    expect(
      requestUrlCarriesPreparedValue(
        "https://site.test/chevron.svg?223234",
        ["223234"],
      ),
    ).toBe(false);
  });

  test("allows safe-method reads with or without a query when nothing prepared rides along", () => {
    for (const url of [
      "https://site.test/lang/en-US.json",
      "https://site.test/api/applications?type=active&posting=R1",
      "https://cdn.test/.vite/manifest.json",
    ]) {
      expect(
        isPageOwnedReadRequest({
          method: "GET",
          url,
          preparedValues: prepared,
        }),
      ).toBe(true);
    }
    expect(
      isPageOwnedReadRequest({
        method: "HEAD",
        url: "https://site.test/ping",
        preparedValues: prepared,
      }),
    ).toBe(true);
  });

  test("refuses a read that carries a prepared value, encoded or not", () => {
    expect(
      isPageOwnedReadRequest({
        method: "GET",
        url: "https://site.test/form?email=jamie%40example.com",
        preparedValues: prepared,
      }),
    ).toBe(false);
    expect(
      isPageOwnedReadRequest({
        method: "GET",
        url: "https://site.test/autosave/Jamie Rivers",
        preparedValues: prepared,
      }),
    ).toBe(false);
    expect(carriesPreparedValue("x=ab", ["ab"])).toBe(false);
  });

  test("recognizes GraphQL query documents and rejects mutations", () => {
    expect(
      isGraphQlReadBody(
        JSON.stringify({
          operationName: "ApiOrganizationFromHostedJobsPageName",
          query:
            "# hosted page\nquery ApiOrganizationFromHostedJobsPageName($name: String!) { organization(name: $name) { id } }",
          variables: { name: "constructor" },
        }),
      ),
    ).toBe(true);
    expect(
      isGraphQlReadBody(JSON.stringify({ query: "{ viewer { id } }" })),
    ).toBe(true);
    expect(
      isGraphQlReadBody(
        JSON.stringify([
          { query: "query A { a }" },
          { query: "mutation SubmitApplication { submit { id } }" },
        ]),
      ),
    ).toBe(false);
    expect(
      isGraphQlReadBody(JSON.stringify({ query: "subscription { tick }" })),
    ).toBe(false);
    expect(isGraphQlReadBody('{"answers":{"email":"x"}}')).toBe(false);
    expect(isGraphQlReadBody("not json")).toBe(false);
  });

  test("allows a GraphQL read POST only when it carries nothing prepared", () => {
    const clean = JSON.stringify({
      query: "query Posting($id: ID!) { posting(id: $id) { title } }",
      variables: { id: "R1" },
    });
    const leaking = JSON.stringify({
      query: "query Check($email: String!) { exists(email: $email) }",
      variables: { email: "jamie@example.com" },
    });
    expect(
      isPageOwnedReadRequest({
        method: "POST",
        url: "https://site.test/api/graphql",
        bodyText: clean,
        preparedValues: prepared,
      }),
    ).toBe(true);
    expect(
      isPageOwnedReadRequest({
        method: "POST",
        url: "https://site.test/api/graphql",
        bodyText: leaking,
        preparedValues: prepared,
      }),
    ).toBe(false);
    expect(
      isPageOwnedReadRequest({
        method: "POST",
        url: "https://site.test/api/save",
        bodyText: '{"firstName":"Jamie"}',
        preparedValues: prepared,
      }),
    ).toBe(false);
    expect(
      isPageOwnedReadRequest({
        method: "PUT",
        url: "https://site.test/api/graphql",
        bodyText: clean,
        preparedValues: prepared,
      }),
    ).toBe(false);
  });

  test("recognizes generic telemetry URL shapes without confusing ordinary paths", () => {
    for (const url of [
      "https://remoteok.com/cdn-cgi/rum?",
      "https://jobs.test/cdn-cgi/beacon",
      "https://jobs.test/api/beacon/events",
      "https://jobs.test/rum",
      "https://jobs.test/analytics/event",
      "https://www.google-analytics.com/g/collect",
      "https://stats.doubleclick.net/activity",
      "https://api.segment.io/v1/t",
      "https://api.mixpanel.com/track",
      "https://static.hotjar.com/c/hotjar.js",
      "https://o123.ingest.sentry.io/api/456/envelope/",
      "https://sa.remoteok.com/simple.gif?https=true&page_id=abc&type=pageview",
    ]) {
      expect(isTelemetryRequestUrl(url), url).toBe(true);
      expect(
        isPageOwnedReadRequest({
          method: "POST",
          url,
          bodyText: '{"event":"pageview"}',
          preparedValues: prepared,
        }),
        url,
      ).toBe(true);
    }
    expect(isTelemetryRequestUrl("https://jobs.test/login")).toBe(false);
    expect(isTelemetryRequestUrl("https://jobs.test/catalog")).toBe(false);
    expect(isTelemetryRequestUrl("https://jobs.test/v1/collect")).toBe(false);
    expect(isTelemetryRequestUrl("https://jobs.test/log")).toBe(false);
  });

  test("blocks a prepared value on a telemetry-looking application endpoint", () => {
    expect(
      isPageOwnedReadRequest({
        method: "POST",
        url: "https://jobs.test/applications/collect/answers",
        bodyText: "email=jamie%40example.com",
        preparedValues: prepared,
      }),
    ).toBe(false);
  });

  test("allows clean telemetry POST and GET requests", () => {
    expect(
      isPageOwnedReadRequest({
        method: "POST",
        url: "https://jobs.test/cdn-cgi/rum",
        bodyText: "opaque-rum-payload",
        preparedValues: prepared,
      }),
    ).toBe(true);
    expect(
      isPageOwnedReadRequest({
        method: "GET",
        url: "https://jobs.test/analytics/collect",
        bodyText: null,
        preparedValues: prepared,
      }),
    ).toBe(true);
  });

  test("does not exempt form-shaped bodies or arbitrary telemetry methods", () => {
    expect(
      isPageOwnedReadRequest({
        method: "POST",
        url: "https://jobs.test/cdn-cgi/rum",
        bodyText: "email=somebody%40example.com",
        preparedValues: prepared,
      }),
    ).toBe(false);
    expect(
      isPageOwnedReadRequest({
        method: "DELETE",
        url: "https://jobs.test/analytics/event",
        preparedValues: prepared,
      }),
    ).toBe(false);
  });
});
