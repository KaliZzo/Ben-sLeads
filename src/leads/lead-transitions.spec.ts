import type { CallOutcome } from '../agent/call-outcome';
import { LeadStatus } from '../generated/prisma/enums';
import type { CallDisposition } from '../voice/voice-provider';
import { nextLeadState } from './lead-transitions';

const policy = { maxAttempts: 3, retryDelayMs: 60 * 60 * 1000 };
const now = new Date('2026-10-05T14:00:00Z');
const inOneHour = new Date('2026-10-05T15:00:00Z');

function after(disposition: CallDisposition, outcome: CallOutcome | null, attempts = 1, altPhoneUntried = false) {
  return nextLeadState({ attempts, disposition, outcome, now, altPhoneUntried }, policy);
}

describe('nextLeadState', () => {
  it('books the meeting with the collected details', () => {
    const update = after('answered', {
      result: 'BOOKED',
      meetingAt: '2026-10-07T10:30:00-04:00',
      customerName: 'Dana Smith',
      address: '1 Main St, Springfield',
      zipCode: '62701',
      notes: 'Has a dog',
    });

    expect(update).toEqual({
      status: LeadStatus.BOOKED,
      meetingAt: new Date('2026-10-07T14:30:00Z'),
      customerName: 'Dana Smith',
      address: '1 Main St, Springfield',
      zipCode: '62701',
      notes: 'Has a dog',
    });
  });

  it('still books when the agent produced an unreadable time, and flags what to confirm', () => {
    const update = after('answered', { result: 'BOOKED', meetingAt: 'next tuesday-ish', address: '1 Main St' });
    expect(update).toEqual({
      status: LeadStatus.BOOKED,
      meetingAt: null,
      address: '1 Main St',
      followUpReason: 'Booked, but the time, ZIP code is missing or unclear. Confirm with the customer.',
    });
  });

  it('records the reason when not interested', () => {
    const update = after('answered', { result: 'NOT_INTERESTED', notInterestedReason: 'Already has a provider' });
    expect(update).toEqual({ status: LeadStatus.NOT_INTERESTED, notInterestedReason: 'Already has a provider' });
  });

  it('never calls again after a do-not-call request', () => {
    expect(after('answered', { result: 'DO_NOT_CALL' }, 1).status).toBe(LeadStatus.DO_NOT_CALL);
  });

  it('calls back at the requested time', () => {
    const update = after('answered', { result: 'CALLBACK', callbackAt: '2026-10-06T18:00:00Z' });
    expect(update).toEqual({
      status: LeadStatus.PENDING,
      nextAttemptAt: new Date('2026-10-06T18:00:00Z'),
      callbackAt: new Date('2026-10-06T18:00:00Z'),
      dialAltPhone: false,
    });
  });

  it('hands the lead to a person when the customer asks for one', () => {
    const update = after('answered', {
      result: 'NEEDS_HUMAN',
      callbackAt: '2026-10-05T21:00:00Z',
      followUpReason: 'Wants to schedule the repair from an earlier estimate.',
    });
    expect(update).toEqual({
      status: LeadStatus.NEEDS_HUMAN,
      callbackAt: new Date('2026-10-05T21:00:00Z'),
      followUpReason: 'Wants to schedule the repair from an earlier estimate.',
    });
    expect(after('answered', { result: 'NEEDS_HUMAN' })).toMatchObject({ followUpReason: 'Customer asked to speak with a person.' });
  });

  it('hands a callback to a person when no automatic attempts are left, instead of dropping it', () => {
    expect(after('answered', { result: 'CALLBACK', callbackAt: '2026-10-05T21:00:00Z' }, 3)).toEqual({
      status: LeadStatus.NEEDS_HUMAN,
      callbackAt: new Date('2026-10-05T21:00:00Z'),
      followUpReason: 'Asked to be called back; no automatic attempts left.',
      dialAltPhone: false,
    });
  });

  it('uses the normal retry delay when the callback time is missing or in the past', () => {
    expect(after('answered', { result: 'CALLBACK' }).nextAttemptAt).toEqual(inOneHour);
    expect(after('answered', { result: 'CALLBACK', callbackAt: '2020-01-01T00:00:00Z' }).nextAttemptAt).toEqual(inOneHour);
  });

  it.each<CallDisposition>(['no-answer', 'busy', 'voicemail', 'failed'])('retries after %s', (disposition) => {
    expect(after(disposition, null)).toEqual({ status: LeadStatus.PENDING, nextAttemptAt: inOneHour, dialAltPhone: false });
  });

  it('retries an answered call that ended without a decision or without an outcome', () => {
    expect(after('answered', { result: 'NO_DECISION' }).status).toBe(LeadStatus.PENDING);
    expect(after('answered', null).status).toBe(LeadStatus.PENDING);
  });

  it('gives up once the last attempt is used', () => {
    expect(after('no-answer', null, 3)).toEqual({ status: LeadStatus.UNREACHABLE, dialAltPhone: false });
    expect(after('answered', { result: 'NO_DECISION' }, 3).status).toBe(LeadStatus.UNREACHABLE);
  });

  it('keeps details from a call without a decision', () => {
    const update = after('answered', { result: 'NO_DECISION', customerName: 'Dana', notes: '' });
    expect(update).toEqual({ status: LeadStatus.PENDING, nextAttemptAt: inOneHour, customerName: 'Dana', dialAltPhone: false });
  });

  describe('platform failure', () => {
    const inTenMinutes = new Date('2026-10-05T14:10:00Z');
    const failed = (extra: Partial<Parameters<typeof nextLeadState>[0]>) =>
      nextLeadState({ attempts: 1, disposition: 'failed', outcome: null, now, ...extra }, { maxAttempts: 1, retryDelayMs: 3_600_000 });

    it('retries in ten minutes and hands back the attempt, even on the last one', () => {
      expect(failed({ totalCalls: 1 })).toEqual({ status: LeadStatus.PENDING, nextAttemptAt: inTenMinutes, dialAltPhone: false, attempts: 0 });
    });

    it('retries the second phone without touching attempts, which it never counted', () => {
      expect(failed({ totalCalls: 2, dialedAltPhone: true })).toEqual({
        status: LeadStatus.PENDING,
        nextAttemptAt: inTenMinutes,
        dialAltPhone: true,
        attempts: 1,
      });
    });

    it('stops retrying once the lead has had enough calls, so a broken setup cannot loop', () => {
      expect(failed({ totalCalls: 4 })).toEqual({ status: LeadStatus.UNREACHABLE, dialAltPhone: false });
    });

    it('does not apply to unanswered calls', () => {
      expect(nextLeadState({ attempts: 1, disposition: 'no-answer', outcome: null, now, totalCalls: 1 }, { maxAttempts: 1, retryDelayMs: 1 }).status).toBe(
        LeadStatus.UNREACHABLE,
      );
    });
  });

  describe('second phone', () => {
    it.each<CallDisposition>(['no-answer', 'busy', 'voicemail', 'failed'])('dials it right away after %s, even on the last attempt', (disposition) => {
      expect(after(disposition, null, 3, true)).toEqual({ status: LeadStatus.PENDING, nextAttemptAt: now, dialAltPhone: true });
    });

    it('is not dialed when the first phone answered', () => {
      expect(after('answered', { result: 'NO_DECISION' }, 1, true)).toMatchObject({ dialAltPhone: false });
      expect(after('answered', { result: 'BOOKED', meetingAt: '2026-10-07T10:30:00-04:00' }, 1, true).status).toBe(LeadStatus.BOOKED);
    });
  });
});
