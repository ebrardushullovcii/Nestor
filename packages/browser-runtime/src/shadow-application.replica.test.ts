import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPrepareOnlyAttachmentUploadWindow } from "./playwright-application-flow";

let server: Server;
let browser: Browser;
let origin: string;
const received: Uint8Array[] = [];
const syntheticPdf = Buffer.concat([
  readFileSync(
    new URL(
      "../../../apps/desktop/test-fixtures/job-finder/resume-import-personas/priya-raman.pdf",
      import.meta.url,
    ),
  ),
  Buffer.alloc(31_269, 32),
]);
const fileName = "synthetic-resume.pdf";
const directory = mkdtempSync(join(tmpdir(), "nestor-shadow-upload-"));
const diskFile = join(directory, fileName);
writeFileSync(diskFile, syntheticPdf);

// Same mechanics as the public form: a File in FormData, its name in the
// parser URL, a shadow-root dropzone, and a manual link in a picker menu.
// This company ID is synthetic and is served only by this loopback fixture.
const syntheticCompanyId = "900000001";
const html = `<!doctype html><div><section><h3>Easy Apply</h3><resume-widget></resume-widget></section><section><h3>Resume *</h3><resume-widget></resume-widget></section>
<section><h3>Personal information</h3><city-widget></city-widget></section></div>
<script>
customElements.define('resume-widget', class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({mode:'open'}).innerHTML = '<div><label for="file">Choose a file or drop it here</label><input id="file" type="file"><p id="status"></p></div>';
    this.shadowRoot.querySelector('input').onchange = e => {
      const file = e.target.files[0];
      const body = new FormData(); body.append('file', file);
      if (window.uploadVariant === 'answer') body.append('email', 'synthetic@example.test');
      if (window.uploadVariant === 'extra-file') body.append('another', file);
      const endpoint = '/oneclick-ui/api/company/${syntheticCompanyId}/resume/parse?filename=' + encodeURIComponent(file.name);
      if (window.uploadTransport === 'fetch') {
        fetch(endpoint, {method:'POST',body}).then(() => {this.shadowRoot.querySelector('#status').textContent = file.name + ' attached';}).catch(() => {});
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.onload = () => {this.shadowRoot.querySelector('#status').textContent = file.name + ' attached';};
      xhr.send(body);
    };
  }
});
customElements.define('city-widget', class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({mode:'open'}).innerHTML = '<div><city-input></city-input><div role="listbox"><manual-switch onclick="return false;">Cannot find your city? Click here to fill in manually</manual-switch></div></div>';
  }
});
customElements.define('city-input', class extends HTMLElement {
  connectedCallback() {this.attachShadow({mode:'open'}).innerHTML='<label for="city">City*</label><input id="city" role="combobox" aria-required="true">';}
});
customElements.define('manual-switch', class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({mode:'open'}).innerHTML = '<a href=""><slot></slot></a>';
    this.addEventListener('click', e => {
      e.preventDefault();
      this.getRootNode().host.shadowRoot.innerHTML = '<label>Country<select required><option value="">Select</option><option>Hungary</option></select></label><label>City<input required></label>';
    });
  }
});
</script>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET") return void res.end(html);
      const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      const form = await new Request("http://replica/", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"]! },
        body: Buffer.concat(chunks),
      }).formData();
      received.push(
        new Uint8Array(await (form.get("file") as File).arrayBuffer()),
      );
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          fileId: "synthetic-resume-123",
          fileName: "Alex Vanguard CV.pdf",
        }),
      );
    })().catch(() => {
      res.statusCode = 500;
      res.end();
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

test.each(["bytes", "disk"])(
  "shadow-root resume parser verifies the complete >64KiB %s file",
  async (method) => {
    const page = await browser.newPage();
    await page.goto(origin);
    const session = createPlaywrightApplyPageSession({ page });
    await session.installPrepareOnlyGuard({
      intermediateMutationsAuthorized: true,
      attachmentUploadsAuthorized: true,
      allowedOrigins: [],
    });
    const raw = await session.readPage();
    const file = raw.controls.find((c) => c.label === "Resume *")!;
    expect(file.label).toBe("Resume *");
    const before = received.length;
    const payload = {
      name: fileName,
      mimeType: "application/pdf",
      bytes: syntheticPdf,
    };
    if (method === "bytes")
      expect(
        await session.uploadFile(file.ref ?? `c${file.index}`, payload),
      ).toMatchObject({ ok: true });
    else {
      await openPrepareOnlyAttachmentUploadWindow(page, payload, "file");
      await page
        .locator("resume-widget")
        .last()
        .locator("input[type=file]")
        .setInputFiles(diskFile);
    }
    await expect.poll(() => received.length).toBe(before + 1);
    expect(Buffer.from(received.at(-1)!)).toEqual(syntheticPdf);
    expect(
      (await session.readPage()).controls.find((c) => c.label === "Resume *")
        ?.upload?.network,
    ).toBe("accepted");
    await page.close();
  },
);

test("a shadow-root manual city control retains its form context", async () => {
  const page = await browser.newPage();
  await page.goto(origin);
  const session = createPlaywrightApplyPageSession({ page });
  const raw = await session.readPage();
  const manual = raw.clickables.find((a) =>
    a.label.includes("Cannot find your city"),
  )!;
  expect(manual).toMatchObject({ inForm: true });
  const clicked = await session.clickElement(manual.ref ?? `e${manual.index}`);
  expect(clicked, JSON.stringify(clicked)).toMatchObject({ ok: true });
  expect(
    (await session.readPage()).controls
      .filter((c) => c.required)
      .map((c) => c.label),
  ).toEqual(["Country", "City"]);
  const fields = (await session.readPage()).controls;
  const country = fields.find((c) => c.tagName === "select")!;
  const city = fields.find((c) => c.label === "City")!;
  expect(
    await session.chooseOption(country.ref ?? `c${country.index}`, "Hungary"),
  ).toMatchObject({ ok: true });
  expect(
    await session.fillText(city.ref ?? `c${city.index}`, "Budapest"),
  ).toMatchObject({ ok: true });
  expect(
    (await session.readPage()).controls
      .filter((c) => c.required)
      .map((c) => c.value),
  ).toEqual(["Hungary", "Budapest"]);
  await page.close();
});
