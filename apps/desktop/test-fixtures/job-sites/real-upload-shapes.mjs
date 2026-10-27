// Two résumé widgets in the shapes real boards use, read from their public
// client code and the requests their pages make (October 2026). Both hand
// the file to S3-style storage on another origin; here that origin is
// `localhost` on this same server, while the form is on 127.0.0.1. Storage
// accepts every upload, so whatever stops one is on Nestor's side.
//
// Ashby keeps the form on its server. Every GraphQL call goes to
// `/api/non-user-graphql?op=<operation>`. Each answer is saved as it is
// entered with ApiSetFormValue. A file asks ApiCreateFileUploadHandle for a
// handle, posts `Content-Type`, the signing fields and the file to the
// handle's storage URL with fetch, and then binds the stored file to the
// field with ApiSetFormValueToFile carrying that handle. Submit sends only
// the form's identifiers: the server submits what it saved, and refuses when
// a required answer was never saved. A failed upload or bind shows a toast
// and clears the file.
//
// Greenhouse: a GET to the presign host hands out the signing fields and a
// key template: `x-amz-server-side-encryption`, `success_action_status: 201`
// and a policy that also names the form's `utf8` and `authenticity_token`.
// The page empties the file input, then sends `utf8`, the signing fields,
// the key, `authenticity_token`, `Content-Type: application/octet-stream`
// and the file with XMLHttpRequest. Storage answers 201 with an XML receipt.
// A failed send only logs to the console.

const s3Signing = {
  "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
  "X-Amz-Credential":
    "EXAMPLEUPLOADKEY12345/20990101/local-test-1/s3/aws4_request",
  "X-Amz-Date": "20990101T000000Z",
};
const securityToken = "c3ludGhldGljLXVwbG9hZC1zZXNzaW9uLXRva2Vu";
const ashbyPolicy = Buffer.from(
  JSON.stringify({
    expiration: "2099-01-01T01:00:00Z",
    conditions: [
      { acl: "private" },
      { bucket: "synthetic-ashby-files" },
      ["starts-with", "$key", "uploads/"],
      ["starts-with", "$Content-Type", ""],
      ["content-length-range", 0, 104857600],
      { "x-amz-algorithm": s3Signing["X-Amz-Algorithm"] },
      { "x-amz-credential": s3Signing["X-Amz-Credential"] },
      { "x-amz-date": s3Signing["X-Amz-Date"] },
      { "x-amz-security-token": securityToken },
    ],
  }),
).toString("base64");
const greenhousePolicy = Buffer.from(
  JSON.stringify({
    expiration: "2099-01-01T01:00:00Z",
    conditions: [
      { bucket: "synthetic-greenhouse-files" },
      ["starts-with", "$utf8", ""],
      ["starts-with", "$authenticity_token", ""],
      ["starts-with", "$key", "uploads/"],
      { "x-amz-server-side-encryption": "AES256" },
      { success_action_status: "201" },
      ["content-length-range", 1, 104857600],
      ["starts-with", "$Content-Type", ""],
      { "x-amz-credential": s3Signing["X-Amz-Credential"] },
      { "x-amz-algorithm": s3Signing["X-Amz-Algorithm"] },
      { "x-amz-date": s3Signing["X-Amz-Date"] },
    ],
  }),
).toString("base64");

// The operations as Ashby's client sends them (its public bundle).
const ashbyQueries = {
  ApiCreateFileUploadHandle:
    "mutation ApiCreateFileUploadHandle($organizationHostedJobsPageName: String!, $fileUploadContext: FileUploadContext!, $filename: String!, $contentType: String!, $contentLength: Int!) {\n  fileUploadHandle: createFileUploadHandle(organizationHostedJobsPageName: $organizationHostedJobsPageName, fileUploadContext: $fileUploadContext, filename: $filename, contentType: $contentType, contentLength: $contentLength) {\n    handle\n    url\n    fields\n    __typename\n  }\n}",
  ApiSetFormValueToFile:
    "mutation ApiSetFormValueToFile($organizationHostedJobsPageName: String!, $formRenderIdentifier: String!, $path: String!, $fileHandle: String, $formDefinitionIdentifier: String) {\n  setFormValueToFile(organizationHostedJobsPageName: $organizationHostedJobsPageName, formRenderIdentifier: $formRenderIdentifier, path: $path, fileHandle: $fileHandle, formDefinitionIdentifier: $formDefinitionIdentifier) {\n    id\n    __typename\n  }\n}",
  ApiSetFormValue:
    "mutation ApiSetFormValue($organizationHostedJobsPageName: String!, $formRenderIdentifier: String!, $path: String!, $value: JSON, $formDefinitionIdentifier: String) {\n  setFormValue(organizationHostedJobsPageName: $organizationHostedJobsPageName, formRenderIdentifier: $formRenderIdentifier, path: $path, value: $value, formDefinitionIdentifier: $formDefinitionIdentifier) {\n    id\n    __typename\n  }\n}",
  ApiSubmitSingleApplicationFormAction:
    "mutation ApiSubmitSingleApplicationFormAction($organizationHostedJobsPageName: String!, $jobPostingId: String!, $formRenderIdentifier: String!, $formDefinitionIdentifier: String, $actionIdentifier: String!) {\n  submitApplicationFormAction: submitSingleApplicationFormAction(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId, formRenderIdentifier: $formRenderIdentifier, formDefinitionIdentifier: $formDefinitionIdentifier, actionIdentifier: $actionIdentifier) {\n    ok\n    missing\n    __typename\n  }\n}",
};

/**
 * Ashby's Yes/No input, as its page renders it: two buttons with no type,
 * `aria-pressed` and `data-option`, and a hidden checkbox, inside the
 * question's field. Its label points at no element.
 */
const ashbyYesNo = (path, question) => `
      <div class="field-entry"><label for="${path}-field">${question}</label>
        <div data-yesno="${path}">
          <button aria-pressed="false" data-option="yes">Yes</button>
          <button aria-pressed="false" data-option="no">No</button>
          <input type="checkbox" tabindex="-1" name="${path}" style="position:absolute;opacity:0;pointer-events:none">
        </div></div>`;

/** Ashby's form state, kept by the server per rendered form. */
const ashbyForms = new Map();
const ashbyFields = [
  { path: "_systemfield_name", label: "Name", required: true },
  { path: "_systemfield_email", label: "Email", required: true },
  { path: "_systemfield_resume", label: "Resume", required: true },
  { path: "adult", label: "Are you over the age of 18?", required: true },
  {
    path: "timezone",
    label: "Are you based in a EU or equivalent timezone?",
    required: true,
  },
];

const sites = {
  "ashby-shape": {
    title: "Product Engineer",
    company: "Hosted Board Replica",
    form: () => `
      <p><label for="_systemfield_name">Name *</label><input id="_systemfield_name" required></p>
      <p><label for="_systemfield_email">Email *</label><input id="_systemfield_email" type="email" required></p>
      <div><label for="_systemfield_resume">Resume *</label>
        <button type="button" onclick="document.getElementById('_systemfield_resume').click()">Upload File</button>
        <input id="_systemfield_resume" type="file" accept=".pdf" style="display:none">
        <span id="chip"></span></div>
      ${ashbyYesNo("adult", "Are you over the age of 18?")}
      ${ashbyYesNo("timezone", "Are you based in a EU or equivalent timezone?")}`,
    script: `
      const render = 'render-' + Math.random().toString(36).slice(2, 10);
      document.getElementById('application').dataset.render = render;
      const toast = (text) => { document.getElementById('toast').textContent = text; };
      const queries = ${JSON.stringify(ashbyQueries)};
      const graphql = async (operationName, variables) => {
        const response = await fetch('/ashby-shape/api/non-user-graphql?op=' + encodeURIComponent(operationName), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationName, variables: { organizationHostedJobsPageName: 'replica', ...variables }, query: queries[operationName] }),
        });
        const body = await response.json();
        if (!response.ok || body.errors) throw new Error(body.errors?.[0]?.message ?? 'Request failed');
        return body.data;
      };
      // Ashby's Yes/No: pressing the pressed option again clears the answer;
      // each change is saved like any other answer.
      for (const box of document.querySelectorAll('[data-yesno]')) {
        const [yes, no] = box.querySelectorAll('button');
        const hidden = box.querySelector('input');
        let value;
        const show = () => {
          yes.setAttribute('aria-pressed', String(value === true));
          no.setAttribute('aria-pressed', String(value === false));
          hidden.checked = value === true;
          graphql('ApiSetFormValue', { formRenderIdentifier: render, path: box.dataset.yesno, value: value ?? null }).catch(() => toast('Your answer could not be saved.'));
        };
        yes.addEventListener('click', () => { value = value !== true || undefined; show(); });
        no.addEventListener('click', () => { value = value === false ? undefined : false; show(); });
      }
      // Each answer is saved as it is entered, as Ashby does.
      for (const id of ['_systemfield_name', '_systemfield_email']) {
        const field = document.getElementById(id);
        let timer;
        const save = () => graphql('ApiSetFormValue', { formRenderIdentifier: render, path: id, value: field.value }).catch(() => toast('Your answer could not be saved.'));
        field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 500); });
        field.addEventListener('blur', () => { clearTimeout(timer); save(); });
      }
      const input = document.getElementById('_systemfield_resume');
      input.addEventListener('change', async () => {
        const file = input.files[0];
        const chip = document.getElementById('chip');
        chip.textContent = file.name;
        try {
          const handle = (await graphql('ApiCreateFileUploadHandle', { fileUploadContext: 'NonUserFormEngine', filename: file.name, contentType: file.type, contentLength: file.size })).fileUploadHandle;
          const body = new FormData();
          body.append('Content-Type', file.type);
          for (const [key, value] of Object.entries(handle.fields)) body.append(key, value);
          body.append('file', file);
          if (!(await fetch(handle.url, { method: 'POST', body })).ok) throw new Error('storage');
          await graphql('ApiSetFormValueToFile', { formRenderIdentifier: render, path: '_systemfield_resume', fileHandle: handle.handle });
        } catch {
          chip.textContent = '';
          toast(file.name + ' failed to upload');
        }
      });
      document.getElementById('send').addEventListener('click', async () => {
        try {
          const result = (await graphql('ApiSubmitSingleApplicationFormAction', { formRenderIdentifier: render, jobPostingId: 'replica-1', actionIdentifier: 'submit' })).submitApplicationFormAction;
          toast(result.ok ? 'Thank you! Your application has been received.' : 'Please complete: ' + result.missing.join(', '));
        } catch {
          toast('Submission failed.');
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
        // The presign comes from another host, as on Greenhouse's boards.
        const presignHost = location.origin.replace('127.0.0.1', 'localhost');
        const signed = await (await fetch(presignHost + '/greenhouse-shape/uncacheable_attributes/presigned_fields?fields[]=resume')).json();
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

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};

function json(res, status, value) {
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

async function ashbyGraphql(req, res, url, { readPost, logPost }) {
  const body = await readPost(req);
  const op = url.searchParams.get("op") ?? body.operationName;
  const variables = body.variables ?? {};
  const state = ashbyForms.get(variables.formRenderIdentifier) ?? {};
  ashbyForms.set(variables.formRenderIdentifier, state);
  if (op === "ApiCreateFileUploadHandle") {
    const key = `uploads/7f3a9c21/${Date.now()}-${variables.filename ?? "file"}`;
    return json(res, 200, {
      data: {
        fileUploadHandle: {
          handle: Buffer.from(`handle:${key}`).toString("base64"),
          url: `${storageOrigin(req)}/ashby-shape/storage/`,
          fields: {
            acl: "private",
            bucket: "synthetic-ashby-files",
            ...s3Signing,
            "X-Amz-Security-Token": securityToken,
            key,
            Policy: ashbyPolicy,
            "X-Amz-Signature": "a".repeat(64),
          },
          __typename: "FileUploadHandle",
        },
      },
    });
  }
  if (op === "ApiSetFormValue") {
    state[variables.path] = variables.value;
    return json(res, 200, { data: { setFormValue: { id: "saved" } } });
  }
  if (op === "ApiSetFormValueToFile") {
    const key = Buffer.from(variables.fileHandle ?? "", "base64")
      .toString()
      .replace(/^handle:/u, "");
    if (!key.startsWith("uploads/"))
      return json(res, 200, { errors: [{ message: "Unknown file handle" }] });
    state[variables.path] = { file: key.split("/").at(-1) };
    return json(res, 200, { data: { setFormValueToFile: { id: "bound" } } });
  }
  if (op === "ApiSubmitSingleApplicationFormAction") {
    // The submit carries no answers: the server submits what it saved.
    const missing = ashbyFields
      .filter(
        (field) =>
          field.required &&
          (state[field.path] === undefined ||
            state[field.path] === null ||
            state[field.path] === ""),
      )
      .map((field) => field.label);
    if (!missing.length) logPost("/ashby-shape/apply/1", state);
    return json(res, 200, {
      data: {
        submitApplicationFormAction: { ok: missing.length === 0, missing },
      },
    });
  }
  return json(res, 200, { data: {} });
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
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  if (rest === "/storage" || rest === "/storage/") {
    // The storage origin answers the way S3 does for a POST policy upload:
    // 204, or 201 with an XML receipt when the policy asks for it.
    const fields = req.method === "POST" ? await readPost(req) : {};
    if (req.method === "POST") logPost(url.pathname, fields);
    if (fields.success_action_status === "201") {
      res.writeHead(201, { ...cors, "Content-Type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${storageOrigin(req)}${url.pathname}/${fields.key ?? ""}</Location><Bucket>synthetic-greenhouse-files</Bucket><Key>${fields.key ?? ""}</Key><ETag>"synthetic"</ETag></PostResponse>`,
      );
    } else {
      res.writeHead(204, cors);
      res.end();
    }
    return true;
  }
  if (rest === "/api/non-user-graphql" && req.method === "POST") {
    await ashbyGraphql(req, res, url, { readPost, logPost });
    return true;
  }
  if (rest === "/uncacheable_attributes/presigned_fields") {
    json(res, 200, {
      url: `${storageOrigin(req)}/greenhouse-shape/storage`,
      resume: {
        key: "uploads/{timestamp}-{unique_id}/${filename}",
        fields: {
          "x-amz-server-side-encryption": "AES256",
          success_action_status: "201",
          policy: greenhousePolicy,
          "x-amz-credential": s3Signing["X-Amz-Credential"],
          "x-amz-algorithm": s3Signing["X-Amz-Algorithm"],
          "x-amz-date": s3Signing["X-Amz-Date"],
          "x-amz-signature": "a".repeat(64),
        },
      },
    });
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
    const body =
      slug === "ashby-shape"
        ? // Ashby's page has no <form>; Submit Application is a plain button.
          `<div id="application">${site.form()}<button type="button" id="send">Submit Application</button></div>`
        : `<form method="post" action="/${slug}/apply/1" enctype="multipart/form-data">
        ${site.form()}<button>Submit application</button>
      </form>`;
    send(
      200,
      `<!doctype html><title>Apply — ${site.company}</title>
      <div id="toast" role="status"></div>
      <h1>Apply: ${site.title}</h1><p>${site.company} · Remote, Worldwide</p>
      ${body}<script>${site.script}</script>`,
    );
    return true;
  }
  send(404, "Not found");
  return true;
}
