import type {
  ApplyClickFacts,
  SubmissionActionRequest,
} from "@nestor/contracts";
import type { Page, Request, Response } from "playwright";

/** Observe a press without deciding what it means or changing its execution. */
export function watchPagePress(page: Page): { finish: () => ApplyClickFacts } {
  const readPage = () => {
    try {
      const url = new URL(page.url());
      return { origin: url.origin, safePath: url.pathname };
    } catch {
      return { origin: null, safePath: null };
    }
  };
  const pageBefore = readPage();
  const requests: SubmissionActionRequest[] = [];
  const byRequest = new Map<Request, SubmissionActionRequest>();
  const onRequest = (request: Request) => {
    try {
      const url = new URL(request.url());
      const entry: SubmissionActionRequest = {
        method: request.method(),
        host: url.host,
        path: url.pathname,
        status: null,
        failure: null,
        finalSubmit: false,
      };
      requests.push(entry);
      byRequest.set(request, entry);
    } catch {
      /* A non-URL request has no host/path to report. */
    }
  };
  const onResponse = (response: Response) => {
    const entry = byRequest.get(response.request());
    if (entry) entry.status = response.status();
  };
  const onFailure = (request: Request) => {
    const entry = byRequest.get(request);
    if (entry) entry.failure = request.failure()?.errorText ?? "failed";
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailure);
  return {
    finish: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailure);
      const pageAfter = readPage();
      return {
        pageBefore,
        pageAfter,
        urlChanged:
          pageBefore.origin !== pageAfter.origin ||
          pageBefore.safePath !== pageAfter.safePath,
        requestsAfterClick: requests,
      };
    },
  };
}
