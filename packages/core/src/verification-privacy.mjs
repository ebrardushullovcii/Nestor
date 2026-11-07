import { AsyncLocalStorage } from "node:async_hooks";

// Transient browser/model context only. Nothing here is persisted or changes a
// model decision. Once a mailbox is read, opaque model payloads cannot be
// recorded: they may quote a code before the model has identified its field.
const contexts = new AsyncLocalStorage();
export function withVerificationPrivacy(work) {
  return contexts.getStore()
    ? work()
    : contexts.run({ private: false, secrets: new Set() }, work);
}
export function markVerificationPrivate() {
  const state = contexts.getStore();
  if (state) state.private = true;
}
export function verificationIsPrivate() {
  return contexts.getStore()?.private === true;
}
export function rememberVerificationSecret(value) {
  markVerificationPrivate();
  if (value) contexts.getStore()?.secrets.add(value);
}
export function redactVerificationText(text) {
  for (const secret of contexts.getStore()?.secrets ?? []) {
    // Single-box digits are omitted with the opaque tool/model payload;
    // replacing a digit in timestamps or IDs would destroy the ledger facts.
    if (secret.length > 1) text = text.split(secret).join("[code omitted]");
  }
  return text;
}
export function redactVerificationData(value) {
  if (typeof value === "string") return redactVerificationText(value);
  if (Array.isArray(value)) return value.map(redactVerificationData);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactVerificationData(item),
      ]),
    );
  return value;
}
