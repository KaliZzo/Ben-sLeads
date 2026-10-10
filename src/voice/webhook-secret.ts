import { timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SECRET_HEADER = 'x-webhook-secret';

/** Constant-time check of the shared-secret header we ask providers to send. */
export function hasWebhookSecret(headers: Record<string, string | string[] | undefined>, secret: string): boolean {
  const received = headers[WEBHOOK_SECRET_HEADER];
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
