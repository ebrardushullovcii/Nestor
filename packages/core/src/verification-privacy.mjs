import { AsyncLocalStorage } from "node:async_hooks";

// Transient browser/model context only. Nothing here is persisted or changes a
// model decision. Once a mailbox is read, a model payload may quote an emailed
// code before the model types it, so evidence written from then on is held
// until the run ends and then written with every code it used masked.
const contexts = new AsyncLocalStorage();
export function withVerificationPrivacy(work) {
  if (contexts.getStore()) return work();
  const state = {
    private: false,
    secrets: new Set(),
    boxes: "",
    held: [],
  };
  return contexts.run(state, async () => {
    try {
      return await work();
    } finally {
      releaseVerificationTrace(state);
    }
  });
}
function releaseVerificationTrace(state) {
  closeBoxes(state);
  state.private = false;
  const codeSeen = state.secrets.size > 0;
  for (const write of state.held.splice(0)) {
    try {
      write(codeSeen);
    } catch {
      /* Evidence never changes execution. */
    }
  }
}
// A code typed one character per box is one secret: the joined characters.
function closeBoxes(state) {
  if (state.boxes.length > 1) state.secrets.add(state.boxes);
  state.boxes = "";
}
/** A mailbox or other auxiliary tab is open: hold evidence until the run ends. */
export function markVerificationPrivate() {
  const state = contexts.getStore();
  if (!state) return;
  state.private = true;
  // Each mailbox visit starts a new code.
  closeBoxes(state);
}
export function verificationIsPrivate() {
  return contexts.getStore()?.private === true;
}
/**
 * Queues an evidence write until the run ends. Returns false when nothing is
 * held, and the caller writes now. The write learns whether any code was used.
 */
export function holdVerificationTrace(write) {
  const state = contexts.getStore();
  if (!state?.private) return false;
  state.held.push(write);
  return true;
}
export function rememberVerificationSecret(value) {
  const state = contexts.getStore();
  if (!state || !value) return;
  state.private = true;
  state.secrets.add(value);
  if (value.length === 1) state.boxes += value;
  else closeBoxes(state);
}
export function redactVerificationText(text) {
  const state = contexts.getStore();
  if (!state) return text;
  // Single-box digits are masked as the joined code; replacing a lone digit in
  // timestamps or IDs would destroy the ledger facts.
  const secrets = [...state.secrets, state.boxes]
    .filter((secret) => secret.length > 1)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets)
    text = text.split(secret).join("[code omitted]");
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
