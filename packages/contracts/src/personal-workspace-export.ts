import { z } from "zod";
import {
  type AssistantConversation,
  type AssistantMessage,
  AssistantConversationSchema,
  AssistantMessageSchema,
} from "./assistant";
import { IsoDateTimeSchema } from "./base";
import { ApplyQueueSchema, type ApplyQueue } from "./apply-queue";
import {
  type JobFinderRepositoryState,
  JobFinderRepositoryStateSchema,
} from "./workspace";

export type PersonalWorkspaceExport = {
  schemaVersion: 1;
  exportedAt: string;
  repositoryState: JobFinderRepositoryState;
  /** Saved choices live outside the repository seed in existing exports. */
  workspace?: { applyQueue?: ApplyQueue | null | undefined } | undefined;
  fileRoots: {
    name: "resumes" | "attachments" | "application-documents";
    directory: string;
  }[];
  assistantHistory: {
    conversation: AssistantConversation;
    messages: AssistantMessage[];
  }[];
  files: { path: string; encoding: "base64"; content: string }[];
};
export const PersonalWorkspaceExportSchema: z.ZodType<
  PersonalWorkspaceExport,
  z.ZodTypeDef,
  unknown
> = z.object({
  schemaVersion: z.literal(1),
  exportedAt: IsoDateTimeSchema,
  repositoryState: JobFinderRepositoryStateSchema,
  workspace: z
    .object({ applyQueue: ApplyQueueSchema.nullable().optional() })
    .optional(),
  fileRoots: z
    .array(
      z.object({
        name: z.enum(["resumes", "attachments", "application-documents"]),
        directory: z.string().min(1),
      }),
    )
    .max(3),
  assistantHistory: z.array(
    z.object({
      conversation: AssistantConversationSchema,
      messages: z.array(AssistantMessageSchema),
    }),
  ),
  files: z.array(
    z.object({
      path: z.string().min(1),
      encoding: z.literal("base64"),
      content: z.string(),
    }),
  ),
});
export const PersonalWorkspaceRestorePreviewSchema = z.object({
  token: z.string().uuid(),
  profileName: z.string(),
  exportedAt: IsoDateTimeSchema,
  jobs: z.number().int().nonnegative(),
  applications: z.number().int().nonnegative(),
  answers: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  chats: z.number().int().nonnegative(),
});
export type PersonalWorkspaceRestorePreview = z.infer<
  typeof PersonalWorkspaceRestorePreviewSchema
>;
export const ConfirmPersonalWorkspaceRestoreSchema = z
  .object({ token: z.string().uuid() })
  .strict();
export const PersonalWorkspaceRestoreResultSchema = z.object({
  safetyExportPath: z.string().min(1),
});
export type PersonalWorkspaceRestoreResult = z.infer<
  typeof PersonalWorkspaceRestoreResultSchema
>;
