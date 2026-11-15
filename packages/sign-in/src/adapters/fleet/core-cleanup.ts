/** Installation cleanup preserves person identity and releases only the owned trierarchs. */
import { commissionShipOutputSchema, fleetListOutputSchema, installationAccountsCutOffOutputSchema, labelsOutputSchema, labelWriteOutputSchema, releaseShipOutputSchema, type FleetId, type ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { AccessCleanup, CleanupFailure, CleanupProgress, CleanupTarget } from '../../core/shared/identity.js';
import type { Result } from '../../core/shared/result.js';
import { contractMismatch } from '../contract-mismatch.js';

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 20;
const PERSON_NAME_ACCOUNT_CHARACTERS = 12;
const acknowledged = { isOk: true, value: { kind: 'acknowledged' } } as const;
const unavailable = { isOk: false, error: { kind: 'unavailable' } } as const;

/** Raised when core answers outside a procedure's contract, carrying what it received for the log. */
class ContractMismatchError extends Error {
  constructor(readonly logLine: string) { super(logLine); }
}

export function createCoreCleanup(options: { url: string; installationToken: string; log: (message: string) => void }): AccessCleanup {
  return {
    async acknowledge(target) {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      async function call<T>(input: { path: string; output: z.ZodType<T>; fleetId?: FleetId; body?: unknown; query?: unknown }): Promise<T> {
        const query = input.query === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input.query))}`;
        const response = await fetch(`${options.url.replace(/\/$/, '')}/trpc/${input.path}${query}`, {
          method: input.body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', 'x-aeolus-installation-token': options.installationToken, ...(input.fleetId === undefined ? {} : { 'aeolus-fleet': input.fleetId }) },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal, redirect: 'error',
        });
        if (!response.ok) throw new Error('Core cleanup was not acknowledged');
        const received: unknown = await response.json();
        const answer = z.object({ result: z.object({ data: input.output }) }).safeParse(received);
        if (!answer.success) throw new ContractMismatchError(contractMismatch({ procedure: input.path, received, error: answer.error }));
        return answer.data.result.data;
      }
      try {
        if (target.kind === 'cutOff') {
          await call({ path: 'installation.accounts.cutOff', output: installationAccountsCutOffOutputSchema, body: { accountId: target.accountId } });
          return acknowledged;
        }
        if (target.kind !== 'fleet' || target.fleetId === null) return unavailable;
        if (target.personShipId === null) {
          const person = await call({ path: 'fleet.commission', output: commissionShipOutputSchema, fleetId: target.fleetId, body: {
            name: `person-${target.accountId.slice(0, PERSON_NAME_ACCOUNT_CHARACTERS)}`, type: 'person', kind: 'person',
            scopes: ['messages:send', 'messages:receive'], idempotencyKey: `person-${target.accountId}`,
          } });
          return { isOk: true, value: { kind: 'personShipFound', personShipId: person.shipId } };
        }
        const fleetId = target.fleetId;
        const list = (query: unknown) => call({ path: 'fleet.list', output: fleetListOutputSchema, fleetId, query });
        const release = async (shipId: ShipId) => { await call({ path: 'fleet.release', output: releaseShipOutputSchema, fleetId, body: { shipId } }); };
        const page = await list({ shipIds: [target.personShipId], limit: 1 });
        // A person ship that is gone, or carries no labels, has nothing left to clear.
        const person = page.items.find((ship) => ship.id === target.personShipId);
        if (person !== undefined) {
          if ('labels' in person && person.labels.length > 0) {
            const labels = await call({ path: 'fleet.labels', output: labelsOutputSchema, fleetId });
            const group = labels.find((label) => label.key === 'group' && label.owner.kind === 'installation');
            for (const label of person.labels.filter((label) => label.labelId === group?.id)) {
              await call({ path: 'fleet.unassignLabel', output: labelWriteOutputSchema, fleetId, body: { shipId: person.id, valueId: label.valueId } });
            }
          }
          if (person.status === 'crewed') await release(person.id);
        }
        if (target.shouldReleaseOwnedTrierarchs) return await releaseOwned({ target, list, release });
        return acknowledged;
      } catch (error) {
        if (error instanceof ContractMismatchError) options.log(error.logLine);
        return unavailable;
      }
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
