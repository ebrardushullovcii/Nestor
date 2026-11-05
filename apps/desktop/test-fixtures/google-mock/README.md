# Synthetic Google sign-in

This server supplies an employer login wall with Google beside email/password,
plus Google account pages. All accounts are invented. It never contacts Google.
Certificates, keys, configuration and request counts go outside the checkout.

Start it with a label matching the isolated app instance:

```sh
node apps/desktop/test-fixtures/google-mock/serve.mjs w6-sign-in /tmp/nestor-google-mock
```

The output names `configPath` and `employerOrigin`. Set
`NESTOR_VERIFY_PROVIDER_FIXTURE` to that configuration path when starting the
isolated app driver (`packages/ai-evals/scripts/isolated-app/cli.mjs`). Use replica
network mode and the Playwright launch backend. The driver maps only
`accounts.google.com` to the loopback TLS server and pins this certificate.

Before running an application, open
`https://accounts.google.com/__nestor_probe/<nonce>` in the instance's in-app
browser. Read the nonce from the generated configuration. After it loads, call
`__nestorVerify.armProviderFixture(webContentsId, nonce)` in Electron main through
the driver's `app.evaluate`. The driver checks the nonce, exact URL and isolated
browser partition before allowing synthetic provider requests.

Employer routes under the printed origin:

| Route              | Google step                                                    |
| ------------------ | -------------------------------------------------------------- |
| `/login/one`       | One signed-in account, then basic confirmation                 |
| `/login/two`       | Two accounts; the first matches `robin.synthetic@example.test` |
| `/login/ambiguous` | Two accounts, for testing an unknown Profile email             |
| `/login/password`  | One account, then a password request                           |
| `/login/extra`     | One account, then Gmail access beyond basic sign-in            |

Successful basic confirmation returns to `/application/<variant>`. The form has
a required name and a final Submit application button. The server never accepts
an application send. Keep Apply in fill-only mode.

`/__metrics` and the generated `requests.json` contain methods and paths only.
They show whether an account was selected or a confirmation pressed without
recording authorization query values or form contents. Stop the server's own
process after the test. This fixture proves local behavior, not acceptance by
real Google.

For saved-password checks, use the existing Workday replica. Register an invented
account through `/workday/account/register/1`, import that exact origin and the
same invented credentials through the isolated instance's password CSV picker,
and apply at `/workday/apply/1?stage=signin`. A successful sign-in reaches the
application without a sign-in item in Needs you.
