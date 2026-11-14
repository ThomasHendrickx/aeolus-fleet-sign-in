/** Sends the existing authenticated, repeatable gateway accountDisabled notification. */
import type { FleetId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { AccessCleanup } from '../../core/shared/identity.js';

const TIMEOUT_MS = 10_000;
const acknowledgement = z.object({ result: z.object({ data: z.strictObject({}) }) });

export function createAccessCleanup(input: { installationToken: string; gateways: readonly { id: FleetId; gatewayUrl: string }[]; core: AccessCleanup }): AccessCleanup {
  return {
    async acknowledge(target) {
      if (target.kind !== 'gateway') return input.core.acknowledge(target);
      const gateway = input.gateways.find((candidate) => candidate.id === target.fleetId);
      if (gateway === undefined) return false;
      try {
        const response = await fetch(new URL('/trpc/installation.accountDisabled', gateway.gatewayUrl), {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-aeolus-installation-token': input.installationToken },
          body: JSON.stringify({ fleetId: target.fleetId, accountId: target.accountId }),
          signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
        });
        return response.ok && acknowledgement.safeParse(await response.json()).success;
      } catch { return false; }
    },
  };
}
