import { describe, expect, it } from "vitest";
import { isActionNews, isActionSuccessToast } from "./action-news-toast";
it.each(["Application tracker updated.", "Activity resumed."])(
  "uses a toast for %s",
  (message) => expect(isActionNews(message)).toBe(true),
);
it.each([null, "Could not save the tracker.", "Activity could not resume."])(
  "keeps actionable errors inline",
  (message) => expect(isActionNews(message)).toBe(false),
);

describe("isActionSuccessToast", () => {
  const success = {
    message: "2 applications started.",
    tone: "success",
  } as const;

  it("toasts a success on Applications and Find jobs", () => {
    expect(isActionSuccessToast(success, "/job-finder/applications")).toBe(
      true,
    );
    expect(
      isActionSuccessToast(success, "/job-finder/applications/record-1"),
    ).toBe(true);
    expect(isActionSuccessToast(success, "/job-finder/discovery")).toBe(true);
  });

  it("never toasts a failure, a message in progress or an untoned message", () => {
    const route = "/job-finder/applications";
    expect(
      isActionSuccessToast(
        { message: "Could not start.", tone: "failure" },
        route,
      ),
    ).toBe(false);
    expect(
      isActionSuccessToast({ message: "Starting…", tone: "progress" }, route),
    ).toBe(false);
    expect(
      isActionSuccessToast({ message: "Something happened." }, route),
    ).toBe(false);
    expect(
      isActionSuccessToast({ message: null, tone: "success" }, route),
    ).toBe(false);
  });

  it("keeps a saved-file message inline and leaves other screens unchanged", () => {
    expect(
      isActionSuccessToast(
        { ...success, savedFilePath: "/tmp/export.csv" },
        "/job-finder/applications",
      ),
    ).toBe(false);
    expect(isActionSuccessToast(success, "/job-finder/profile")).toBe(false);
    expect(
      isActionSuccessToast(success, "/job-finder/applications-archive"),
    ).toBe(false);
    expect(isActionSuccessToast(success, null)).toBe(false);
  });
});
