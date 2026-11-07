import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const refusalText = JSON.stringify({
  error: "validation_failed",
  errors: { phone: ["Include the international calling code"] },
});

/** Synthetic whole-form refusal: the attachment itself is not rejected. */
export async function startApplyFactsReplica(responseDelay = 0) {
  const state = { posts: 0, accepted: 0 };
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        state.posts++;
        const body = Buffer.concat(chunks).toString();
        const valid =
          body.includes("+12025550123") &&
          body.includes("Alex Synthetic") &&
          body.includes("Synthetic resume bytes");
        const reply = () => {
          if (!valid) {
            response.writeHead(422, { "content-type": "application/json" });
            response.end(refusalText);
          } else {
            state.accepted++;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ message: "Application received" }));
          }
        };
        if (responseDelay) setTimeout(reply, responseDelay);
        else reply();
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><h1>Apply</h1>
      <form action="/candidates" method="post" enctype="multipart/form-data">
        <label>Name <input name="name"></label>
        <label>Phone <input name="phone"></label>
        <label>Resume <input name="resume" type="file"></label>
        <button>Send application</button>
      </form><p id="result"></p>
      <script>document.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const response = await fetch('/candidates', {
          method: 'POST', body: new FormData(event.target)
        });
        const message = await response.json();
        document.querySelector('#result').textContent = response.ok
          ? message.message : 'Please correct the phone field';
      };</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
