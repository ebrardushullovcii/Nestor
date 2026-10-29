import { z } from "zod";
import {
  BrowserPasswordPromptSchema,
  type BrowserPasswordsBridge,
} from "./browser-passwords";

const BrowserTabIdSchema = z.string().min(1).max(100);
// Measured on a 16 GiB PC: replica forms used ~29 MiB private memory;
// real boards varied from ~70 to ~200 MiB. Leave room for working tabs,
// retained forms and popups; memory pressure reclaims idle prepared forms.
export const EMBEDDED_BROWSER_MAX_WORKING_TABS = 16;
export const EMBEDDED_BROWSER_MAX_TOTAL_TABS = 64;
export const DesktopBrowserPresentationSchema = z.enum([
  "minimized",
  "peek",
  "expanded",
]);

export const DesktopBrowserTabSchema = z.object({
  id: BrowserTabIdSchema,
  title: z.string().max(300),
  url: z.string().max(4096),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});

export const DesktopBrowserAttentionSchema = z.object({
  kind: z.enum(["sign_in", "challenge", "permission", "error", "user_action"]),
  title: z.string().max(160),
  detail: z.string().max(500),
});

/** Only display state crosses preload. Cookies, page content and CDP stay in main. */
export const DesktopBrowserStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  passwordPrompt: BrowserPasswordPromptSchema.nullable().optional(),
  unboundSendNotice: z
    .object({ id: z.string().min(1).max(100), tabId: BrowserTabIdSchema })
    .nullable()
    .optional(),
  /** The person's own Send on a prepared form went through, and its tab closed. */
  sentNotice: z
    .object({
      id: z.string().min(1).max(100),
      applicationId: z.number().int().positive(),
      jobId: z.number().int().positive(),
      company: z.string().max(200),
      title: z.string().max(300),
    })
    .nullable()
    .optional(),
  phase: z.enum([
    "closed",
    "ready",
    "working",
    "pausing",
    "paused",
    "needs_you",
    "closing",
  ]),
  presentation: DesktopBrowserPresentationSchema,
  tabs: z.array(DesktopBrowserTabSchema).max(EMBEDDED_BROWSER_MAX_TOTAL_TABS),
  activeTabId: BrowserTabIdSchema.nullable(),
  activity: z.string().max(200).nullable(),
  attention: DesktopBrowserAttentionSchema.nullable(),
  automationPaused: z.boolean(),
});
export type DesktopBrowserState = z.infer<typeof DesktopBrowserStateSchema>;
export type DesktopBrowserTab = z.infer<typeof DesktopBrowserTabSchema>;
export type DesktopBrowserAttention = z.infer<
  typeof DesktopBrowserAttentionSchema
>;

const NavigationUrlSchema = z.string().trim().min(1).max(4096);
export const DesktopBrowserCommandSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("open"), url: NavigationUrlSchema.optional() })
    .strict(),
  z.object({ type: z.literal("minimize") }).strict(),
  z.object({ type: z.literal("close") }).strict(),
  z.object({ type: z.literal("expand"), expanded: z.boolean() }).strict(),
  z.object({ type: z.literal("navigate"), url: NavigationUrlSchema }).strict(),
  z.object({ type: z.literal("back") }).strict(),
  z.object({ type: z.literal("forward") }).strict(),
  z.object({ type: z.literal("reload") }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("take_control") }).strict(),
  z.object({ type: z.literal("resume") }).strict(),
  z.object({ type: z.literal("new_tab") }).strict(),
  z.object({ type: z.literal("close_finished_tabs") }).strict(),
  z
    .object({ type: z.literal("select_tab"), tabId: BrowserTabIdSchema })
    .strict(),
  z
    .object({ type: z.literal("close_tab"), tabId: BrowserTabIdSchema })
    .strict(),
]);
export type DesktopBrowserCommand = z.infer<typeof DesktopBrowserCommandSchema>;

export const DesktopBrowserViewportSchema = z
  .object({
    x: z.number().finite().min(0).max(16000),
    y: z.number().finite().min(0).max(16000),
    width: z.number().finite().min(0).max(16000),
    height: z.number().finite().min(0).max(16000),
    visible: z.boolean(),
  })
  .strict();
export type DesktopBrowserViewport = z.infer<
  typeof DesktopBrowserViewportSchema
>;

export const DesktopBrowserImportResultSchema = z.object({
  status: z.enum(["imported", "cancelled", "unsupported", "failed"]),
  cookieCount: z.number().int().nonnegative(),
  siteCount: z.number().int().nonnegative(),
  message: z.string().max(500),
});
export type DesktopBrowserImportResult = z.infer<
  typeof DesktopBrowserImportResultSchema
>;

export const DesktopBrowserImportBrowserSchema = z.enum([
  "chrome",
  "chromium",
  "brave",
  "edge",
  "arc",
  "firefox",
]);
export type DesktopBrowserImportBrowser = z.infer<
  typeof DesktopBrowserImportBrowserSchema
>;

/** One browser profile found on this device. Paths and cookies stay in main. */
export const DesktopBrowserImportSourceSchema = z.object({
  id: z.string().min(1).max(200),
  browser: DesktopBrowserImportBrowserSchema,
  browserLabel: z.string().max(60),
  profileLabel: z.string().max(120),
  supported: z.boolean(),
  note: z.string().max(300).nullable(),
  /** Password capability is separate from sign-ins (which use cookies). */
  passwordImport: z.object({
    supported: z.boolean(),
    note: z.string().max(300).nullable(),
  }),
});
export type DesktopBrowserImportSource = z.infer<
  typeof DesktopBrowserImportSourceSchema
>;

export const DesktopBrowserImportSourcesSchema = z.object({
  sources: z.array(DesktopBrowserImportSourceSchema).max(60),
  note: z.string().max(300).nullable(),
});
export type DesktopBrowserImportSources = z.infer<
  typeof DesktopBrowserImportSourcesSchema
>;

export const DesktopBrowserImportInputSchema = z
  .object({ sourceId: z.string().min(1).max(200) })
  .strict();
export type DesktopBrowserImportInput = z.infer<
  typeof DesktopBrowserImportInputSchema
>;

/**
 * The browser profiles the Assistant may name. A source id encodes a local
 * path, so the Assistant chooses by browser and profile name instead.
 */
export const BrowserSignInSourcesSchema = z.object({
  sources: z
    .array(
      DesktopBrowserImportSourceSchema.omit({ id: true, passwordImport: true }),
    )
    .max(60),
  note: z.string().max(300).nullable(),
});
export type BrowserSignInSources = z.infer<typeof BrowserSignInSourcesSchema>;

export const ImportBrowserSignInsInputSchema = z
  .object({
    browser: DesktopBrowserImportBrowserSchema,
    /** Needed only when that browser has more than one profile. */
    profileLabel: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type ImportBrowserSignInsInput = z.infer<
  typeof ImportBrowserSignInsInputSchema
>;

/**
 * A still of the active page, used while app chrome (a menu, a picker) has to
 * sit above the native page view, which always paints over the app's own
 * document. Null when there is no page to show.
 */
export const DesktopBrowserSnapshotSchema = z
  .object({ dataUrl: z.string().startsWith("data:image/").nullable() })
  .strict();
export type DesktopBrowserSnapshot = z.infer<
  typeof DesktopBrowserSnapshotSchema
>;

export const AddBrowserJobInputSchema = z
  .object({ tabId: BrowserTabIdSchema })
  .strict();
export type AddBrowserJobInput = z.infer<typeof AddBrowserJobInputSchema>;
export const AddBrowserJobResultSchema = z
  .object({
    jobId: z.string().min(1),
    title: z.string(),
    company: z.string(),
    planName: z.string().nullable(),
  })
  .strict();
export type AddBrowserJobResult = z.infer<typeof AddBrowserJobResultSchema>;

export interface DesktopBrowserBridge {
  passwords: BrowserPasswordsBridge;
  addCurrentJob(input: AddBrowserJobInput): Promise<AddBrowserJobResult>;
  getState(): Promise<DesktopBrowserState>;
  command(command: DesktopBrowserCommand): Promise<DesktopBrowserState>;
  setViewport(viewport: DesktopBrowserViewport): Promise<void>;
  captureActivePage(): Promise<DesktopBrowserSnapshot>;
  listImportSources(): Promise<DesktopBrowserImportSources>;
  importFromBrowser(
    input: DesktopBrowserImportInput,
  ): Promise<DesktopBrowserImportResult>;
  onStateChanged(listener: (state: DesktopBrowserState) => void): () => void;
  onFocusAddress(listener: () => void): () => void;
}

export {
  resolveBrowserAddress,
  type DesktopBrowserAddressResolution,
} from "./plain-values";
