// Synthetic Google + employer. Only the isolated-app driver's pinned host
// mapping may expose the TLS server as accounts.google.com. Never real Google.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ACCOUNT = "robin.synthetic@example.test";
const OTHER = "other.synthetic@example.test";
const variants = new Set(["one", "two", "password", "extra", "ambiguous"]);
const document = (title, body) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><style>body{font:18px system-ui;max-width:640px;margin:50px auto}label{display:block;margin:16px 0}button,a{display:inline-block;padding:12px;margin:8px}input{padding:8px}</style><h1>${title}</h1>${body}</html>`;
const form = (action, body) =>
  `<form method="post" action="${action}">${body}</form>`;

export async function startGoogleMock({ directory, label }) {
  if (!/^[a-z0-9._-]+$/iu.test(label))
    throw new Error("A test label is required");
  mkdirSync(directory, { recursive: true });
  const certPath = path.join(directory, "cert.pem");
  const keyPath = path.join(directory, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=accounts.google.com",
      "-addext",
      "subjectAltName=DNS:accounts.google.com",
    ],
    { stdio: "pipe" },
  );
  const cert = readFileSync(certPath);
  const nonce = randomBytes(24).toString("hex");
  const requests = [];
  let employerOrigin;
  const send = (res, title, body) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(document(title, body));
  };
  const redirect = (res, location) => {
    res.writeHead(303, { location });
    res.end();
  };
  const record = (req, pathname) => {
    const item = { method: req.method, path: pathname };
    requests.push(item);
    writeFileSync(
      path.join(directory, "requests.json"),
      JSON.stringify(requests, null, 2),
    );
  };
  const provider = https.createServer(
    { cert, key: readFileSync(keyPath) },
    async (req, res) => {
      const url = new URL(req.url, "https://accounts.google.com");
      if (url.pathname === `/__nestor_probe/${nonce}`) return res.end(nonce);
      record(req, url.pathname);
      const variant = url.searchParams.get("state") ?? "one";
      if (!variants.has(variant)) {
        res.writeHead(400);
        return res.end();
      }
      let body = "";
      for await (const chunk of req) body += chunk;
    const chosen =
      new URLSearchParams(body).get("account") === "account-1"
        ? "account-1"
        : "account-0";
      const suffix = `?state=${variant}`;
      if (url.pathname === "/o/oauth2/v2/auth")
        return redirect(res, `/v3/signin/accountchooser${suffix}`);
      if (url.pathname === "/v3/signin/accountchooser") {
        return send(
          res,
          "Choose an account",
          `<p>to continue to Synthetic Employer</p>${form(`/select${suffix}`, `<button name="account" value="account-0">Robin Synthetic ${ACCOUNT}</button>${["two", "ambiguous"].includes(variant) ? `<button name="account" value="account-1">Other Synthetic ${OTHER}</button>` : ""}`)}`,
        );
      }
      if (url.pathname === "/select" && req.method === "POST") {
        if (variant === "password")
          return redirect(res, `/v3/signin/challenge/pwd${suffix}`);
        return redirect(
          res,
          `/signin/oauth/consent${suffix}&chosen=${encodeURIComponent(chosen)}`,
        );
      }
      if (url.pathname === "/v3/signin/challenge/pwd")
        return send(
          res,
          "Welcome",
          `<p>${ACCOUNT}</p>${form(`/password${suffix}`, '<label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Next</button>')}`,
        );
      if (url.pathname === "/signin/oauth/consent") {
        const account =
        url.searchParams.get("chosen") === "account-1" ? OTHER : ACCOUNT;
        return send(
          res,
          variant === "extra"
            ? "Synthetic Employer wants access to your Google Account"
            : "Sign in to Synthetic Employer",
          `<p>${account}</p><p>${variant === "extra" ? "Read, compose, send and permanently delete all your email from Gmail" : "Google will share your name, email address and profile picture with Synthetic Employer"}</p>${form(`/confirm${suffix}`, "<button>Continue</button>")}`,
        );
      }
      if (
        url.pathname === "/confirm" &&
        req.method === "POST" &&
        variant !== "extra"
      )
        return redirect(res, `${employerOrigin}/application/${variant}`);
      res.writeHead(400);
      res.end("Unexpected synthetic provider action");
    },
  );
  const employer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__metrics") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(requests));
    }
    record(req, url.pathname);
    const variant = url.pathname.split("/").at(-1);
    if (!variants.has(variant)) {
      res.writeHead(404);
      return res.end();
    }
    if (url.pathname.startsWith("/application/"))
      return send(
        res,
        "Application",
        '<p>You are signed in. Complete your application.</p><form method="post" action="/send"><label>Full name<input name="name" autocomplete="name" required></label><button>Submit application</button></form>',
      );
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: "synthetic-client",
      scope:
        variant === "extra"
          ? "openid email profile https://mail.google.com/"
          : "openid email profile",
      response_type: "code",
      redirect_uri: `${employerOrigin}/application/${variant}`,
      state: variant,
    }).toString();
    return send(
      res,
      "Sign in to apply",
      `<p>Synthetic Employer · Frontend Engineer</p><button type="button" onclick='location.href=${JSON.stringify(auth.href)}'>Sign in with Google</button>${form(`/site-login/${variant}`, '<label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button>')}`,
    );
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => employer.listen(0, "127.0.0.1", resolve));
  employerOrigin = `http://127.0.0.1:${employer.address().port}`;
  const config = {
    label,
    host: "accounts.google.com",
    port: provider.address().port,
    certPath,
    spki: createHash("sha256")
      .update(
        new X509Certificate(cert).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("base64"),
    nonce,
  };
  const configPath = path.join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return {
    configPath,
    employerOrigin,
    requests,
    stop: () =>
      Promise.all(
        [provider, employer].map(
          (server) => new Promise((resolve) => server.close(resolve)),
        ),
      ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const mock = await startGoogleMock({
    label: process.argv[2],
    directory: path.resolve(process.argv[3]),
  });
  console.log(
    JSON.stringify({
      configPath: mock.configPath,
      employerOrigin: mock.employerOrigin,
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await mock.stop();
      process.exit();
    });
}
