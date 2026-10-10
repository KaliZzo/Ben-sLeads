import { z } from 'zod';

const csv = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const envSchema = z
  .object({
    PORT: z.coerce.number().int().default(3000),
    DATABASE_URL: z.string().min(1),
    /** Public URL of this app, used by providers to reach our webhook. */
    PUBLIC_BASE_URL: z.url(),
    /** Shared secret that every provider webhook must carry. */
    WEBHOOK_SECRET: z.string().min(16),

    VOICE_PROVIDER: z.enum(['vapi', 'fake']).default('fake'),
    LEAD_SINK: z.enum(['google-sheets', 'log']).default('log'),

    DIALER_ENABLED: z.stringbool().default(true),
    /** Keep at or below your voice provider plan's concurrent-call limit. */
    MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).default(4),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
    RETRY_DELAY_MINUTES: z.coerce.number().int().min(1).default(240),
    /** Calls start only between these hours in the lead's local time (end is exclusive). */
    CALLING_HOURS_START: z.coerce.number().int().min(0).max(23).default(9),
    CALLING_HOURS_END: z.coerce.number().int().min(1).max(24).default(20),
    DEFAULT_TIMEZONE: z.string().default('America/New_York'),

    VAPI_API_KEY: z.string().optional(),
    /** Imported (Twilio/Telnyx) numbers in Vapi. Calls rotate across them. */
    VAPI_PHONE_NUMBER_IDS: csv.default([]),
    VAPI_LLM_MODEL: z.string().default('gpt-5.6-terra'),
    /** Text-to-speech provider inside Vapi. `vapi` is Vapi's own voices; the others are billed through Vapi too. */
    VAPI_VOICE_PROVIDER: z.enum(['vapi', '11labs', 'cartesia']).default('vapi'),
    VAPI_VOICE_ID: z.string().default('Layla'),
    /** Vapi voice generation (only for VAPI_VOICE_PROVIDER=vapi). Vapi uses version 1 when omitted. */
    VAPI_VOICE_VERSION: z.enum(['1', '2', 'latest']).default('2'),
    /** Model of a non-Vapi voice, e.g. eleven_flash_v2_5 or sonic-3.5. */
    VAPI_VOICE_MODEL: z.string().optional(),
    /** Deepgram model. Flux detects the end of the customer's turn itself; nova-3 is the fallback. */
    VAPI_TRANSCRIBER_MODEL: z.string().default('flux-general-en'),
    /** The name the agent introduces itself with. Match it to the voice. */
    AGENT_NAME: z.string().min(1).default('Layla'),
    /** The business named at the start of every call. The FCC requires it for artificial-voice calls. */
    COMPANY_NAME: z.preprocess((value) => (value === '' ? undefined : value), z.string().optional()),
    /** E.164 number of a person on the team. When set, the agent can transfer callers who ask for a human. */
    TRANSFER_PHONE_NUMBER: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be E.164, e.g. +14155550123').optional(),
    ),

    GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional(),
    GOOGLE_SHEETS_TAB: z.string().default('Leads'),
    /** Path to the service-account JSON key; read by Google's client library. */
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.VOICE_PROVIDER === 'vapi') {
      if (!env.VAPI_API_KEY) ctx.addIssue({ code: 'custom', path: ['VAPI_API_KEY'], message: 'required when VOICE_PROVIDER=vapi' });
      if (env.VAPI_PHONE_NUMBER_IDS.length === 0)
        ctx.addIssue({ code: 'custom', path: ['VAPI_PHONE_NUMBER_IDS'], message: 'required when VOICE_PROVIDER=vapi' });
    }
    if (env.LEAD_SINK === 'google-sheets') {
      for (const key of ['GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_APPLICATION_CREDENTIALS'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required when LEAD_SINK=google-sheets' });
      }
    }
    if (env.CALLING_HOURS_START >= env.CALLING_HOURS_END) {
      ctx.addIssue({ code: 'custom', path: ['CALLING_HOURS_END'], message: 'must be after CALLING_HOURS_START' });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
