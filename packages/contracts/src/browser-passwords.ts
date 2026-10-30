import { z } from "zod";

const Id = z.string().min(1).max(100);
export const BrowserPasswordMetadataSchema = z.object({
  id: Id,
  origin: z.string().max(4096),
  username: z.string().max(1000),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BrowserPasswordMetadata = z.infer<
  typeof BrowserPasswordMetadataSchema
>;
export const BrowserPasswordPromptSchema = z.object({
  id: Id,
  tabId: Id,
  origin: z.string().max(4096),
  username: z.string().max(1000),
  update: z.boolean(),
});
export type BrowserPasswordPrompt = z.infer<typeof BrowserPasswordPromptSchema>;
export const BrowserPasswordsListInputSchema = z
  .object({ tabId: Id.optional() })
  .strict();
export const BrowserPasswordsListSchema = z.object({
  available: z.boolean(),
  message: z.string().max(500).nullable(),
  credentials: z.array(BrowserPasswordMetadataSchema),
});
export type BrowserPasswordsList = z.infer<typeof BrowserPasswordsListSchema>;
export const BrowserPasswordPromptInputSchema = z
  .object({ promptId: Id })
  .strict();
export const BrowserPasswordDeleteInputSchema = z
  .object({ credentialId: Id })
  .strict();
export const BrowserPasswordAutofillInputSchema = z
  .object({ tabId: Id, credentialId: Id })
  .strict();
export const BrowserPasswordImportResultSchema = z.object({
  status: z.enum(["imported", "cancelled", "unsupported", "failed"]),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  message: z.string().max(500),
});
export type BrowserPasswordImportResult = z.infer<
  typeof BrowserPasswordImportResultSchema
>;

/** Private isolated-page -> main payload, never part of the app's bridge/state. */
export const BrowserPasswordCaptureSchema = z
  .object({
    origin: z.string().max(4096),
    action: z.string().max(4096),
    username: z.string().max(1000),
    password: z.string().min(1).max(10000),
  })
  .strict();
export const BrowserPasswordFilledSchema = z
  .object({ requestId: Id, ok: z.boolean() })
  .strict();
export type BrowserPasswordCapture = z.infer<
  typeof BrowserPasswordCaptureSchema
>;
export interface BrowserPasswordFill {
  requestId: string;
  origin: string;
  username: string;
  password: string;
  agent: boolean;
  /** Main-owned profile email, only for one username-less saved sign-in. */
  fallbackUsername?: string;
}
export const BrowserPasswordFormsSchema = z
  .array(z.object({ action: z.string().max(4096), login: z.boolean() }))
  .max(100);

/** Password values never cross the app preload bridge. */
export interface BrowserPasswordsBridge {
  list(
    input: z.infer<typeof BrowserPasswordsListInputSchema>,
  ): Promise<BrowserPasswordsList>;
  save(input: z.infer<typeof BrowserPasswordPromptInputSchema>): Promise<void>;
  dismiss(
    input: z.infer<typeof BrowserPasswordPromptInputSchema>,
  ): Promise<void>;
  autofill(
    input: z.infer<typeof BrowserPasswordAutofillInputSchema>,
  ): Promise<void>;
  delete(
    input: z.infer<typeof BrowserPasswordDeleteInputSchema>,
  ): Promise<void>;
  importCsv(): Promise<BrowserPasswordImportResult>;
  importFromBrowser(input: {
    sourceId: string;
  }): Promise<BrowserPasswordImportResult>;
}
