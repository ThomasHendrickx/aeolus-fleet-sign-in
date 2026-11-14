/** Calls only core's published installation and fleet APIs; never authenticates as argo. */
import {
  changeLabelValuesOutputSchema, commissionShipOutputSchema,
  installationFleetSchema, installationAccountsSignOutOutputSchema, labelsOutputSchema, scopesOutputSchema,
  type AccountId, type FleetId, type NetworkRule,
} from '@aeolus-fleet/common';
import { z } from 'zod';

import type { FleetRight } from '../../core/shared/identity.js';
import { CoreCompatibilityError } from './core-compatibility-error.js';

export const MINIMUM_CORE_VERSION = '0.39.0';
const [MINIMUM_MAJOR = 0, MINIMUM_MINOR = 0] = MINIMUM_CORE_VERSION.split('.').map(Number);
/** Core's development builds report this version and are accepted. */
const DEVELOPMENT_VERSION = '0.0.0';
/** The design's person ship name: `person-` and the first 12 account-id characters. */
const PERSON_NAME_ACCOUNT_CHARACTERS = 12;
const TIMEOUT_MS = 10_000;
const MANAGER_GROUP = 'fleet-manager';
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** Core refused the installation token: a configuration problem, reported as such rather than as an outage. */
class InstallationRefused extends Error {}

export function createPersonFleets(options: { url: string; installationToken: string }) {
  const url = options.url.replace(/\/$/, '');

  async function call(input: { path: string; fleetId?: FleetId; body?: unknown; signal?: AbortSignal }) {
    const response = await fetch(`${url}${input.path}`, {
      method: input.body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-aeolus-installation-token': options.installationToken, ...(input.fleetId === undefined ? {} : { 'aeolus-fleet': input.fleetId }) },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: input.signal ?? AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
    });
    if (response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN) throw new InstallationRefused();
    if (!response.ok) throw new Error('Core refused the installation request');
    const result: unknown = await response.json();
    return input.path.startsWith('/trpc/') ? z.object({ result: z.object({ data: z.unknown() }) }).parse(result).result.data : result;
  }

  async function groupOf(fleetId: FleetId, signal: AbortSignal) {
    const read = async () => labelsOutputSchema.parse(await call({ path: '/trpc/fleet.labels', fleetId, signal })).find((label) => label.key === 'group');
    let group = await read();
    if (group === undefined) {
      try { await call({ path: '/trpc/fleet.defineLabel', fleetId, signal, body: { key: 'group', values: [MANAGER_GROUP] } }); }
      catch (error) { if (await read() === undefined) throw error; }
      group = await read();
    }
    if (group?.owner.kind !== 'installation') throw new Error('The installation must own the group label');
    let managerId = group.values.find((value) => value.value === MANAGER_GROUP)?.id;
    if (managerId === undefined) {
      const changed = changeLabelValuesOutputSchema.parse(await call({ path: '/trpc/fleet.changeLabelValues', fleetId, signal, body: { labelId: group.id, values: [...group.values.map((value) => value.value), MANAGER_GROUP] } }));
      managerId = changed.values.find((value) => value.value === MANAGER_GROUP)?.id;
    }
    if (managerId === undefined) throw new Error('Fleet manager group is unavailable');
    const rules: NetworkRule[] = [
      { verb: 'send', from: [{ labelId: group.id, value: '#' }], to: [{ labelId: group.id, value: '#' }] },
      { verb: 'read', from: [managerId], to: [] },
      { verb: 'manage', from: [managerId], to: [] },
    ];
    await call({ path: '/trpc/fleet.declareNetworkRules', fleetId, signal, body: { rules } });
    return managerId;
  }

  return {
    async signOut(accountId: AccountId) {
      installationAccountsSignOutOutputSchema.parse(await call({ path: '/trpc/installation.accounts.signOut', body: { accountId } }));
    },
    async checkCompatibility() {
      let version: string;
      try { version = z.object({ server: z.string().regex(/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/) }).parse(await call({ path: '/api/version' })).server; }
      catch { throw new CoreCompatibilityError({ minimum: MINIMUM_CORE_VERSION, reported: null }); }
      const [major = 0, minor = 0] = version.split('.').map(Number);
      if (version !== DEVELOPMENT_VERSION && (major < MINIMUM_MAJOR || (major === MINIMUM_MAJOR && minor < MINIMUM_MINOR))) throw new CoreCompatibilityError({ minimum: MINIMUM_CORE_VERSION, reported: version });
    },
    async reconcile(input: { accountId: AccountId; fleetId: FleetId }) {
      try { return { kind: 'reconciled' as const, right: await reconcileRight(input) }; }
      catch (error) {
        if (error instanceof InstallationRefused) return { kind: 'installationRefused' as const };
        throw error;
      }
    },
  };

  async function reconcileRight(input: { accountId: AccountId; fleetId: FleetId }): Promise<FleetRight> {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const found = await call({ path: `/trpc/installation.fleets.get?input=${encodeURIComponent(JSON.stringify({ fleetId: input.fleetId }))}`, signal });
      installationFleetSchema.parse(found);
      const namespaces = scopesOutputSchema.parse(await call({ path: '/trpc/fleet.scopes', fleetId: input.fleetId, signal }));
      const groupValueId = await groupOf(input.fleetId, signal);
      const person = commissionShipOutputSchema.parse(await call({ path: '/trpc/fleet.commission', fleetId: input.fleetId, signal, body: {
        name: `person-${input.accountId.slice(0, PERSON_NAME_ACCOUNT_CHARACTERS)}`, type: 'person', kind: 'person', idempotencyKey: `person-${input.accountId}`,
        scopes: ['messages:send', 'messages:receive'], valueIds: [groupValueId],
      } }));
      await call({ path: '/trpc/fleet.assignLabel', fleetId: input.fleetId, signal, body: { shipId: person.shipId, valueId: groupValueId } });
      return { ...input, personShipId: person.shipId, scopes: namespaces.flatMap((namespace) => namespace.scopes.map((scope) => scope.scope)), groupValues: [MANAGER_GROUP], isFleetManager: true };
  }
}
