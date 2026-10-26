import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";

/**
 * What the Ready card and Needs you say about a resume Fill in for me
 * attached. A file name on the page proves nothing; only the storage's
 * receipt for the exact file the fence let out does.
 */

type Answer =
  | { status: number; body?: string; type?: string }
  | { redirect: string }
  | "hold";

interface Server {
  url: string;
  answers: Map<string, Answer>;
  release: () => void;
  close: () => Promise<void>;
}

const servers: Server[] = [];

async function startServer(html?: string): Promise<Server> {
  const answers = new Map<string, Answer>();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on("end", () => void reply());
      const reply = async () => {
        const path = new URL(request.url ?? "/", "http://x").pathname;
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Headers", "*");
        response.setHeader("Access-Control-Allow-Methods", "POST, PUT");
        if (request.method === "OPTIONS") {
          response.writeHead(204).end();
          return;
        }
        if (path === "/form" && html) {
          response.writeHead(200, { "content-type": "text/html" }).end(html);
          return;
        }
        const answer = answers.get(path) ?? { status: 404 };
        if (answer === "hold") {
          await held;
          response
            .writeHead(201, { "content-type": "application/json" })
            .end('{"uploadId":"up_123"}');
          return;
        }
        if ("redirect" in answer) {
          response.writeHead(307, { Location: answer.redirect }).end();
          return;
        }
        response
          .writeHead(answer.status, {
            "content-type": answer.type ?? "application/json",
          })
          .end(answer.body ?? "");
      };
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const entry: Server = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    answers,
    release: () => release(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(entry);
  return entry;
}

/** A widget that uploads on pick and shows the name before any answer. */
const widget = (target: string) => `<!doctype html><form>
  <label for="resume">Resume</label><input id="resume" name="resume" type="file">
  <span id="chip"></span>
  <label for="emptied">Attach</label><input id="emptied" name="emptied" type="file">
  <button type="button">Submit application</button>
</form><script>
  const resume = document.getElementById("resume");
  resume.addEventListener("change", () => {
    document.getElementById("chip").textContent = resume.files[0].name;
    const body = new FormData();
    body.append("file", resume.files[0]);
    fetch(${JSON.stringify(target)}, { method: "POST", body }).catch(() => {});
  });
  // Greenhouse: take the file, empty the input, send it to storage.
  const emptied = document.getElementById("emptied");
  emptied.addEventListener("change", () => {
    const body = new FormData();
    body.append("key", "uploads/abc123/resume");
    body.append("file", emptied.files[0]);
    const file = emptied.files[0];
    emptied.value = "";
    const request = new XMLHttpRequest();
    request.open("POST", ${JSON.stringify(target)});
    request.send(body);
  });
</script>`;

let browser: Browser;
const pages: Page[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
afterAll(async () => {
  await browser?.close();
});

const resumeFile = (name = "Taylor-Resume.pdf") => ({
  name,
  mimeType: "application/pdf",
  bytes: new Uint8Array(64).fill(37),
});

/** Opens the widget in Fill in for me and attaches the resume the way a run does. */
async function attach(
  target: (site: Server, storage: Server) => string,
  answer: Answer,
  options: { control?: "resume" | "emptied"; name?: string } = {},
) {
  const storage = await startServer();
  const site = await startServer();
  const html = widget(target(site, storage));
  const formSite = await startServer(html);
  storage.answers.set("/storage", answer);
  site.answers.set("/upload", answer);
  const page = await browser.newPage();
  pages.push(page);
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: false,
    attachmentUploadsAuthorized: true,
    allowedOrigins: [],
  });
  await page.goto(`${formSite.url}/form`);
  const id = options.control ?? "resume";
  const control = (await session.readPage()).controls.find(
    (entry) => entry.id === id,
  )!;
  await session.uploadFile(
    control.ref ?? `c${control.index}`,
    resumeFile(options.name),
  );
  const outcome = async () =>
    (await session.readPage()).controls.find((entry) => entry.id === id)?.upload
      ?.network;
  return { page, outcome, storage, site };
}

describe("the server's word on a resume Fill attached", () => {
  test("a refused upload is not attached, though the page shows its name", async () => {
    const { page, outcome } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      { status: 422, body: '{"message":"File too large"}' },
    );
    await expect.poll(outcome).toBe("rejected");
    expect(await page.locator("#chip").innerText()).toBe("Taylor-Resume.pdf");
  });

  test("a bare 200 with no receipt is not attached", async () => {
    const { outcome } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      { status: 200, body: "{}" },
    );
    await expect.poll(outcome).toBe("rejected");
  });

  test("pending until the storage answers, then attached on its receipt", async () => {
    const { outcome, storage } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      "hold",
    );
    await expect.poll(outcome).toBe("pending");
    storage.release();
    await expect.poll(outcome).toBe("accepted");
  });

  test("a widget that empties its input is judged by the file Nestor gave it (S3's empty 204)", async () => {
    const { page, outcome } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      { status: 204 },
      { control: "emptied" },
    );
    await expect.poll(outcome).toBe("accepted");
    expect(await page.locator("#emptied").inputValue()).toBe("");
  });

  test("a storage error document is a refusal", async () => {
    const { outcome } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      {
        status: 200,
        type: "application/xml",
        body: "<Error><Code>AccessDenied</Code></Error>",
      },
    );
    await expect.poll(outcome).toBe("rejected");
  });

  test("an upload whose redirect would leave its endpoint is not attached", async () => {
    const { outcome } = await attach((site) => `${site.url}/upload`, {
      redirect: "/api/submit",
    });
    await expect.poll(outcome).toBe("rejected");
  });

  test("reads a file name outside ASCII", async () => {
    const { outcome } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      { status: 201, body: '{"uploadId":"up_9"}' },
      { name: "履歴書.pdf" },
    );
    await expect.poll(outcome).toBe("accepted");
  });
});
