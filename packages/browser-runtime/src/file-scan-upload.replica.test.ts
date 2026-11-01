import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
import { openPrepareOnlyAttachmentUploadWindow } from "./playwright-application-flow";

let server: Server;
let browser: Browser;
let origin: string;
const received: Array<{ path: string; bytes: Buffer; names: string[] }> = [];
const file = {
  name: "synthetic-resume.pdf",
  mimeType: "application/pdf",
  bytes: Buffer.concat([
    Buffer.from("%PDF-1.4 synthetic scanner resume\n"),
    Buffer.alloc(80_000, 32),
  ]),
};

// A scanner receives the same file before the widget stores it. Its receipt
// deliberately names a fileId: that still must not prove an attachment.
const html = `<!doctype html><h1>My Information</h1>
<label for="name">Name</label><input id="name">
<section><h2>Autofill with Resume</h2><label for="resume">Resume</label>
<input id="resume" name="resume" type="file"><p id="status"></p></section>
<script>
const post = async (operation, file) => {
  if (operation === 'uploadfile' && window.variant === 'upload-digest') {
    const bytes = new Uint8Array(await file.arrayBuffer()); bytes[100] ^= 1;
    file = new File([bytes], file.name, {type: file.type});
  }
  const body = new FormData(); body.append('file', file);
  if (window.variant === 'answer' ||
      (operation === 'uploadfile' && window.variant === 'upload-answer'))
    body.append('email', 'alex@example.test');
  if (window.variant === 'extra-file') body.append('another', file);
  const url = '/wday/calypso/cxs/common/synthetic/' + operation +
    (window.variant === 'final-endpoint' ? '?action=submit' : '');
  return fetch(url, {method: 'POST', body});
};
document.querySelector('#resume').onchange = async event => {
  const file = event.target.files[0];
  const status = document.querySelector('#status');
  try {
    await post('scanfile', file);
    status.dataset.phase = 'scanned';
    await new Promise(resolve => { window.finishScan = resolve; });
    await post('uploadfile', file);
    status.textContent = file.name + ' attached';
    status.dataset.phase = 'uploaded';
    event.target.value = '';
    window.replayUpload = () => post('uploadfile', file).catch(() => {});
  } catch { status.dataset.phase = 'blocked'; }
};
</script>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") {
        response.setHeader("content-type", "text/html");
        response.end(html);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      const form = await new Request("http://replica/", {
        method: "POST",
        headers: { "content-type": request.headers["content-type"]! },
        body: Buffer.concat(chunks),
      }).formData();
      const upload = form.get("file") as File;
      received.push({
        path: new URL(request.url!, "http://replica/").pathname,
        bytes: Buffer.from(await upload.arrayBuffer()),
        names: [...form.keys()],
      });
      response.setHeader("content-type", "application/json");
      response.end('{"fileId":"synthetic-file-001"}');
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No replica port");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function fillPage(fieldSaves: boolean) {
  const page = await browser.newPage();
  await page.goto(origin);
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: fieldSaves,
    attachmentUploadsAuthorized: true,
    allowedOrigins: [],
  });
  const controls = (await session.readPage()).controls;
  const ref = (id: string) => {
    const control = controls.find((entry) => entry.id === id)!;
    return control.ref ?? `c${control.index}`;
  };
  await session.fillText(ref("name"), "Alex Vanguard");
  return { page, session, ref };
}

const phase = (page: Page) =>
  page.locator("#status").getAttribute("data-phase");

test.each([false, true])(
  "scan then upload stores the exact resume and no form answer (field saves %s)",
  async (fieldSaves) => {
    const { page, session, ref } = await fillPage(fieldSaves);
    try {
      const before = received.length;
      await session.uploadFile(ref("resume"), file);
      await expect.poll(() => phase(page)).toBe("scanned");
      expect(received.slice(before).map((entry) => entry.path)).toEqual([
        "/wday/calypso/cxs/common/synthetic/scanfile",
      ]);
      expect(
        (await session.readPage()).controls.find(
          (control) => control.id === "resume",
        )?.upload?.network,
      ).toBe("unconfirmed");
      // A press must wait through the scan for the actual storage leg,
      // including a gap longer than the page's network-idle threshold.
      const closed = session.closeUploadWindow();
      await page.waitForTimeout(700);
      await page.evaluate(() =>
        (window as unknown as { finishScan: () => void }).finishScan(),
      );
      await closed;
      await expect.poll(() => phase(page)).toBe("uploaded");
      expect(received.slice(before).map((entry) => entry.path)).toEqual([
        "/wday/calypso/cxs/common/synthetic/scanfile",
        "/wday/calypso/cxs/common/synthetic/uploadfile",
      ]);
      for (const entry of received.slice(before)) {
        expect(entry.bytes).toEqual(file.bytes);
        expect(entry.names).toEqual(["file"]);
      }
      expect(
        (await session.readPage()).controls.find(
          (control) => control.id === "resume",
        )?.upload?.network,
      ).toBe("accepted");
      expect(await page.locator("#name").inputValue()).toBe("Alex Vanguard");
      await page.evaluate(() =>
        (
          window as unknown as { replayUpload: () => Promise<void> }
        ).replayUpload(),
      );
      expect(received).toHaveLength(before + 2);
    } finally {
      await page.close();
    }
  },
);

test.each(["wrong-bytes", "answer", "extra-file", "revoked", "final-endpoint"])(
  "scanfile preserves the %s fence",
  async (variant) => {
    const { page, session } = await fillPage(false);
    try {
      await page.evaluate((value) => {
        Object.assign(window, { variant: value });
      }, variant);
      await openPrepareOnlyAttachmentUploadWindow(page, file, "resume");
      if (variant === "revoked")
        await session.installPrepareOnlyGuard({
          intermediateMutationsAuthorized: false,
          attachmentUploadsAuthorized: false,
          allowedOrigins: [],
        });
      const before = received.length;
      const wrong = Buffer.from(file.bytes);
      wrong[100] = wrong[100]! ^ 1;
      await page.locator("#resume").setInputFiles({
        name: file.name,
        mimeType: file.mimeType,
        buffer: variant === "wrong-bytes" ? wrong : file.bytes,
      });
      await expect.poll(() => phase(page)).toBe("blocked");
      expect(received).toHaveLength(before);
    } finally {
      await page.close();
    }
  },
);

test.each(["upload-answer", "upload-digest", "revoked-after-scan"])(
  "the second leg preserves the %s fence after the scanner answered",
  async (variant) => {
    const { page, session, ref } = await fillPage(false);
    try {
      await page.evaluate((value) => {
        Object.assign(window, { variant: value });
      }, variant);
      const before = received.length;
      await session.uploadFile(ref("resume"), file);
      await expect.poll(() => phase(page)).toBe("scanned");
      if (variant === "revoked-after-scan")
        await session.installPrepareOnlyGuard({
          intermediateMutationsAuthorized: false,
          attachmentUploadsAuthorized: false,
          allowedOrigins: [],
        });
      await page.evaluate(() =>
        (window as unknown as { finishScan: () => void }).finishScan(),
      );
      await expect.poll(() => phase(page)).toBe("blocked");
      expect(received.slice(before).map((entry) => entry.path)).toEqual([
        "/wday/calypso/cxs/common/synthetic/scanfile",
      ]);
      expect(
        (await session.readPage()).controls.find(
          (control) => control.id === "resume",
        )?.upload?.network,
      ).not.toBe("accepted");
    } finally {
      await page.close();
    }
  },
);

test("a scan and upload exhaust the same two-request allowance", async () => {
  const { page, session, ref } = await fillPage(false);
  try {
    const before = received.length;
    await session.uploadFile(ref("resume"), file);
    await expect.poll(() => phase(page)).toBe("scanned");
    await page.evaluate(() =>
      (window as unknown as { finishScan: () => void }).finishScan(),
    );
    await expect.poll(() => phase(page)).toBe("uploaded");
    await page.evaluate(() =>
      (
        window as unknown as { replayUpload: () => Promise<void> }
      ).replayUpload(),
    );
    expect(received).toHaveLength(before + 2);
  } finally {
    await page.close();
  }
});
