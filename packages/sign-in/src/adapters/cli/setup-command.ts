/** Setup authority is trusted terminal access; the password is never an argument or output. Prints the approved scenes 24 to 26. */
import type { FleetId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { createSetup } from '../../core/accounts/setup.js';

export interface PrivateTerminal {
  readonly isTerminal: boolean;
  prompt(label: string): Promise<string>;
  privatePassword(): Promise<string>;
  write(line: string): void;
}

type Setup = ReturnType<typeof createSetup>;
type Provisioned = Awaited<ReturnType<Setup['resume']>>;

export async function runSetup(input: { fleet: { id: FleetId; name: string }; terminal: PrivateTerminal; setup: Setup }): Promise<number> {
  const { fleet, terminal, setup } = input;
  if (!terminal.isTerminal) {
    terminal.write('Setup needs a private interactive terminal. Password arguments and pipelines are not accepted.');
    return 1;
  }
  const pending = await setup.pendingAccount(fleet.id);
  if (pending !== null) {
    terminal.write(`Resuming the saved account for ${pending.displayName}.`);
    terminal.write(`Resolving ${fleet.name}.`);
    terminal.write('Retrying the same person commission key.');
    const resumed = await setup.resume({ accountId: pending.id, fleetId: fleet.id });
    if (resumed.kind === 'pending') return refused({ terminal, fleet, provisioned: resumed });
    terminal.write('Existing person ship found; mapping saved.');
    terminal.write('Fleet-manager rights reconciled.');
    terminal.write('');
    terminal.write('No second account or person ship was created.');
    terminal.write('Gateway connection must still be checked.');
    return 0;
  }
  const displayName = await terminal.prompt('Display name');
  const email = await terminal.prompt('Email');
  const password = await terminal.privatePassword();
  const parsed = z.object({ displayName: z.string().trim().min(1).max(200), email: z.email().max(320), password: z.string().min(1).max(1024) }).safeParse({ displayName, email, password });
  if (!parsed.success) { terminal.write('A display name, email and password are required.'); return 1; }
  const established = await setup.establish({ ...parsed.data, fleetId: fleet.id });
  terminal.write('');
  if (established.kind === 'pending') return refused({ terminal, fleet, provisioned: established });
  terminal.write('Account identity saved.');
  terminal.write(`Fleet: ${fleet.name}`);
  terminal.write('Fleet-manager rights granted; argo permission: false.');
  terminal.write('Person ship mapping saved.');
  terminal.write('');
  terminal.write('Open the console to sign in with your account.');
  terminal.write('Check gateway connection before using Bridge.');
  return 0;
}

/** Scene 25: the identity is saved and provisioning waits for the next run. */
function refused(input: { terminal: PrivateTerminal; fleet: { name: string }; provisioned: Extract<Provisioned, { kind: 'pending' }> }): number {
  input.terminal.write(`Setup could not provision ${input.fleet.name}.`);
  if (input.provisioned.reason === 'installationRefused') input.terminal.write('Core refused installation authentication.');
  input.terminal.write('Account identity is saved; provisioning is pending.');
  input.terminal.write('Check the server configuration and retry setup.');
  input.terminal.write('Bridge readiness has not been confirmed.');
  return 1;
}
