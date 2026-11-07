import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const attempts = new Map();
const accounts = new Map();
const html = (body) =>
  `<!doctype html><title>Verification replica</title><main>${body}</main>`;

/** Synthetic local mailbox and new-account replicas; no credentials in logs. */
export async function handleVerificationReplica(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  const match =
    /^\/verification-replica\/(apply|send|verify|inbox|stats|register|login|logout|account)\/([a-zA-Z0-9-]+)$/u.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, route, id] = match;
  const path = (step) => `/verification-replica/${step}/${id}`;
  let attempt = attempts.get(id);
  if (!attempt)
    attempts.set(
      id,
      (attempt = { sends: 0, verifications: 0, accepted: 0, code: null }),
    );
  const fields = req.method === "POST" ? await readPost(req) : {};
  if (route === "apply") {
    res.setHeader(
      "Set-Cookie",
      `replica_mailbox=${id}; HttpOnly; SameSite=Lax; Path=/verification-replica`,
    );
    send(
      200,
      html(
        `<h1>Apply</h1><form method="post" action="${path("send")}"><label>Name<input name="name" required></label><label><input name="terms" type="checkbox" required>I accept the required arbitration agreement</label><button>Send application</button></form>`,
      ),
    );
  } else if (route === "send" && req.method === "POST") {
    attempt.sends++;
    attempt.code ??= randomBytes(5).toString("hex");
    send(
      200,
      html(
        `<h1>Check your email</h1><p>Enter the emailed verification code to finish this application. It has not been accepted yet.</p><form method="post" action="${path("verify")}"><label>Verification code<input name="code" autocomplete="one-time-code" required></label><button>Verify email</button></form>`,
      ),
    );
  } else if (route === "inbox") {
    if (!(req.headers.cookie ?? "").includes(`replica_mailbox=${id}`)) {
      send(401, html("<h1>Sign in to your mailbox</h1>"));
    } else {
      send(
        200,
        html(
          `<h1>Inbox</h1><button aria-label="Google Account (synthetic@example.test)">Account</button><article><h2>Your application verification</h2><p>Your verification code is <strong>${attempt.code ?? "No message yet"}</strong>.</p></article>`,
        ),
      );
    }
  } else if (route === "verify" && req.method === "POST") {
    attempt.verifications++;
    if (!attempt.code || fields.code !== attempt.code)
      send(400, html("<h1>The code did not match</h1>"));
    else {
      if (!attempt.accepted) {
        attempt.accepted++;
        logPost(path("accepted"), { application: id, accepted: true });
      }
      send(
        200,
        html("<h1>Thank you! Your application has been received.</h1>"),
      );
    }
  } else if (route === "stats") {
    send(
      200,
      JSON.stringify({
        sends: attempt.sends,
        verifications: attempt.verifications,
        accepted: attempt.accepted,
      }),
      "application/json",
    );
  } else if (
    (route === "register" || route === "login") &&
    req.method === "GET"
  ) {
    send(
      200,
      html(
        `<h1>${route === "register" ? "Create Account" : "Sign in"}</h1><form method="post" action="${path(route)}"><label>Email<input type="email" name="email" required></label><label>Password<input type="password" name="password" autocomplete="${route === "register" ? "new-password" : "current-password"}" required></label>${route === "register" ? '<label>Confirm password<input type="password" name="confirm" autocomplete="new-password" required></label>' : ""}<button>${route === "register" ? "Create Account" : "Sign in"}</button></form>`,
      ),
    );
  } else if (route === "register" && req.method === "POST") {
    if (!fields.password || fields.password !== fields.confirm)
      send(400, html("<h1>Passwords must match</h1>"));
    else {
      const salt = randomBytes(16);
      accounts.set(`${id}:${fields.email}`, {
        salt,
        hash: scryptSync(fields.password, salt, 32),
      });
      res.setHeader(
        "Set-Cookie",
        `replica_account=${id}; HttpOnly; SameSite=Lax; Path=/verification-replica`,
      );
      send(200, html("<h1>Your account was created</h1>"));
    }
  } else if (route === "login" && req.method === "POST") {
    const saved = accounts.get(`${id}:${fields.email}`);
    const ok =
      saved &&
      fields.password &&
      timingSafeEqual(saved.hash, scryptSync(fields.password, saved.salt, 32));
    if (ok)
      res.setHeader(
        "Set-Cookie",
        `replica_account=${id}; HttpOnly; SameSite=Lax; Path=/verification-replica`,
      );
    send(
      ok ? 200 : 401,
      html(ok ? "<h1>You are signed in</h1>" : "<h1>Sign-in failed</h1>"),
    );
  } else if (route === "logout") {
    res.setHeader(
      "Set-Cookie",
      "replica_account=; Max-Age=0; Path=/verification-replica",
    );
    send(
      200,
      html(`<h1>Signed out</h1><a href="${path("login")}">Sign in again</a>`),
    );
  } else send(404, html("<h1>Not found</h1>"));
  return true;
}
