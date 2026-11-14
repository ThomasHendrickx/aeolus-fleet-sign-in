/** Trusted commands report durable removal and recover only explicitly requested access. */
import { describe, expect, it } from 'vitest';

import { memoryIdentity } from '../../../test/support/memory-identity.js';
import { aSetup, fleetOfMaya } from '../../../test/support/setup-fixtures.js';
import { createSetup } from '../../core/accounts/setup.js';
import { createAccess } from '../../core/reconciliation/access.js';
import { accountIdSchema, idSchema } from '@aeolus-fleet/common';
import { cleanupTargetIdSchema, type CleanupTarget } from '../../core/shared/identity.js';
import { runAccessCommand } from './access-command.js';
import { acknowledged, outcomeOf, pageReleased, unavailable } from '../../../test/support/cleanup-outcomes.js';

async function aCommand() {
  const identity = memoryIdentity();
  const setup = aSetup();
  await createSetup({ identity, secrets: setup.secrets, fleet: fleetOfMaya() }).establish(setup.input);
  const output: string[] = [];
  let shouldAcknowledge = false;
  const access = createAccess({ identity, secrets: setup.secrets, cleanup: { acknowledge: () => Promise.resolve(outcomeOf(shouldAcknowledge)) } });
  const terminal = { isTerminal: true, prompt: () => Promise.resolve(''), privatePassword: () => Promise.resolve('replacement-password'), write: (line: string) => { output.push(line); } };
  const run = (args: readonly string[]) => runAccessCommand({ args, access, terminal, fleets: [{ id: setup.input.fleetId }] });
  return { run, output, terminal, identity, accountId: setup.secrets.accountId(), fleetId: setup.input.fleetId, available: () => { shouldAcknowledge = true; } };
}

describe('trusted removal and recovery commands', () => {
  it('reports pending removal and refuses recovery until reconciliation acknowledges every target', async () => {
    // Given a trusted server whose cleanup destinations are unavailable.
    const command = await aCommand();

    // When the operator disables Maya and attempts recovery.
    expect(await command.run(['disable', '--account', command.accountId])).toBe(1);
    expect(command.output).toEqual(['Access removal saved. New account tokens are refused.', 'Shared sign-ins revoked.', 'Account disabled; cleanup is pending.', 'Cleanup is still pending. Check the server configuration and retry reconciliation.']);
    command.output.length = 0;
    expect(await command.run(['recover', '--account', command.accountId, '--enable'])).toBe(1);
    expect(command.output).toEqual(['Recovery is waiting for access removal to finish. Retry reconciliation before recovery.']);
    command.available();

    // Then reconciliation completes and recovery explicitly restores the same account and requested rights.
    expect(await command.run(['reconcile'])).toBe(0);
    command.output.length = 0;
    expect(await command.run(['recover', '--account', command.accountId, '--enable', '--fleet', command.fleetId, '--fleet-manager'])).toBe(0);
    expect(command.output).toEqual(['Account credential reset. Old shared sign-ins revoked.', 'Account enabled.', 'Fleet-manager rights restored; argo permission: false.', 'Account identity and person ship mapping are unchanged.', 'Open the console to sign in with your account.', 'Released agents need crews again.']);
    expect(await command.identity.transaction((records) => records.right({ accountId: command.accountId, fleetId: command.fleetId }))).toMatchObject({ isFleetManager: true, personShipId: 'shp_00000000000000000000000001' });
  });

  it('keeps reconciling the disabled account until every target lands, past another account\'s stuck cleanup', async () => {
    // Given Maya with rights on two fleets, a paged owned-trierarch release, and another account whose cleanup never lands.
    const command = await aCommand();
    const secondFleet = idSchema('fleet').parse('flt_00000000000000000000000002');
    const stranger = accountIdSchema.parse('stranger-account');
    await command.identity.transaction(async (records) => {
      const right = await records.right({ accountId: command.accountId, fleetId: command.fleetId });
      if (right === null) throw new Error('Expected Maya on the first fleet');
      await records.saveRight({ ...right, fleetId: secondFleet });
      await records.saveCleanup({ id: cleanupTargetIdSchema.parse('stranger/1/cutOff/installation'), attempts: 0, cursor: null, accountId: stranger, fleetId: null, personShipId: null, kind: 'cutOff', shouldReleaseOwnedTrierarchs: true });
    });
    const landed: CleanupTarget['id'][] = [];
    const access = createAccess({ identity: command.identity, secrets: aSetup().secrets, cleanup: { acknowledge: (target) => {
      if (target.accountId === stranger) return Promise.resolve(unavailable);
      if (target.kind === 'fleet' && target.fleetId === secondFleet && target.cursor === null) return Promise.resolve(pageReleased('second-page'));
      landed.push(target.id);
      return Promise.resolve(acknowledged);
    } } });
    const run = (args: readonly string[]) => runAccessCommand({ args, access, terminal: command.terminal, fleets: [{ id: command.fleetId }, { id: secondFleet }] });

    // When the operator disables Maya.
    const code = await run(['disable', '--account', command.accountId]);

    // Then every one of Maya's five targets lands and only Maya's cleanup is reported.
    expect(code).toBe(0);
    expect(command.output.slice(-2)).toEqual(['No pending cleanup remains.', 'Access removal complete. Person ship history and ownership are retained.']);
    expect(landed).toHaveLength(5);
    expect(await command.identity.transaction((records) => records.pendingCleanup(command.accountId))).toBeNull();
  });

  it('stops reconciling the disabled account once one target fails and reports it pending', async () => {
    // Given Maya, whose gateway target never lands while the others do.
    const command = await aCommand();
    let attempts = 0;
    const access = createAccess({ identity: command.identity, secrets: aSetup().secrets, cleanup: { acknowledge: (target) => {
      attempts += 1;
      return Promise.resolve(target.kind === 'gateway' ? unavailable : acknowledged);
    } } });

    // When the operator disables Maya.
    const code = await runAccessCommand({ args: ['disable', '--account', command.accountId], access, terminal: command.terminal, fleets: [{ id: command.fleetId }] });

    // Then the command stops at the failure and reports the pending cleanup.
    expect(code).toBe(1);
    expect(command.output.at(-1)).toBe('Cleanup is still pending. Check the server configuration and retry reconciliation.');
    expect(attempts).toBeLessThanOrEqual(3);
  });

  it('refuses password arguments and pipelines, and reports an unknown account without changing access', async () => {
    // Given a non-private terminal.
    const command = await aCommand();
    command.terminal.isTerminal = false;

    // When recovery is attempted from a pipeline or a password argument.
    expect(await command.run(['recover', '--account', command.accountId])).toBe(1);
    expect(command.output).toEqual(['Recovery needs a private interactive terminal. Password arguments and pipelines are not accepted.']);
    command.output.length = 0;
    expect(await command.run(['recover', '--account', command.accountId, '--password', 'do-not-echo-this'])).toBe(1);

    // Then no supplied password is printed or access changed.
    expect(command.output.join('\n')).not.toContain('do-not-echo-this');
    command.output.length = 0;
    expect(await command.run(['disable', '--account', 'unknown-account'])).toBe(1);
    expect(command.output).toEqual(['Account identity was not found. Check the account id and retry.']);
    expect(await command.identity.transaction((records) => records.accountById(command.accountId))).toMatchObject({ isDisabled: false, accessVersion: 0 });
  });
});
