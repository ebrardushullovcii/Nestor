import { describe, expect, it } from "vitest";

import { FAILURE_SENTENCES } from "../../lib/describe-failure";
import { resolveVisibleRouteActionMessage } from "./applications-screen-helpers";

/**
 * A batch that ended with applications waiting on the person is not a form
 * they mis-filled. Applications printed the form-validation sentence — "Check
 * the fields you just changed and try again" — above a run the person had
 * edited nothing for.
 */
describe("the one route status Applications presents", () => {
  it("replaces the form-validation sentence with the application outcome", () => {
    expect(
      resolveVisibleRouteActionMessage({
        actionMessage: FAILURE_SENTENCES.invalid_details,
        latestRunAttentionCount: 5,
      }),
    ).toBe(
      "5 applications need you; open each to see what the site asked for.",
    );
  });

  it("keeps the sentence singular for one application", () => {
    expect(
      resolveVisibleRouteActionMessage({
        actionMessage: FAILURE_SENTENCES.invalid_details,
        latestRunAttentionCount: 1,
      }),
    ).toBe("1 application needs you; open it to see what the site asked for.");
  });

  it("leaves the form-validation sentence alone when no batch is waiting", () => {
    expect(
      resolveVisibleRouteActionMessage({
        actionMessage: FAILURE_SENTENCES.invalid_details,
        latestRunAttentionCount: 0,
      }),
    ).toBe(FAILURE_SENTENCES.invalid_details);
  });

  it("leaves every other route status untouched", () => {
    expect(
      resolveVisibleRouteActionMessage({
        actionMessage: FAILURE_SENTENCES.offline,
        latestRunAttentionCount: 5,
      }),
    ).toBe(FAILURE_SENTENCES.offline);
  });
});
