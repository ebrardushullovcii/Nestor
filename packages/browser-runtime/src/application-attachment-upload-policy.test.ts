import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  classifyAttachmentUpload,
  type AttachmentUploadWindow,
} from "./application-attachment-upload-policy";

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
          acl: "private",
          bucket: "synthetic-files",
          Policy: "synthetic-policy",
          "X-Amz-Signature": "synthetic-signature",
        }),
      )
    ).allowed,
  ).toBe(true);
  const request = await multipart({
    "X-Amz-Signature": "synthetic",
    email: "candidate@example.test",
  });
  expect((await classifyAttachmentUpload(request)).allowed).toBe(false);
  expect(
    (await classifyAttachmentUpload({ ...request, window: null })).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload({
        ...(await multipart({ "X-Amz-Signature": "synthetic" })),
        nowMs: 2001,
      })
    ).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload(
        await multipart(
          { "X-Amz-Signature": "synthetic" },
          new Uint8Array(bytes.length),
          grant.fileName,
        ),
      )
    ).allowed,
  ).toBe(false);
  expect(
    (
      await classifyAttachmentUpload(
        await multipart({ "X-Amz-Signature": "synthetic" }, bytes, "other.pdf"),
      )
    ).allowed,
  ).toBe(false);
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
