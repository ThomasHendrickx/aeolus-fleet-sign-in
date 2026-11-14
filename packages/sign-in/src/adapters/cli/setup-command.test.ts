/** Trusted setup uses private password input and prints the approved setup output of scenes 24 to 26. */
import { describe, expect, it } from 'vitest';

import { approvedOutput } from '../../../test/support/approved-mockups.js';
import { memoryIdentity } from '../../../test/support/memory-identity.js';
import { aSetup, fleetOfMaya } from '../../../test/support/setup-fixtures.js';
import { createSetup } from '../../core/accounts/setup.js';
import { runSetup } from './setup-command.js';

const workshop = { id: aSetup().input.fleetId, name: 'workshop' };

function terminalOfMaya() {
  const output: string[] = [];
  const prompted: string[] = [];
  return {
    output, prompted,
    isTerminal: true,
    prompt: (label: string) => { prompted.push(label); return Promise.resolve(label === 'Display name' ? 'Maya' : 'maya@example.test'); },
    privatePassword: () => { prompted.push('Password'); return Promise.resolve(aSetup().input.password); },
    write: (line: string) => { output.push(line); },
  };
}

function setupOfMaya() {
  const identity = memoryIdentity();
  const fleet = fleetOfMaya(identity);
  return { identity, fleet, setup: createSetup({ identity, fleet, secrets: aSetup().secrets }) };
}

describe('trusted server setup', () => {
  it('prints scene 24 after reading the password privately', async () => {
    // Given a trusted interactive terminal on the workshop fleet.
    const terminal = terminalOfMaya();
    const { setup } = setupOfMaya();

    // When Maya is set up.
    const status = await runSetup({ fleet: workshop, terminal, setup });

    // Then the approved output follows the prompts, without the password.
    expect(status).toBe(0);
    expect(terminal.prompted).toEqual(['Display name', 'Email', 'Password']);
    expect(terminal.output).toEqual(approvedOutput('24-trusted-setup').slice(4));
    expect(terminal.output.join('\n')).not.toContain(aSetup().input.password);
  });

  it('prints scene 25 when core refuses installation authentication, leaving provisioning pending', async () => {
    // Given core refusing the installation token.
    const terminal = terminalOfMaya();
    const { setup, fleet } = setupOfMaya();
    fleet.shouldRefuseInstallation = true;

    // When Maya is set up.
    const status = await runSetup({ fleet: workshop, terminal, setup });

    // Then the approved refusal says the identity is saved and provisioning is pending.
    expect(status).toBe(1);
    expect(terminal.output).toEqual(approvedOutput('25-setup-configuration-refused').slice(4));
  });

  it('prints scene 26 and resumes the saved account without asking again or creating a second account or person', async () => {
    // Given a first setup whose provisioning stayed pending.
    const { setup, fleet, identity } = setupOfMaya();
    fleet.shouldRefuseInstallation = true;
    await runSetup({ fleet: workshop, terminal: terminalOfMaya(), setup });
    fleet.shouldRefuseInstallation = false;
    const terminal = terminalOfMaya();

    // When setup is run again.
    const status = await runSetup({ fleet: workshop, terminal, setup });

    // Then it resumes Maya's saved account with the approved output, asking nothing.
    expect(status).toBe(0);
    expect(terminal.prompted).toEqual([]);
    expect(terminal.output).toEqual(approvedOutput('26-setup-retry').slice(1));
    expect(identity.accounts.size).toBe(1);
    expect(fleet.people.size).toBe(1);
  });

  it('refuses non-terminal password input', async () => {
    // Given input that could echo a password into a pipeline.
    const terminal = terminalOfMaya();
    terminal.isTerminal = false;

    // When setup is attempted.
    const status = await runSetup({ fleet: workshop, terminal, setup: setupOfMaya().setup });

    // Then nothing is read.
    expect(status).toBe(1);
    expect(terminal.prompted).toEqual([]);
  });
});
