/** Trusted setup uses private password input and reports readiness separately from Bridge. */
import { describe, expect, it } from 'vitest';

import { aSetup } from '../../../test/support/setup-fixtures.js';
import { runSetup } from './setup-command.js';

function terminalOfMaya() {
  const output: string[] = [];
  return {
    output,
    isTerminal: true,
    prompt: (label: string) => Promise.resolve(label === 'Display name' ? 'Maya' : 'maya@example.test'),
    privatePassword: () => Promise.resolve('private-password'),
    write: (line: string) => { output.push(line); },
  };
}

describe('trusted server setup', () => {
  it('reads the password privately and reports the saved identity without claiming a gateway connection', async () => {
    // Given a trusted interactive terminal and a successful setup boundary.
    const terminal = terminalOfMaya();
    const established = new Map<string, string>();

    // When the command establishes Maya on the existing fleet.
    const status = await runSetup({ fleetId: aSetup().input.fleetId, terminal, setup: (input) => {
      established.set(input.email, input.password);
      return Promise.resolve({ kind: 'ready', accountId: aSetup().secrets.accountId(), personShipId: 'shp_00000000000000000000000001' });
    } });

    // Then input reached the setup boundary but never appeared in terminal output.
    expect(status).toBe(0);
    expect(established.get('maya@example.test')).toBe('private-password');
    expect(terminal.output.join('\n')).toContain('Check gateway connection before using Bridge.');
    expect(terminal.output.join('\n')).not.toContain('private-password');
  });

  it('refuses non-terminal password input and reports pending provisioning without leaking server configuration', async () => {
    // Given input that could echo a password into a pipeline.
    const terminal = terminalOfMaya();
    terminal.isTerminal = false;
    const setup = () => Promise.resolve({ kind: 'unavailable' as const });

    // When setup is attempted without, then with, a private terminal.
    expect(await runSetup({ fleetId: aSetup().input.fleetId, terminal, setup })).toBe(1);
    terminal.isTerminal = true;
    expect(await runSetup({ fleetId: aSetup().input.fleetId, terminal, setup })).toBe(1);

    // Then no password is read publicly and provisioning remains explicitly pending.
    expect(terminal.output.join('\n')).toContain('Setup is pending. Check server configuration and retry the same setup.');
  });
});
