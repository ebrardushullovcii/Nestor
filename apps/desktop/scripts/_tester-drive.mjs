// Tester driver: launches one isolated Nestor instance and serves an HTTP
// endpoint that evaluates posted JavaScript with Playwright handles.
// Usage: node drive.mjs <port> <runDir>
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

const port = Number(process.argv[2]);
const runDir = process.argv[3];
const shotsDir = path.join(runDir, "shots");
mkdirSync(shotsDir, { recursive: true });
const focusPatch = process.env.TESTER_FOCUS_PATCH;
const app = await electron.launch({
  args: ["-r", focusPatch, "out/main/index.cjs"],
  cwd: process.cwd(),
  env: { ...process.env },
});
let mainWindowPage = await app.firstWindow();
// The app can replace its main window (for example after a slow start); the
// driver always talks to the current one instead of a closed handle.
async function currentPage() {
  if (mainWindowPage && !mainWindowPage.isClosed()) return mainWindowPage;
  for (let i = 0; i < 60; i++) {
    const open = app.windows().filter((w) => !w.isClosed() && w.url().startsWith("file:"));
    if (open.length > 0) { mainWindowPage = open[0]; return mainWindowPage; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("No Nestor window is open; restart with stop.sh and start.sh.");
}
const nextOpenFile = path.join(runDir, "next-open.txt");
// Native pickers return the file named in next-open.txt; links that would open
// the owner's own browser or apps are recorded instead of opened.
await app.evaluate(({ dialog, shell }, files) => {
  const fs = process.getBuiltinModule("node:fs");
  dialog.showOpenDialog = async () => {
    const chosen = fs.existsSync(files.nextOpenFile)
      ? fs.readFileSync(files.nextOpenFile, "utf8").trim()
      : "";
    return chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] };
  };
  dialog.showSaveDialog = async (_w, options) => ({
    canceled: false,
    filePath: files.exportDir + "/" + ((options && options.defaultPath && options.defaultPath.split("/").pop()) || "export"),
  });
  shell.openExternal = async (url) => {
    fs.appendFileSync(files.openedLog, `openExternal ${url}\n`);
  };
  shell.openPath = async (p) => {
    fs.appendFileSync(files.openedLog, `openPath ${p}\n`);
    return "";
  };
}, { nextOpenFile, exportDir: path.join(runDir, "exports"), openedLog: path.join(runDir, "opened.log") });
mkdirSync(path.join(runDir, "exports"), { recursive: true });
let n = 0;
async function shot(name, options = {}) {
  const page = await currentPage();
  const file = path.join(shotsDir, `${String(++n).padStart(3, "0")}-${name}.png`);
  await page.screenshot({ path: file, scale: "css", ...options });
  return file;
}
async function go(route) {
  const page = await currentPage();
  await page.evaluate((hash) => { location.hash = hash; }, `#${route}`);
  await page.waitForTimeout(1200);
}
const ws = async () => (await currentPage()).evaluate(() => window.nestor.jobFinder.getWorkspace());
async function theme(value) {
  const page = await currentPage();
  await page.evaluate((v) => window.nestor.jobFinder.test.setSystemThemeOverride(v), value);
  await page.waitForTimeout(400);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setNextOpen(filePath) { writeFileSync(nextOpenFile, filePath ?? ""); }
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  appendFileSync(path.join(runDir, "driver-commands.log"), `---\n${body}\n`);
  try {
    const fn = new Function("page", "app", "shot", "go", "ws", "theme", "sleep", "setNextOpen",
      `return (async () => { ${body} })();`);
    const page = await currentPage();
    const out = await fn(page, app, shot, go, ws, theme, sleep, setNextOpen);
    res.end(JSON.stringify(out ?? null, null, 2));
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error?.stack ?? error));
  }
});
server.listen(port, "127.0.0.1");
writeFileSync(path.join(runDir, "driver.pid"), String(process.pid));
console.log(`driver ready on ${port}`);
