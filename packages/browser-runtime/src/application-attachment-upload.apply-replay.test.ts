import replay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/attachment-upload.json";
import realShapes from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/real-upload-shapes.json";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import ashbyBind from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/ashby-upload-bind.json";
import {
  classifyAttachmentUpload,
  classifyUploadBind,
  uploadHandlesIn,
  type AttachmentUploadWindow,
} from "./application-attachment-upload-policy";

const fields = {
  ...replay.fields,
  Policy: Buffer.from(JSON.stringify(replay.policy)).toString("base64"),
};
const bytes = new TextEncoder().encode("%PDF-1.4 synthetic selected resume");
const grant: AttachmentUploadWindow = {
  sourceOrigin: "https://apply.example.test",
  fileName: "synthetic-resume.pdf",
  mimeType: "application/pdf",
  byteLength: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  expiresAtMs: 2000,
  remainingRequests: 2,
};
async function multipart(
  extra: Record<string, string> = {},
  fileBytes = bytes,
  fileName = grant.fileName,
) {
  const form = new FormData();
  form.set("file", new Blob([fileBytes], { type: grant.mimeType }), fileName);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  const request = new Request("https://storage.example.test/", {
    method: "POST",
    body: form,
  });
  return {
    window: grant,
    nowMs: 1000,
    method: "POST",
    url: request.url,
    contentType: request.headers.get("content-type")!,
    body: new Uint8Array(await request.arrayBuffer()),
  };
}
test("the selected file reaches a separate signed storage target, with no other form answers", async () => {
  expect(
    (
      await classifyAttachmentUpload(
        await multipart({
          ...fields,
        }),
      )
    ).allowed,
  ).toBe(true);
  const request = await multipart({
    "X-Amz-Signature": fields["X-Amz-Signature"],
    email: "candidate@example.test",
  });
  expect((await classifyAttachmentUpload(request)).allowed).toBe(false);
  expect(
    (await classifyAttachmentUpload({ ...request, window: null })).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload({
        ...(await multipart({ "X-Amz-Signature": fields["X-Amz-Signature"] })),
        nowMs: 2001,
      })
    ).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload(
        await multipart(
          { "X-Amz-Signature": fields["X-Amz-Signature"] },
          new Uint8Array(bytes.length),
          grant.fileName,
        ),
      )
    ).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload(
        await multipart(
          { "X-Amz-Signature": fields["X-Amz-Signature"] },
          bytes,
          "other.pdf",
        ),
      )
    ).allowed,
  ).toBe(false);
});

test.each([false, true])(
  "a signed key and policy may repeat only the exact selected filename (encoded=%s)",
  async (encoded) => {
    const fileName = realShapes.fileName;
    const embedded = encoded
      ? [...new TextEncoder().encode(fileName)]
          .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
          .join("")
      : fileName;
    const key = `${realShapes.keyPrefix}${embedded}/${embedded}`;
    const policy = (objectKey: string) =>
      Buffer.from(
        JSON.stringify({
          ...replay.policy,
          conditions: [...replay.policy.conditions, { key: objectKey }],
        }),
      ).toString("base64");
    const input = {
      ...(await multipart(
        { ...fields, key, Policy: policy(key) },
        bytes,
        fileName,
      )),
      window: { ...grant, fileName },
      preparedValues: [
        realShapes.name,
        realShapes.firstName,
        realShapes.lastName,
        "90000",
      ],
    };
    expect(await classifyAttachmentUpload(input)).toMatchObject({
      allowed: true,
      containsFile: true,
    });
    const refusedKeys: ReadonlyArray<readonly [string, string]> = [
      [`${key}/Taylor`, key],
      [key, `${key}/Morgan`],
      [`${key}/90000`, key],
    ];
    for (const [badKey, badPolicyKey] of refusedKeys) {
      const request = {
        ...input,
        ...(await multipart(
          { ...fields, key: badKey, Policy: policy(badPolicyKey) },
          bytes,
          fileName,
        )),
        window: input.window,
      };
      expect(await classifyAttachmentUpload(request)).toMatchObject({
        allowed: false,
      });
    }
  },
);

test("Rails upload markers and a generic binary MIME remain attachment-only", async () => {
  const input = {
    ...(await multipart(
      { ...fields, ...realShapes.rails },
      bytes,
      realShapes.fileName,
    )),
    window: { ...grant, fileName: realShapes.fileName },
    preparedValues: [realShapes.firstName, realShapes.lastName],
  };
  expect(await classifyAttachmentUpload(input)).toMatchObject({
    allowed: true,
  });
  for (const bad of realShapes.refusedRails) {
    const request = {
      ...input,
      ...(await multipart(
        { ...fields, ...realShapes.rails, ...bad },
        bytes,
        realShapes.fileName,
      )),
      window: input.window,
    };
    expect(await classifyAttachmentUpload(request)).toMatchObject({
      allowed: false,
    });
  }
  for (const pathname of realShapes.refusedPaths)
    expect(
      await classifyAttachmentUpload({
        ...input,
        url: `https://storage.example.test${pathname}`,
      }),
    ).toMatchObject({ allowed: false });
  expect(
    await classifyAttachmentUpload({
      ...input,
      ...(await multipart(
        { ...fields, ...realShapes.rails, final: "true" },
        bytes,
        realShapes.fileName,
      )),
      window: input.window,
    }),
  ).toMatchObject({ allowed: false });
});
test("a same-origin file-handle presign contains only upload metadata", async () => {
  const request = {
    window: grant,
    nowMs: 1000,
    method: "POST",
    url: "https://apply.example.test/api/non-user-graphql",
    contentType: "application/json",
    body: bytes,
  };
  const body = (query: string, variables: Record<string, unknown> = {}) =>
    new TextEncoder().encode(
      JSON.stringify({ operationName: "UploadHandle", query, variables }),
    );
  const query = "query UploadHandle { fileUploadHandle { url fields } }";
  expect(
    (await classifyAttachmentUpload({ ...request, body: body(query) })).allowed,
  ).toBe(true);
  for (const query of [
    "mutation UploadHandle { createApplication { id } }",
    "mutation UploadHandle { applyToJob { id } }",
    "mutation UploadHandle { fileUploadHandle { url } createUser { id } }",
  ])
    expect(
      (await classifyAttachmentUpload({ ...request, body: body(query) }))
        .allowed,
    ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload({
        ...request,
        body: body(query, { email: "candidate@example.test" }),
      })
    ).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload({
        ...request,
        url: "https://unrelated.example.test/api/non-user-graphql",
        body: body(query),
      })
    ).allowed,
  ).toBe(false);
});

test("Apply replay: the named second GraphQL operation cannot escape the inspected upload operation", async () => {
  const body = new TextEncoder().encode(JSON.stringify(replay.refusedPresign));
  expect(
    (
      await classifyAttachmentUpload({
        window: grant,
        nowMs: 1000,
        method: "POST",
        url: grant.sourceOrigin + "/api/non-user-graphql",
        contentType: "application/json",
        body,
      })
    ).allowed,
  ).toBe(false);
});

test.each(replay.refusedMetadata)(
  "Apply replay: prepared answers never ride in storage metadata: %j",
  async (metadata) => {
    const extra = Object.fromEntries(
      Object.entries(metadata).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const request = await multipart({ ...fields, ...extra });
    expect(
      (
        await classifyAttachmentUpload({
          ...request,
          preparedValues: replay.preparedAnswers,
        })
      ).allowed,
    ).toBe(false);
  },
);

test.each(replay.refusedPaths)(
  "Apply replay: a file cannot disguise a final operation at %s",
  async (path) => {
    const request = await multipart(fields);
    expect(
      (
        await classifyAttachmentUpload({
          ...request,
          url: grant.sourceOrigin + path,
        })
      ).allowed,
    ).toBe(false);
  },
);
test("a direct object upload must contain exactly the selected file, inside its window", async () => {
  const request = {
    window: grant,
    nowMs: 1000,
    method: "PUT",
    url: "https://storage.example.test/objects/synthetic-resume.pdf",
    contentType: grant.mimeType,
    body: bytes,
  };
  expect((await classifyAttachmentUpload(request)).allowed).toBe(true);
  expect(
    (await classifyAttachmentUpload({ ...request, window: null })).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload({
        ...request,
        window: { ...grant, remainingRequests: 0 },
      })
    ).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload({
        ...request,
        body: new Uint8Array(bytes.length),
      })
    ).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload({
        ...request,
        url: "https://storage.example.test/api/applications",
      })
    ).allowed,
  ).toBe(false);
});

test("Ashby's bind: one, to the presign's endpoint, naming its handle, after storage took the file, with no answer", () => {
  const endpoint = "https://apply.example.test/api/non-user-graphql";
  const handles = uploadHandlesIn(
    JSON.stringify({
      data: {
        fileUploadHandle: {
          handle: ashbyBind.handle,
          url: "https://storage.example.test/",
        },
      },
    }),
    grant,
  );
  expect(handles).toContain(ashbyBind.handle);
  const stored = {
    ...grant,
    presignEndpoint: endpoint,
    handles,
    bindsRemaining: 1,
  };
  const bind = (
    overrides: { path?: string; fileHandle?: string; url?: string } = {},
    window: AttachmentUploadWindow = stored,
  ) =>
    classifyUploadBind({
      window,
      nowMs: 1000,
      method: "POST",
      url: overrides.url ?? `${endpoint}?op=ApiSetFormValueToFile`,
      contentType: "application/json",
      body: JSON.stringify({
        operationName: "ApiSetFormValueToFile",
        variables: {
          organizationHostedJobsPageName: "synthetic",
          formRenderIdentifier: ashbyBind.formRenderIdentifier,
          path: overrides.path ?? ashbyBind.path,
          fileHandle: overrides.fileHandle ?? ashbyBind.handle,
          formDefinitionIdentifier: ashbyBind.formDefinitionIdentifier,
        },
        query: ashbyBind.bindQuery,
      }),
      preparedValues: ["Robin Ashford", "robin@example.test"],
    });
  expect(bind()).toBe(true);
  // Before the storage took the file, or once the bind is spent.
  expect(bind({}, { ...stored, bindsRemaining: 0 })).toBe(false);
  expect(bind({ fileHandle: "c29tZS1vdGhlci1oYW5kbGUtMDAwMQ==" })).toBe(false);
  expect(bind({ path: "Robin Ashford" })).toBe(false);
  expect(
    bind({
      url: `${endpoint}?op=ApiSetFormValueToFile&n=robin%40example.test`,
    }),
  ).toBe(false);
  expect(
    bind({
      url: "https://apply.example.test/api/other?op=ApiSetFormValueToFile",
    }),
  ).toBe(false);
  expect(bind({ url: `${endpoint}?op=ApiSubmitApplicationFormAction` })).toBe(
    false,
  );
});

test("a résumé parser on the form's own site takes the exact file, renamed, with the form's id", async () => {
  const leverGrant = { ...grant, fileName: "Alex Vanguard CV.pdf" };
  const parse = async (
    extra: Record<string, string>,
    fileName = "Alex_Vanguard_CV.pdf",
    fileBytes = bytes,
  ) => {
    const form = new FormData();
    form.set(
      "resume",
      new Blob([fileBytes], { type: grant.mimeType }),
      fileName,
    );
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    const request = new Request("https://apply.example.test/parseResume", {
      method: "POST",
      body: form,
    });
    return classifyAttachmentUpload({
      window: leverGrant,
      nowMs: 1000,
      method: "POST",
      url: request.url,
      contentType: request.headers.get("content-type")!,
      body: new Uint8Array(await request.arrayBuffer()),
      preparedValues: ["Alex Vanguard"],
    });
  };
  const accountId = "0a1b2c3d-4e5f-4789-8bcd-ef0123456789";
  expect((await parse({ accountId })).allowed).toBe(true);
  // Other bytes, another file's name, an answer, or any other field: no.
  expect(
    (await parse({ accountId }, undefined, new Uint8Array(bytes.length)))
      .allowed,
  ).toBe(false);
  expect((await parse({ accountId }, "cover_letter.pdf")).allowed).toBe(false);
  expect((await parse({ accountId: "Alex Vanguard" })).allowed).toBe(false);
  expect((await parse({ accountId, name: "Alex Vanguard" })).allowed).toBe(
    false,
  );
  expect((await parse({ accountId, note: "hello there" })).allowed).toBe(false);
});
