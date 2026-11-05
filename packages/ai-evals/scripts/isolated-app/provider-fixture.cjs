// Verification only: one exact synthetic provider, private run, pinned certificate.
const fs = require("node:fs");
const crypto = require("node:crypto");
const https = require("node:https");
const tls = require("node:tls");
function loadProviderFixture(file, run) {
  if (!file) return null;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !run.testApi ||
    run.net !== "replica" ||
    !run.userDataDir.startsWith("/tmp/nestor-verify-" + run.label + "-") ||
    value.label !== run.label ||
    value.host !== "accounts.google.com" ||
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    !/^[a-f0-9]{48}$/u.test(value.nonce)
  )
    throw new Error(
      "Synthetic provider fixture is not bound to this isolated run.",
    );
  const cert = fs.readFileSync(value.certPath, "utf8");
  const x509 = new crypto.X509Certificate(cert);
  const spki = crypto
    .createHash("sha256")
    .update(x509.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  if (spki !== value.spki || !x509.checkHost(value.host))
    throw new Error(
      "Synthetic provider certificate does not match its host/pin.",
    );
  return { ...value, cert };
}
function providerArgs(fixture) {
  return fixture
    ? [
        `--host-resolver-rules=MAP ${fixture.host} 127.0.0.1:${fixture.port}`,
        `--ignore-certificate-errors-spki-list=${fixture.spki}`,
        "--no-proxy-server",
      ]
    : [];
}
function installProviderTransport(fixture, isArmed) {
  if (!fixture) return () => {};
  const original = https.request;
  https.request = function (...args) {
    let options, callback;
    if (typeof args[0] === "string" || args[0] instanceof URL) {
      const url = new URL(args[0]);
      options = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        ...(typeof args[1] === "object" ? args[1] : {}),
      };
      callback = typeof args[1] === "function" ? args[1] : args[2];
    } else {
      options = { ...args[0] };
      callback = args[1];
    }
    const host = options.hostname ?? options.host;
    if (host !== fixture.host || (options.port && Number(options.port) !== 443))
      return original.apply(this, args);
    const method = (options.method ?? "GET").toUpperCase();
    const probe =
      method === "GET" && options.path === `/__nestor_probe/${fixture.nonce}`;
    if (!isArmed() && !probe)
      throw new Error(
        "Synthetic provider mapping has not been proved; request refused.",
      );
    return original.call(
      this,
      {
        ...options,
        protocol: "https:",
        hostname: "127.0.0.1",
        port: fixture.port,
        servername: fixture.host,
        headers: { ...options.headers, host: fixture.host },
        ca: fixture.cert,
        rejectUnauthorized: true,
        agent: false,
        checkServerIdentity: (_hostname, cert) => {
          const error = tls.checkServerIdentity(fixture.host, cert);
          if (error) return error;
          const pin = crypto
            .createHash("sha256")
            .update(
              new crypto.X509Certificate(cert.raw).publicKey.export({
                type: "spki",
                format: "der",
              }),
            )
            .digest("base64");
          return pin === fixture.spki
            ? undefined
            : new Error("Synthetic provider certificate pin changed.");
        },
      },
      callback,
    );
  };
  return () => {
    https.request = original;
  };
}
module.exports = {
  loadProviderFixture,
  providerArgs,
  installProviderTransport,
};
