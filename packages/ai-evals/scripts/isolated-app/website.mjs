// The public website (apps/website) from this checkout, in headless Chromium.
// Serves the folder on a free loopback port and blocks every other request, so
// the early-access forms can never reach Netlify. Nothing here touches the live site.
//   bin/website shot [path] [name] [--width 1440] [--height 900] [--full]
//   bin/website run <journey.mjs>   (export default async ({ page, shot, note, url, posts }) => ...)
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { checkout, evidenceDir, requireDesktop, step } from "./common.mjs";

const root = path.join(checkout, "apps/website");
const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    width: { type: "string", default: "1440" },
    height: { type: "string", default: "900" },
    full: { type: "boolean", default: false },
  },
});
const [command = "shot", ...rest] = positionals;
const shotsDir = path.join(evidenceDir, "shots");
mkdirSync(shotsDir, { recursive: true });
const posts = [];
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method !== "GET" && req.method !== "HEAD") {
    // A form submit lands here instead of Netlify; record it as evidence.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts.push({
        path: url.pathname,
        body: Object.fromEntries(new URLSearchParams(body)),
      });
      appendFileSync(
        path.join(evidenceDir, "website-posts.jsonl"),
        JSON.stringify({ at: new Date().toISOString(), ...posts.at(-1) }) +
          "\n",
      );
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<p>Local verify server: form received.</p>");
    });
    return;
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory())
    file = path.join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end("not found");
  res
    .writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    })
    .end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = requireDesktop("playwright");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: Number(values.width), height: Number(values.height) },
});
const blocked = [];
await context.route("**/*", (route) => {
  const target = new URL(route.request().url());
  const local =
    target.hostname === "127.0.0.1" ||
    target.protocol === "data:" ||
    target.protocol === "blob:";
  // Font files are reads the live page makes too; nothing else leaves the machine.
  const font =
    route.request().method() === "GET" && FONT_HOSTS.has(target.hostname);
  if (local || font) return route.continue();
  blocked.push(
    `${route.request().method()} ${target.origin}${target.pathname}`,
  );
  return route.abort();
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

async function shot(name, opts = {}) {
  const file = path.join(
    shotsDir,
    `website-${name.replace(/[^A-Za-z0-9._-]+/g, "-")}.png`,
  );
  await page.screenshot({ path: file, fullPage: opts.full ?? values.full });
  step(`website shot ${name}  ${page.url().replace(base, "")}`);
  return file;
}

let code = 0;
try {
  if (command === "shot") {
    const [route = "/", name = "home"] = rest;
    await page.goto(base + route, { waitUntil: "networkidle" });
    console.log(await shot(name));
  } else if (command === "run") {
    const module = await import(pathToFileURL(path.resolve(rest[0])).href);
    const result = await module.default({
      page,
      context,
      shot,
      url: base,
      posts,
      note: (...p) => step(`website note  ${p.join("  ")}`),
    });
    console.log(JSON.stringify(result ?? null, null, 2));
  } else
    throw new Error("website shot [path] [name] | website run <journey.mjs>");
} catch (error) {
  code = 1;
  console.error(error.message);
  await shot("failure").then(
    (f) => console.error(`failure screenshot: ${f}`),
    () => {},
  );
} finally {
  if (blocked.length)
    console.error(
      `blocked outside requests: ${[...new Set(blocked)].join(", ")}`,
    );
  if (errors.length) console.error(`page errors: ${errors.join(" | ")}`);
  await browser.close();
  server.close();
}
process.exit(code);
