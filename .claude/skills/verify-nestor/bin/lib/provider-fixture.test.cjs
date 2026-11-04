const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { execFileSync } = require("node:child_process");
const {
  loadProviderFixture,
  providerArgs,
  installProviderTransport,
} = require("./provider-fixture.cjs");
test("synthetic provider is run/host/certificate pinned and Node forwarding refuses before the mapping arm", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nestor-provider-fixture-"),
  );
  let restore = () => {},
    server;
  try {
    const key = path.join(directory, "key.pem"),
      certPath = path.join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
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
    const cert = fs.readFileSync(certPath),
      spki = crypto
        .createHash("sha256")
        .update(
          new crypto.X509Certificate(cert).publicKey.export({
            type: "spki",
            format: "der",
          }),
        )
        .digest("base64");
    const requests = [];
    server = https.createServer(
      { key: fs.readFileSync(key), cert },
      (req, res) => {
        requests.push({
          method: req.method,
          host: req.headers.host,
          url: req.url,
        });
        req.resume();
        res.end("synthetic");
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const data = {
      label: "scoped-proof",
      host: "accounts.google.com",
      port: server.address().port,
      certPath,
      spki,
      nonce: crypto.randomBytes(24).toString("hex"),
    };
    const file = path.join(directory, "config.json");
    fs.writeFileSync(file, JSON.stringify(data));
    const run = {
      label: data.label,
      userDataDir: "/tmp/nestor-verify-scoped-proof-test",
      testApi: true,
      net: "replica",
    };
    const fixture = loadProviderFixture(file, run);
    for (const change of [
      { label: "other" },
      { testApi: false },
      { net: "web" },
      { userDataDir: "/Users/owner/real" },
    ])
      assert.throws(() => loadProviderFixture(file, { ...run, ...change }));
    for (const change of [
      { host: "google.com" },
      { port: 443 },
      { spki: "wrong" },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...data, ...change }));
      assert.throws(() => loadProviderFixture(file, run));
    }
    assert.equal(
      providerArgs(fixture).some(
        (arg) => arg === "--ignore-certificate-errors",
      ),
      false,
    );
    let armed = false;
    restore = installProviderTransport(fixture, () => armed);
    assert.throws(
      () =>
        https.request("https://accounts.google.com/select", { method: "POST" }),
      /not been proved/u,
    );
    const request = (url, method = "GET") =>
      new Promise((resolve, reject) => {
        const req = https.request(url, { method }, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", reject);
        req.end();
      });
    await request(`https://accounts.google.com/__nestor_probe/${data.nonce}`);
    assert.equal(requests.length, 1);
    armed = true;
    await request("https://accounts.google.com/select", "POST");
    assert.deepEqual(requests.at(-1), {
      method: "POST",
      host: "accounts.google.com",
      url: "/select",
    });
  } finally {
    restore();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
