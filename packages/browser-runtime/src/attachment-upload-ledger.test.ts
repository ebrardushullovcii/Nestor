import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
import resumeReceipt from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/resume-storage-receipt.json";

/**
 * What the Ready card and Needs you say about a resume Fill in for me
 * attached. A file name on the page proves nothing; only the storage's
 * receipt for the exact file the fence let out does.
 */

type Answer =
  | { status: number; body?: string; type?: string }
  | { redirect: string }
  | "hold"
  | "drop";

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
        if (answer === "drop") {
          request.socket.destroy();
          return;
        }
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
  test("a parser's storage handle settles the selected file as attached", async () => {
    const { outcome } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      {
        status: 200,
        body: JSON.stringify(resumeReceipt.response),
        type: "application/json",
      },
    );
    await expect.poll(outcome).toBe("accepted");
  });

  test("a refused upload is not attached, though the page shows its name", async () => {
    const { page, outcome } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      { status: 422, body: '{"message":"File too large"}' },
    );
    await expect.poll(outcome).toBe("rejected");
    expect(await page.locator("#chip").innerText()).toBe("Taylor-Resume.pdf");
  });

  test("request diagnostics preserve path case and exclude the query", async () => {
    const { page, outcome, storage } = await attach(
      (_site, storage) =>
        `${storage.url}/Storage/Upload?signature=do-not-record`,
      { status: 503 },
    );
    // This deliberately unmatched path gets the replica's 404 response.
    await expect.poll(outcome).toBe("rejected");
    const raw = await createPlaywrightApplyPageSession({ page }).readPage();
    const requests = raw.controls.find((control) => control.id === "resume")
      ?.upload?.requests;
    expect(requests).toEqual([
      {
        endpoint: `${new URL(storage.url).host}/Storage/Upload`,
        status: 404,
        blocked: false,
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain("signature");
  });

  test("a bare 200 with no receipt is not attached", async () => {
    const { outcome } = await attach(
      (_site, storage) => `${storage.url}/storage`,
      { status: 200, body: "{}" },
    );
    await expect.poll(outcome).toBe("unconfirmed");
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

describe("a raw storage PUT", () => {
  /** Two inputs that each PUT their file, as text/plain, to its own path. */
  const putWidget = (storage: string) => `<!doctype html><form>
    <label for="resume">Resume</label><input id="resume" name="resume" type="file">
    <label for="letter">Cover letter</label><input id="letter" name="letter" type="file">
  </form><script>
    for (const id of ["resume", "letter"]) {
      const input = document.getElementById(id);
      input.addEventListener("change", () => {
        fetch(${JSON.stringify(storage)} + "/" + id, {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body: input.files[0],
        }).catch(() => {});
      });
    }
  </script>`;

  async function attachBoth(answers: { resume: Answer; letter: Answer }) {
    const storage = await startServer();
    storage.answers.set("/storage/resume", answers.resume);
    storage.answers.set("/storage/letter", answers.letter);
    const formSite = await startServer(putWidget(`${storage.url}/storage`));
    const page = await browser.newPage();
    pages.push(page);
    const session = createPlaywrightApplyPageSession({ page });
    await session.installPrepareOnlyGuard({
      intermediateMutationsAuthorized: false,
      attachmentUploadsAuthorized: true,
      allowedOrigins: [],
    });
    await page.goto(`${formSite.url}/form`);
    const read = async (id: string) =>
      (await session.readPage()).controls.find((entry) => entry.id === id)!;
    const resume = await read("resume");
    await session.uploadFile(
      resume.ref ?? `c${resume.index}`,
      resumeFile("Taylor-Resume.txt"),
    );
    const letter = await read("letter");
    // Same size as the resume, different file.
    await session.uploadFile(letter.ref ?? `c${letter.index}`, {
      name: "Taylor-Letter.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array(64).fill(38),
    });
    return async (id: string) => (await read(id)).upload?.network;
  }

  test("a text/plain resume PUT that got 422 is a refused carrier, not a missing outcome", async () => {
    const outcome = await attachBoth({
      resume: { status: 422, body: '{"message":"Upload failed"}' },
      letter: { status: 422, body: '{"message":"Upload failed"}' },
    });
    await expect.poll(() => outcome("resume")).toBe("rejected");
  });

  test("a resume PUT whose connection drops is refused, and one still waiting is pending, never attached", async () => {
    const dropped = await attachBoth({
      resume: "drop",
      letter: { status: 201, body: '{"uploadId":"up_7"}' },
    });
    await expect.poll(() => dropped("resume")).toBe("rejected");
    const waiting = await attachBoth({
      resume: "hold",
      letter: { status: 201, body: '{"uploadId":"up_7"}' },
    });
    await expect.poll(() => waiting("letter")).toBe("accepted");
    expect(await waiting("resume")).toBe("pending");
  });

  test("a same-size cover letter that succeeded never clears the failed resume", async () => {
    const outcome = await attachBoth({
      resume: { status: 422, body: '{"message":"Upload failed"}' },
      letter: { status: 201, body: '{"uploadId":"up_7"}' },
    });
    await expect.poll(() => outcome("letter")).toBe("accepted");
    expect(await outcome("resume")).toBe("rejected");
  });
});

// Candidate 5 workday replica: after the resume was attached, "Add" inserted a
// work-history row above it. Refs are positions, so the file Nestor gave was
// no longer found by ref and the form's own file became "upload not confirmed".
test("the file Nestor gave stays known after the form inserts a row above it, and a replaced file does not", async () => {
  const site = await startServer(`<!doctype html>
<form method="post" action="/apply" enctype="multipart/form-data">
  <div id="rows"><label>Job title<input name="experience1Title"></label></div>
  <label for="resume">Resume / CV</label><input id="resume" name="resume" type="file">
</form>`);
  const page = await browser.newPage();
  pages.push(page);
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: false,
    attachmentUploadsAuthorized: true,
    allowedOrigins: [],
  });
  await page.goto(`${site.url}/form`);
  const before = (await session.readPage()).controls.find(
    (entry) => entry.id === "resume",
  )!;
  const file = resumeFile();
  await session.uploadFile(before.ref ?? `c${before.index}`, file);
  // The form adds a row above the field, as Add does.
  await page.evaluate(() => {
    const rows = document.getElementById("rows")!;
    for (const name of ["experience2Title", "experience2Company"])
      rows.insertAdjacentHTML(
        "beforeend",
        `<label>${name}<input name="${name}"></label>`,
      );
  });
  const after = (await session.readPage()).controls.find(
    (entry) => entry.id === "resume",
  )!;
  expect(after.index).not.toBe(before.index);
  expect(after.upload).toMatchObject({
    fileName: file.name,
    fileSize: file.bytes.length,
    selectedFileName: file.name,
    selectedFileSize: file.bytes.length,
    formSubmits: true,
  });
  // The page swaps in another file: it is not the one Nestor gave.
  await page.locator("#resume").setInputFiles({
    name: "Other.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(10, 1),
  });
  const replaced = (await session.readPage()).controls.find(
    (entry) => entry.id === "resume",
  )!;
  expect(replaced.upload?.selectedFileName).toBeUndefined();
  expect(replaced.upload?.fileName).toBe("Other.pdf");
});

// Name and size alone never choose between possible attachments.
test("two distinct attachments retain their own identity when a new input shifts onto an old ref", async () => {
  const site = await startServer(
    `<!doctype html><form method="post" enctype="multipart/form-data"><div id="rows"></div><label for="resume">Resume</label><input id="resume" type="file"><label for="letter">Letter</label><input id="letter" type="file"></form>`,
  );
  const page = await browser.newPage();
  pages.push(page);
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: false,
    attachmentUploadsAuthorized: true,
    allowedOrigins: [],
  });
  await page.goto(`${site.url}/form`);
  const before = await session.readPage();
  const resume = resumeFile();
  const letter = {
    ...resume,
    name: "Letter.pdf",
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
  };
  for (const [id, file] of [
    ["resume", resume],
    ["letter", letter],
  ] as const) {
    const control = before.controls.find((entry) => entry.id === id)!;
    await session.uploadFile(control.ref ?? `c${control.index}`, file);
  }
  await page.locator("#rows").evaluate((node) => {
    node.innerHTML = '<label>New row<input name="newRow"></label>';
  });
  const after = await session.readPage();
  expect(
    after.controls.find((entry) => entry.id === "resume")?.upload,
  ).toMatchObject({
    fileName: resume.name,
    selectedFileName: resume.name,
    selectedFileSize: resume.bytes.length,
  });
  expect(
    after.controls.find((entry) => entry.id === "letter")?.upload,
  ).toMatchObject({
    fileName: letter.name,
    selectedFileName: letter.name,
    selectedFileSize: letter.bytes.length,
  });
});

test("an uploaded file stays with its original DOM input after rows move, even when another holds identical bytes", async () => {
  const site = await startServer(`<!doctype html>
<form method="post" action="/apply" enctype="multipart/form-data">
  <div id="rows"></div>
  <label for="resume">Resume</label><input id="resume" name="resume" type="file">
  <label for="copy">Other document</label><input id="copy" name="copy" type="file">
</form>`);
  const page = await browser.newPage();
  pages.push(page);
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: false,
    attachmentUploadsAuthorized: true,
    allowedOrigins: [],
  });
  await page.goto(`${site.url}/form`);
  const before = (await session.readPage()).controls.find(
    (entry) => entry.id === "resume",
  )!;
  const file = resumeFile();
  await session.uploadFile(before.ref ?? `c${before.index}`, file);
  // The page puts the same bytes in a second input, then a row moves both.
  await page.locator("#copy").setInputFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.bytes),
  });
  await page.evaluate(() => {
    document
      .getElementById("rows")!
      .insertAdjacentHTML(
        "beforeend",
        '<label>Job title<input name="title"></label>',
      );
  });
  const read = await session.readPage();
  expect(
    read.controls.find((entry) => entry.id === "resume")?.upload
      ?.selectedFileName,
  ).toBe(file.name);
  expect(
    read.controls.find((entry) => entry.id === "copy")?.upload
      ?.selectedFileName,
  ).toBeUndefined();
});

test("a genuine upload survives more than sixty later raw requests", async () => {
  const { page, outcome, site } = await attach((site) => `${site.url}/upload`, {
    status: 201,
    body: JSON.stringify({ fileId: "synthetic-upload-123" }),
  });
  await expect.poll(outcome).toBe("accepted");
  site.answers.set("/noise", { status: 204 });
  await page.evaluate(async (base) => {
    for (let i = 0; i < 100; i++)
      await fetch(`${base}/noise`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "ordinary site activity",
      });
  }, site.url);
  expect(await outcome()).toBe("accepted");
});
