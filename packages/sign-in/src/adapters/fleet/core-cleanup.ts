/** Installation cleanup preserves person identity and releases only the owned trierarchs. */
import { commissionShipOutputSchema, fleetListOutputSchema, installationAccountsCutOffOutputSchema, labelsOutputSchema, labelWriteOutputSchema, releaseShipOutputSchema, type FleetId, type ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { AccessCleanup, CleanupFailure, CleanupProgress, CleanupTarget } from '../../core/shared/identity.js';
import type { Result } from '../../core/shared/result.js';

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 20;
const PERSON_NAME_ACCOUNT_CHARACTERS = 12;
const acknowledged = { isOk: true, value: { kind: 'acknowledged' } } as const;
const unavailable = { isOk: false, error: { kind: 'unavailable' } } as const;

export function createCoreCleanup(options: { url: string; installationToken: string }): AccessCleanup {
  return {
    async acknowledge(target) {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      async function call(input: { path: string; fleetId?: FleetId; body?: unknown; query?: unknown }) {
        const query = input.query === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input.query))}`;
        const response = await fetch(`${options.url.replace(/\/$/, '')}/trpc/${input.path}${query}`, {
          method: input.body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', 'x-aeolus-installation-token': options.installationToken, ...(input.fleetId === undefined ? {} : { 'aeolus-fleet': input.fleetId }) },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal, redirect: 'error',
        });
        if (!response.ok) throw new Error('Core cleanup was not acknowledged');
        return z.object({ result: z.object({ data: z.unknown() }) }).parse(await response.json()).result.data;
      }
      try {
        if (target.kind === 'cutOff') {
          installationAccountsCutOffOutputSchema.parse(await call({ path: 'installation.accounts.cutOff', body: { accountId: target.accountId } }));
          return acknowledged;
        }
        if (target.kind !== 'fleet' || target.fleetId === null) return unavailable;
        if (target.personShipId === null) {
          const person = commissionShipOutputSchema.parse(await call({ path: 'fleet.commission', fleetId: target.fleetId, body: {
            name: `person-${target.accountId.slice(0, PERSON_NAME_ACCOUNT_CHARACTERS)}`, type: 'person', kind: 'person',
            scopes: ['messages:send', 'messages:receive'], idempotencyKey: `person-${target.accountId}`,
          } }));
          return { isOk: true, value: { kind: 'personShipFound', personShipId: person.shipId } };
        }
        const fleetId = target.fleetId;
        const list = async (query: unknown) => fleetListOutputSchema.parse(await call({ path: 'fleet.list', fleetId, query }));
        const release = async (shipId: ShipId) => { releaseShipOutputSchema.parse(await call({ path: 'fleet.release', fleetId, body: { shipId } })); };
        const page = await list({ shipIds: [target.personShipId], limit: 1 });
        const person = page.items.find((ship) => ship.id === target.personShipId);
        if (person === undefined || !('labels' in person)) return unavailable;
        const labels = labelsOutputSchema.parse(await call({ path: 'fleet.labels', fleetId }));
        const group = labels.find((label) => label.key === 'group' && label.owner.kind === 'installation');
        for (const label of person.labels.filter((label) => label.labelId === group?.id)) {
          labelWriteOutputSchema.parse(await call({ path: 'fleet.unassignLabel', fleetId, body: { shipId: person.id, valueId: label.valueId } }));
        }
        if (person.status === 'crewed') await release(person.id);
        if (target.shouldReleaseOwnedTrierarchs) return await releaseOwned({ target, list, release });
        return acknowledged;
      } catch { return unavailable; }
    },
  };
}

async function releaseOwned(input: { target: CleanupTarget; list: (query: unknown) => Promise<z.infer<typeof fleetListOutputSchema>>; release: (shipId: ShipId) => Promise<void> }): Promise<Result<CleanupProgress, CleanupFailure>> {
  const page = await input.list({ kind: ['trierarch'], limit: PAGE_SIZE, ...(input.target.cursor === null ? {} : { cursor: input.target.cursor }) });
  for (const ship of page.items) {
    if (!('ownerShipId' in ship)) throw new Error('Installation could not read a trierarch owner');
    if (ship.ownerShipId === input.target.personShipId && ship.status === 'crewed') await input.release(ship.id);
  }
  return page.nextCursor === null ? acknowledged : { isOk: true, value: { kind: 'pageReleased', cursor: page.nextCursor } };
}
