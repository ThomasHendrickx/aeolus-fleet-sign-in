/** Calls only core's published installation and fleet APIs; never authenticates as argo. */
import {
  changeLabelValuesOutputSchema, commissionShipOutputSchema,
  installationFleetSchema, labelsOutputSchema, scopesOutputSchema,
  type AccountId, type FleetId, type NetworkRule,
} from '@aeolus-fleet/common';
import { z } from 'zod';

import type { FleetRight } from '../../core/shared/identity.js';

export const MINIMUM_CORE_VERSION = '0.39.0';
const TIMEOUT_MS = 10_000;
const MANAGER_GROUP = 'fleet-manager';

export function createPersonFleets(options: { url: string; installationToken: string }) {
  const url = options.url.replace(/\/$/, '');

  async function call(input: { path: string; fleetId?: FleetId; body?: unknown }) {
    const response = await fetch(`${url}${input.path}`, {
      method: input.body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-aeolus-installation-token': options.installationToken, ...(input.fleetId === undefined ? {} : { 'aeolus-fleet': input.fleetId }) },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
    });
    if (!response.ok) throw new Error('Core refused the installation request');
    const result: unknown = await response.json();
    return input.path.startsWith('/trpc/') ? z.object({ result: z.object({ data: z.unknown() }) }).parse(result).result.data : result;
  }

  async function groupOf(fleetId: FleetId) {
    const read = async () => labelsOutputSchema.parse(await call({ path: '/trpc/fleet.labels', fleetId })).find((label) => label.key === 'group');
    let group = await read();
    if (group === undefined) {
      try { await call({ path: '/trpc/fleet.defineLabel', fleetId, body: { key: 'group', values: [MANAGER_GROUP] } }); }
      catch (error) { if (await read() === undefined) throw error; }
      group = await read();
    }
    if (group?.owner.kind !== 'installation') throw new Error('The installation must own the group label');
    let managerId = group.values.find((value) => value.value === MANAGER_GROUP)?.id;
    if (managerId === undefined) {
      const changed = changeLabelValuesOutputSchema.parse(await call({ path: '/trpc/fleet.changeLabelValues', fleetId, body: { labelId: group.id, values: [...group.values.map((value) => value.value), MANAGER_GROUP] } }));
      managerId = changed.values.find((value) => value.value === MANAGER_GROUP)?.id;
    }
    if (managerId === undefined) throw new Error('Fleet manager group is unavailable');
    const rules: NetworkRule[] = [
      { verb: 'send', from: [{ labelId: group.id, value: '#' }], to: [{ labelId: group.id, value: '#' }] },
      { verb: 'read', from: [managerId], to: [] },
      { verb: 'manage', from: [managerId], to: [] },
    ];
    await call({ path: '/trpc/fleet.declareNetworkRules', fleetId, body: { rules } });
    return managerId;
  }

  return {
    async checkCompatibility() {
      const version = z.object({ server: z.string() }).parse(await call({ path: '/api/version' })).server;
      const parts = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
      if (parts === null || (version !== '0.0.0' && Number(parts[1]) === 0 && Number(parts[2]) < 39)) throw new Error(`Sign-in requires core ${MINIMUM_CORE_VERSION} or newer`);
    },
    async reconcile(input: { accountId: AccountId; fleetId: FleetId }): Promise<FleetRight> {
      const found = await call({ path: `/trpc/installation.fleets.get?input=${encodeURIComponent(JSON.stringify({ fleetId: input.fleetId }))}` });
      installationFleetSchema.parse(found);
      const namespaces = scopesOutputSchema.parse(await call({ path: '/trpc/fleet.scopes', fleetId: input.fleetId }));
      const groupValueId = await groupOf(input.fleetId);
      const person = commissionShipOutputSchema.parse(await call({ path: '/trpc/fleet.commission', fleetId: input.fleetId, body: {
        name: `person-${input.accountId.slice(0, 12)}`, type: 'person', kind: 'person', idempotencyKey: `person-${input.accountId}`,
        scopes: ['messages:send', 'messages:receive'], valueIds: [groupValueId],
      } }));
      await call({ path: '/trpc/fleet.assignLabel', fleetId: input.fleetId, body: { shipId: person.shipId, valueId: groupValueId } });
      return { ...input, personShipId: person.shipId, scopes: namespaces.flatMap((namespace) => namespace.scopes.map((scope) => scope.scope)), groupValues: [MANAGER_GROUP], isFleetManager: true };
    },
  };
}
