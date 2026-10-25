import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";

// ---------------------------------------------------------------------------
// Append-only rapid review decisions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// In-app campaign notifications
// ---------------------------------------------------------------------------

export const CampaignNotificationKindSchema = z.enum([
  "digest_ready",
  "strong_match",
  "blocked_work",
  "schedule_paused",
  "rule_effect_update",
]);
export type CampaignNotificationKind = z.infer<
  typeof CampaignNotificationKindSchema
>;

export const CampaignNotificationSchema = z
  .object({
    id: NonEmptyStringSchema,
    campaignId: NonEmptyStringSchema,
    kind: CampaignNotificationKindSchema,
    title: NonEmptyStringSchema.max(200),
    body: NonEmptyStringSchema.max(2_000).nullable().default(null),
    createdAt: IsoDateTimeSchema,
    readAt: IsoDateTimeSchema.nullable().default(null),
    unread: z.boolean().default(true),
    jobId: NonEmptyStringSchema.nullable().default(null),
    sourceTargetId: NonEmptyStringSchema.nullable().default(null),
  })
  .strict()
  .superRefine((notification, context) => {
    if (notification.readAt !== null && notification.unread) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unread"],
        message: "A notification with a readAt timestamp must not be unread.",
      });
    }

    if (!notification.unread && notification.readAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readAt"],
        message: "A read notification requires a readAt timestamp.",
      });
    }
  });
export type CampaignNotification = z.infer<typeof CampaignNotificationSchema>;

export const CampaignNotificationCollectionSchema = z
  .object({
    notifications: z.array(CampaignNotificationSchema).max(5_000).default([]),
    unreadCount: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((collection, context) => {
    const actualUnreadCount = collection.notifications.filter(
      (notification) => notification.unread,
    ).length;

    if (collection.unreadCount !== actualUnreadCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unreadCount"],
        message: `unreadCount must equal the number of unread notifications (expected ${actualUnreadCount}).`,
      });
    }
  });
export type CampaignNotificationCollection = z.infer<
  typeof CampaignNotificationCollectionSchema
>;
