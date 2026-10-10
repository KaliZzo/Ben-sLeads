import { parseAgentDate, type CallOutcome } from '../agent/call-outcome';
import { LeadStatus } from '../generated/prisma/enums';
import type { CallDisposition } from '../voice/voice-provider';

export interface RetryPolicy {
  maxAttempts: number;
  retryDelayMs: number;
}

export interface CallResultInput {
  /** Attempts so far, including the call that just ended. */
  attempts: number;
  disposition: CallDisposition;
  outcome: CallOutcome | null;
  now: Date;
  /** The lead has a second phone that this attempt has not dialed yet. */
  altPhoneUntried?: boolean;
}

/** Fields to write on the lead after a call ends. */
export interface LeadUpdate {
  status: LeadStatus;
  nextAttemptAt?: Date;
  dialAltPhone?: boolean;
  meetingAt?: Date | null;
  customerName?: string;
  address?: string;
  zipCode?: string;
  notes?: string;
  notInterestedReason?: string;
  callbackAt?: Date | null;
  followUpReason?: string;
}

/**
 * The single place that decides what happens to a lead after a call.
 * Pure function: easy to read, easy to test.
 */
export function nextLeadState(input: CallResultInput, policy: RetryPolicy): LeadUpdate {
  const { outcome } = input;
  const details = outcome ? collectedDetails(outcome) : {};

  if (input.disposition === 'answered' && outcome) {
    switch (outcome.result) {
      case 'BOOKED': {
        const meetingAt = parseAgentDate(outcome.meetingAt);
        const missing = [!meetingAt && 'time', !outcome.address && 'address', !outcome.zipCode && 'ZIP code'].filter(Boolean);
        // Still a booking, but the visiting employee must not drive out on a guess.
        const check = missing.length ? { followUpReason: `Booked, but the ${missing.join(', ')} is missing or unclear. Confirm with the customer.` } : {};
        return { ...details, ...check, status: LeadStatus.BOOKED, meetingAt };
      }
      case 'NOT_INTERESTED':
        return { ...details, status: LeadStatus.NOT_INTERESTED };
      case 'DO_NOT_CALL':
        return { ...details, status: LeadStatus.DO_NOT_CALL };
      case 'NEEDS_HUMAN':
        return {
          ...details,
          status: LeadStatus.NEEDS_HUMAN,
          callbackAt: parseAgentDate(outcome.callbackAt),
          followUpReason: outcome.followUpReason || 'Customer asked to speak with a person.',
        };
      case 'CALLBACK': {
        const callbackAt = parseAgentDate(outcome.callbackAt);
        // The customer is waiting for that call. Out of attempts, a person makes it instead of nobody.
        if (input.attempts >= policy.maxAttempts) {
          return {
            ...details,
            status: LeadStatus.NEEDS_HUMAN,
            callbackAt,
            followUpReason: details.followUpReason ?? 'Asked to be called back; no automatic attempts left.',
            dialAltPhone: false,
          };
        }
        return { ...details, callbackAt, ...retryOrGiveUp(input, policy, callbackAt) };
      }
      case 'NO_DECISION':
        break;
    }
  }

  // Nobody picked up: try the second phone right away, as part of the same attempt.
  if (input.disposition !== 'answered' && input.altPhoneUntried) {
    return { status: LeadStatus.PENDING, nextAttemptAt: input.now, dialAltPhone: true };
  }

  // Not answered, voicemail, failed, or answered without a decision: try again later.
  return { ...details, ...retryOrGiveUp(input, policy, null) };
}

function retryOrGiveUp(
  input: CallResultInput,
  policy: RetryPolicy,
  requestedAt: Date | null,
): Pick<LeadUpdate, 'status' | 'nextAttemptAt' | 'dialAltPhone'> {
  if (input.attempts >= policy.maxAttempts) {
    return { status: LeadStatus.UNREACHABLE, dialAltPhone: false };
  }
  const defaultRetry = new Date(input.now.getTime() + policy.retryDelayMs);
  const nextAttemptAt = requestedAt && requestedAt > input.now ? requestedAt : defaultRetry;
  // Every new attempt starts again from the first phone.
  return { status: LeadStatus.PENDING, nextAttemptAt, dialAltPhone: false };
}

function collectedDetails(outcome: CallOutcome): Omit<LeadUpdate, 'status'> {
  const details: Omit<LeadUpdate, 'status'> = {
    customerName: outcome.customerName,
    address: outcome.address,
    zipCode: outcome.zipCode,
    notes: outcome.notes,
    notInterestedReason: outcome.notInterestedReason,
    followUpReason: outcome.followUpReason,
  };
  // Drop empty values so a later call never wipes details collected by an earlier one.
  for (const key of Object.keys(details) as (keyof typeof details)[]) {
    if (!details[key]) delete details[key];
  }
  return details;
}
