// Two résumé widgets in the shapes real boards use, read from their public
// client code (October 2026). Both hand the file to cloud storage on another
// origin; here that origin is `localhost` on this same server, while the
// form is on 127.0.0.1. Storage accepts every upload, so whatever stops one
// is on Nestor's side.
//
// Ashby: a same-origin GraphQL mutation hands out a presigned POST; the page
// sends `Content-Type`, the signing fields and the file with fetch, and on
// any failure shows "<file> failed to upload" in a toast.
//
// Greenhouse: a GET hands out the signing fields and a key template; the
// page empties the file input, then sends `utf8`, the signing fields, the
// key, `authenticity_token`, `Content-Type: application/octet-stream` and
// the file with XMLHttpRequest. A failed send only logs to the console.

const policy = Buffer.from(
  JSON.stringify({
    expiration: "2099-01-01T01:00:00Z",
    conditions: [
      { bucket: "synthetic-files" },
      { acl: "private" },
      ["starts-with", "$key", "uploads/"],
      ["starts-with", "$Content-Type", ""],
      ["content-length-range", 0, 104857600],
    ],
  }),
).toString("base64");
const signing = {
  "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
  "X-Amz-Credential":
    "EXAMPLEUPLOADKEY12345/20990101/local-test-1/s3/aws4_request",
  "X-Amz-Date": "20990101T000000Z",
  "X-Amz-Security-Token": "c3ludGhldGljLXVwbG9hZC1zZXNzaW9uLXRva2Vu",
  "X-Amz-Signature": "a".repeat(64),
};
const presignQuery =
  "mutation ApiCreateFileUploadHandle($organizationHostedJobsPageName: String!, $fileUploadContext: FileUploadContext!, $filename: String!, $contentType: String!, $contentLength: Int!) {\n  fileUploadHandle: createFileUploadHandle(organizationHostedJobsPageName: $organizationHostedJobsPageName, fileUploadContext: $fileUploadContext, filename: $filename, contentType: $contentType, contentLength: $contentLength) {\n    handle\n    url\n    fields\n    __typename\n  }\n}";

const sites = {
  "ashby-shape": {
    title: "Product Engineer",
    company: "Hosted Board Replica",
    form: () => `
      <p><label for="name">Name *</label><input id="name" name="name" required></p>
      <p><label for="email">Email *</label><input id="email" name="email" type="email" required></p>
      <div><label for="resume">Resume *</label>
        <button type="button" onclick="document.getElementById('resume').click()">Upload File</button>
        <input id="resume" type="file" accept=".pdf" style="display:none">
        <span id="chip"></span><input type="hidden" name="resumeHandle" id="handle"></div>`,
    script: `
      const input = document.getElementById('resume');
      input.addEventListener('change', async () => {
        const file = input.files[0];
        const failed = () => {
          document.getElementById('toast').textContent = file.name + ' failed to upload';
        };
        try {
          const signed = await fetch('/ashby-shape/api/non-user-graphql', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              operationName: 'ApiCreateFileUploadHandle',
              variables: {
                organizationHostedJobsPageName: 'replica',
                fileUploadContext: 'NonUserFormEngine',
                filename: file.name,
                contentType: file.type,
                contentLength: file.size,
              },
              query: ${JSON.stringify(presignQuery)},
            }),
          });
          const handle = (await signed.json()).data.fileUploadHandle;
          const body = new FormData();
          body.append('Content-Type', file.type);
          for (const [key, value] of Object.entries(handle.fields)) body.append(key, value);
          body.append('file', file);
          if (!(await fetch(handle.url, { method: 'POST', body })).ok) return failed();
          document.getElementById('chip').textContent = file.name;
          document.getElementById('handle').value = handle.handle;
        } catch {
          failed();
        }
      });`,
  },
  "greenhouse-shape": {
    title: "Platform Engineer",
    company: "Job Board Replica",
    form: () => `
      <p><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></p>
      <p><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></p>
      <p><label for="email">Email *</label><input id="email" name="email" type="email" required></p>
      <div><p id="resume-label">Resume/CV *</p>
        <label for="resume">Attach</label>
        <input id="resume" type="file" aria-describedby="resume-label" style="position:absolute;width:1px;height:1px;opacity:0">
        <span id="chip"></span><input type="hidden" name="resume_url" id="resume_url"></div>`,
    script: `
      const input = document.getElementById('resume');
      input.addEventListener('change', async () => {
        const file = input.files[0];
        const signed = await (await fetch('/greenhouse-shape/uncacheable_attributes/presigned_fields?fields[]=resume')).json();
        const body = new FormData();
        body.append('utf8', '✓');
        for (const key in signed.resume.fields) body.append(key, signed.resume.fields[key]);
        const key = signed.resume.key
          .replace('{timestamp}', String(Date.now()))
          .replace('{unique_id}', Math.random().toString(36).slice(2, 16));
        body.append('key', key);
        body.append('authenticity_token', '1234');
        body.append('Content-Type', 'application/octet-stream');
        body.append('file', file);
        input.value = '';
        document.getElementById('chip').textContent = file.name;
        const request = new XMLHttpRequest();
        request.onloadend = () => {
          if (request.status >= 200 && request.status < 300)
            document.getElementById('resume_url').value = signed.url + '/' + key;
          else console.error('Request failed');
        };
        request.open('POST', signed.url);
        request.send(body);
      });`,
  },
};

function storageOrigin(req) {
  const port = /:(\d+)$/u.exec(req.headers.host ?? "")?.[1] ?? "80";
  return `http://localhost:${port}`;
}

export async function handleRealUploadShapes(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  const [, slug, rest = ""] =
    /^\/(ashby-shape|greenhouse-shape)(\/.*)?$/u.exec(url.pathname) ?? [];
  if (!slug) return false;
  const site = sites[slug];
  if (rest === "/storage" || rest === "/storage/") {
    // The storage origin: answers the page's origin the way S3 does.
    const fields = req.method === "POST" ? await readPost(req) : {};
    if (req.method === "POST") logPost(url.pathname, fields);
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
    });
    res.end();
    return true;
  }
  if (rest === "/api/non-user-graphql" && req.method === "POST") {
    const body = await readPost(req);
    if (body.operationName === "ApiCreateFileUploadHandle")
      send(
        200,
        JSON.stringify({
          data: {
            fileUploadHandle: {
              handle: `handle-${Date.now()}`,
              url: `${storageOrigin(req)}/ashby-shape/storage/`,
              fields: {
                acl: "private",
                bucket: "synthetic-files",
                ...signing,
                key: `uploads/7f3a9c21/prefix_${body.variables?.filename ?? "file"}`,
                Policy: Buffer.from(
                  JSON.stringify({
                    expiration: "2099-01-01T01:00:00Z",
                    conditions: [
                      { bucket: "synthetic-files" },
                      {
                        key: `uploads/7f3a9c21/prefix_${body.variables?.filename ?? "file"}`,
                      },
                      ["starts-with", "$Content-Type", ""],
                    ],
                  }),
                ).toString("base64"),
              },
              __typename: "FileUploadHandle",
            },
          },
        }),
        "application/json",
      );
    else send(200, JSON.stringify({ data: {} }), "application/json");
    return true;
  }
  if (rest === "/uncacheable_attributes/presigned_fields") {
    send(
      200,
      JSON.stringify({
        url: `${storageOrigin(req)}/greenhouse-shape/storage`,
        resume: {
          key: "uploads/{timestamp}/{unique_id}/${filename}",
          fields: Object.fromEntries(
            Object.entries({ ...signing, Policy: policy }).map(([k, v]) => [
              k.toLowerCase(),
              v,
            ]),
          ),
        },
      }),
      "application/json",
    );
    return true;
  }
  if (rest === "/apply/1" && req.method === "POST") {
    logPost(url.pathname, await readPost(req));
    send(200, "<h1>Thank you! Your application has been received.</h1>");
    return true;
  }
  if (rest === "/jobs/1") {
    send(
      200,
      `<h1>${site.title}</h1><p>${site.company} · Remote, Worldwide</p><p>Build the tools teams ship with.</p><a href="/${slug}/apply/1">Apply</a>`,
    );
    return true;
  }
  if (rest === "/apply/1") {
    send(
      200,
      `<!doctype html><title>Apply — ${site.company}</title>
      <div id="toast" role="status"></div>
      <h1>Apply: ${site.title}</h1><p>${site.company} · Remote, Worldwide</p>
      <form method="post" action="/${slug}/apply/1" enctype="multipart/form-data">
        ${site.form()}<button>Submit application</button>
      </form><script>${site.script}</script>`,
    );
    return true;
  }
  send(404, "Not found");
  return true;
}
