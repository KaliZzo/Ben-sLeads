import { z } from 'zod';

/**
 * What the agent must extract from every answered call.
 * This one schema is both the instruction given to the voice provider
 * (as JSON Schema) and the validator for what comes back.
 */
export const callOutcomeSchema = z.object({
  result: z
    .enum(['BOOKED', 'NOT_INTERESTED', 'CALLBACK', 'NEEDS_HUMAN', 'DO_NOT_CALL', 'NO_DECISION'])
    .describe(
      'BOOKED: customer agreed to an appointment with a specific date and time. ' +
        'NOT_INTERESTED: customer declined. ' +
        'CALLBACK: customer asked to be called back later, or agreed to a follow-up time. ' +
        'NEEDS_HUMAN: customer asked to speak with a person, wants something the agent cannot book ' +
        '(for example scheduling work after an earlier estimate), or the call was transferred to the team. ' +
        'DO_NOT_CALL: customer asked not to be called again. ' +
        'NO_DECISION: anything else (hung up early, unclear, wrong person, call screener or voicemail).',
    ),
  meetingAt: z
    .string()
    .optional()
    .describe('Agreed appointment start as ISO 8601 with UTC offset, e.g. 2026-10-06T15:00:00-04:00. Only when BOOKED.'),
  callbackAt: z
    .string()
    .optional()
    .describe('When the customer asked to be called back, ISO 8601 with UTC offset. When CALLBACK or NEEDS_HUMAN.'),
  customerName: z.string().optional().describe('Full name as confirmed by the customer.'),
  address: z.string().optional().describe('Address where the appointment takes place.'),
  zipCode: z.string().optional().describe('ZIP code of the appointment address, e.g. 90210.'),
  notInterestedReason: z.string().optional().describe('Why the customer declined, in their words. Only when NOT_INTERESTED.'),
  followUpReason: z
    .string()
    .optional()
    .describe('What the team needs to do and why, in one sentence. Only when NEEDS_HUMAN.'),
  notes: z.string().optional().describe('Anything else the visiting employee should know.'),
});

export type CallOutcome = z.infer<typeof callOutcomeSchema>;

// Without the "$schema" key: Vapi rejects it.
const { $schema: _dialect, ...callOutcomeJsonSchemaBody } = z.toJSONSchema(callOutcomeSchema, { io: 'input' });
export const callOutcomeJsonSchema = callOutcomeJsonSchemaBody;

/** Returns a validated outcome, or null when the provider gave us nothing usable. */
export function parseCallOutcome(data: unknown): CallOutcome | null {
  const parsed = callOutcomeSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Parses an ISO date-time the agent produced. Returns null when it is missing or not a valid date. */
export function parseAgentDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
