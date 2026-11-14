/** Safe diagnostic fields only; upstream response bodies and credentials are never logged. */
export class CoreCompatibilityError extends Error {
  override name = 'CoreCompatibilityError';
  constructor(input: { minimum: string; reported: string | null }) {
    super(`Sign-in requires core ${input.minimum} or newer; ${input.reported === null ? 'core did not answer a version' : `core reported ${input.reported}`}.`);
  }
}
