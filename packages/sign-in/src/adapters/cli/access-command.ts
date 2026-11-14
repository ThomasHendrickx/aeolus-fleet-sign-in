/** Server authority removes access durably; recovery reads credentials only from a private terminal. */
import { accountIdSchema, idSchema, type FleetId } from '@aeolus-fleet/common';

import { MINIMUM_PASSWORD_LENGTH } from '../../core/accounts/password.js';
import type { createAccess } from '../../core/reconciliation/access.js';
import type { PrivateTerminal } from './setup-command.js';

const CLEANUP_BATCH = 3;
const MAXIMUM_PASSWORD_LENGTH = 1024;
const commandFailure = 'Sign-in could not complete. Check the command and its server configuration; no access was granted.';
const notFound = 'Account identity was not found. Check the account id and retry.';

export async function runAccessCommand(input: { args: readonly string[]; fleets: readonly { id: FleetId }[]; terminal: PrivateTerminal; access: ReturnType<typeof createAccess> }): Promise<number> {
  const { terminal, access } = input;
  const [command, ...args] = input.args;
  if (command === 'reconcile' && args.length === 0) {
    terminal.write('Retrying saved cleanup.');
    return reconcile({ terminal, access });
  }
  const flags = flagsOf(args);
  const parsed = accountIdSchema.safeParse(flags?.get('--account'));
  const allowed = command === 'recover' ? ['--account', '--fleet', '--enable', '--fleet-manager'] : command === 'remove-rights' ? ['--account', '--fleet'] : command === 'disable' ? ['--account'] : [];
  if (flags === null || !parsed.success || [...flags.keys()].some((flag) => !allowed.includes(flag))) { terminal.write(commandFailure); return 1; }
  const fleet = flags.get('--fleet');
  const fleetId = fleet === undefined ? null : idSchema('fleet').safeParse(fleet);
  if (fleetId !== null && (!fleetId.success || !input.fleets.some((registered) => registered.id === fleetId.data))) { terminal.write('Choose a configured fleet.'); return 1; }
  const selectedFleet = fleetId === null ? null : fleetId.data;
  if (command === 'remove-rights' && selectedFleet === null) { terminal.write('Choose a configured fleet.'); return 1; }
  if (command === 'recover') {
    if (flags.has('--fleet-manager') !== (selectedFleet !== null)) { terminal.write(commandFailure); return 1; }
    if (!terminal.isTerminal) { terminal.write('Recovery needs a private interactive terminal. Password arguments and pipelines are not accepted.'); return 1; }
    const password = await terminal.privatePassword();
    if (password.length < MINIMUM_PASSWORD_LENGTH || password.length > MAXIMUM_PASSWORD_LENGTH) { terminal.write('A password of at least 15 characters is required.'); return 1; }
    const result = await access.recover({ accountId: parsed.data, password, shouldEnable: flags.has('--enable'), fleetId: selectedFleet });
    if (result.kind === 'notFound') { terminal.write(notFound); return 1; }
    if (result.kind === 'pending') { terminal.write('Recovery is waiting for access removal to finish. Retry reconciliation before recovery.'); return 1; }
    terminal.write('Account credential reset. Old shared sign-ins revoked.');
    if (flags.has('--enable')) terminal.write('Account enabled.');
    if (selectedFleet !== null) terminal.write('Fleet-manager rights restored; argo permission: false.');
    terminal.write('Account identity and person ship mapping are unchanged.');
    terminal.write('Open the console to sign in with your account.');
    terminal.write('Released agents need crews again.');
    return 0;
  }
  const removed = await access.remove({ accountId: parsed.data, fleetId: selectedFleet });
  if (removed.kind === 'notFound') { terminal.write(notFound); return 1; }
  terminal.write('Access removal saved. New account tokens are refused.');
  terminal.write('Shared sign-ins revoked.');
  terminal.write(command === 'disable' ? 'Account disabled; cleanup is pending.' : 'Fleet rights removed; cleanup is pending.');
  return reconcile({ terminal, access });
}

function flagsOf(args: readonly string[]): Map<string, string> | null {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith('--') || flags.has(flag)) return null;
    if (flag === '--enable' || flag === '--fleet-manager') { flags.set(flag, 'true'); continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) return null;
    flags.set(flag, value);
  }
  return flags;
}

async function reconcile(input: { terminal: PrivateTerminal; access: ReturnType<typeof createAccess> }): Promise<number> {
  for (let index = 0; index < CLEANUP_BATCH; index += 1) if ((await input.access.reconcile()).kind === 'complete') break;
  if (await input.access.hasPending()) { input.terminal.write('Cleanup is still pending. Check the server configuration and retry reconciliation.'); return 1; }
  input.terminal.write('No pending cleanup remains.');
  input.terminal.write('Access removal complete. Person ship history and ownership are retained.');
  return 0;
}
