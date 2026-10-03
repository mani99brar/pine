import { z } from 'zod'

// Wire schemas of the backend account routes (packages/api/src/modules/markets/notifications.ts), and the shape of the
// `api` mode account preferences that stay in this browser (the backend has no preferences API).

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** One notification of GET /api/v1/accounts/me/notifications. `message` is shown as plain text only. */
export const pineNotificationSchema = z.object({
  id: z.uuid(),
  market: z.string().regex(ADDRESS),
  /** evidence_closing, reveal_closing, answers_open, finalization_soon, arbitration_<stage>, finalized, resolved */
  kind: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** Unix seconds the notification is about (deadline, answer time, stage time). */
  target: z.number().int().nonnegative(),
  message: z.string().max(2000),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
})

export type PineNotification = z.infer<typeof pineNotificationSchema>

/** GET /api/v1/accounts/me/notifications (50 per page, newest first). */
export const pineNotificationPageSchema = z.object({
  items: z.array(pineNotificationSchema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
})

export type PineNotificationPage = z.infer<typeof pineNotificationPageSchema>

/** POST /api/v1/accounts/me/notifications/:id/read (idempotent: the first read time is kept). */
export const pineNotificationReadSchema = z.object({ id: z.uuid(), readAt: z.iso.datetime() })

/**
 * `api` mode preferences kept in localStorage per signed-in wallet. Only what the UI lets the user set is stored;
 * everything else stays at its default. Unknown keys are dropped, and anything malformed is ignored as a whole.
 */
export const localPreferencesSchema = z.object({
  defaultSpendingLimit: z
    .string()
    .regex(/^\d{1,15}(?:\.\d{1,6})?$/)
    .refine((v) => /[1-9]/.test(v), 'must be positive')
    .optional(),
  displayCurrency: z.enum(['collateral', 'usd']).optional(),
})

export type LocalPreferences = z.infer<typeof localPreferencesSchema>
