/** Cleanup outcomes as the adapters answer them, for fakes of the cleanup port. */
import type { ShipId } from '@aeolus-fleet/common';

import type { CleanupFailure, CleanupProgress } from '../../src/core/shared/identity.js';
import type { Result } from '../../src/core/shared/result.js';

type CleanupOutcome = Result<CleanupProgress, CleanupFailure>;

export const acknowledged: CleanupOutcome = { isOk: true, value: { kind: 'acknowledged' } };
export const unavailable: CleanupOutcome = { isOk: false, error: { kind: 'unavailable' } };

export function pageReleased(cursor: string): CleanupOutcome {
  return { isOk: true, value: { kind: 'pageReleased', cursor } };
}

export function personShipFound(personShipId: ShipId): CleanupOutcome {
  return { isOk: true, value: { kind: 'personShipFound', personShipId } };
}

export function outcomeOf(isAcknowledged: boolean): CleanupOutcome {
  return isAcknowledged ? acknowledged : unavailable;
}
