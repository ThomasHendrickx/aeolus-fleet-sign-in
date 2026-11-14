/** Setup authority is trusted terminal access; the password is never an argument or output. */
import type { FleetId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { createSetup } from '../../core/accounts/setup.js';

export interface PrivateTerminal {
  readonly isTerminal: boolean;
  prompt(label: string): Promise<string>;
  privatePassword(): Promise<string>;
  write(line: string): void;
}

export async function runSetup(input: { fleetId: FleetId; terminal: PrivateTerminal; setup: ReturnType<typeof createSetup> }): Promise<number> {
  if (!input.terminal.isTerminal) {
    input.terminal.write('Setup needs a private interactive terminal. Password arguments and pipelines are not accepted.');
    return 1;
  }
  const displayName = await input.terminal.prompt('Display name');
  const email = await input.terminal.prompt('Email');
  const password = await input.terminal.privatePassword();
  const parsed = z.object({ displayName: z.string().trim().min(1).max(200), email: z.email().max(320), password: z.string().min(1).max(1024) }).safeParse({ displayName, email, password });
  if (!parsed.success) { input.terminal.write('A display name, email and password are required.'); return 1; }
  const result = await input.setup({ ...parsed.data, fleetId: input.fleetId });
  if (result.kind === 'unavailable') {
    input.terminal.write('Setup is pending. Check server configuration and retry the same setup.');
    return 1;
  }
  input.terminal.write('Account identity saved.');
  input.terminal.write('Fleet-manager rights granted; argo permission: false.');
  input.terminal.write('Person ship mapping saved.');
  input.terminal.write('Open the console to sign in with your account.');
  input.terminal.write('Check gateway connection before using Bridge.');
  return 0;
}
