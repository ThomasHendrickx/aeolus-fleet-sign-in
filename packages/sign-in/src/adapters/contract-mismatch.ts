/**
 * The log line for a remote answer outside its contract: the procedure, what was received and why it did not match.
 * Values under secret or token keys are redacted, since a commission answer carries a ship secret.
 */
import { z } from 'zod';

const SECRET_KEY = /secret|token/i;

export function contractMismatch(input: { procedure: string; received: unknown; error: z.ZodError }): string {
  const received = JSON.stringify(input.received, (key, value: unknown) => (SECRET_KEY.test(key) ? '[redacted]' : value));
  return `Cleanup answer from ${input.procedure} is outside its contract; the target stays pending. Received: ${received}. ${z.prettifyError(input.error)}`;
}
