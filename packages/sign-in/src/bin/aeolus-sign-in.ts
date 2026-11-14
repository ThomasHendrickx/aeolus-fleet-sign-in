#!/usr/bin/env node
/** Runnable service and trusted setup; configuration failures never print server secrets. */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';

import { idSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

import { createService } from '../app.js';
import { readConfig } from '../config.js';
import { privateTerminal } from '../adapters/cli/private-terminal.js';
import { createAccess } from '../core/reconciliation/access.js';
import { createCoreCleanup } from '../adapters/fleet/core-cleanup.js';
import { createAccessCleanup } from '../adapters/gateway/access-cleanup.js';
import { runAccessCommand } from '../adapters/cli/access-command.js';
import { runSetup } from '../adapters/cli/setup-command.js';
import { createSecrets } from '../adapters/crypto/secrets.js';
import { createSigner } from '../adapters/crypto/signer.js';
import { createPersonFleets } from '../adapters/fleet/person-fleets.js';
import { CoreCompatibilityError } from '../adapters/fleet/core-compatibility-error.js';
import { openIdentity } from '../adapters/prisma/identity.js';

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'keygen' && args[1] === '--file' && args[2] !== undefined && args.length === 3) {
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeFile(args[2], privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    process.stdout.write('Signing key saved privately. Configure its file and key id on the server.\n');
    return;
  }
  if (!['serve', 'setup', 'migrate', 'disable', 'remove-rights', 'recover', 'reconcile'].includes(args[0] ?? '')) throw new Error('Unknown command');
  const config = readConfig(process.env);
  const fleet = createPersonFleets({ url: config.coreUrl, installationToken: config.installationToken });
  const database = await openIdentity(config.databaseUrl);
  const access = createAccess({ identity: database.identity, secrets: createSecrets(), cleanup: createAccessCleanup({ installationToken: config.installationToken, gateways: config.service.fleets, core: createCoreCleanup({ url: config.coreUrl, installationToken: config.installationToken }) }) });
  if (args[0] === 'migrate') { await database.close(); process.stdout.write('Sign-in database migrated.\n'); return; }
  if (['disable', 'remove-rights', 'recover', 'reconcile'].includes(args[0] ?? '')) {
    try { process.exitCode = await runAccessCommand({ args, fleets: config.service.fleets, terminal: privateTerminal(), access }); }
    finally { await database.close(); }
    return;
  }
  try {
    await fleet.checkCompatibility();
    const keys = await Promise.all(config.signingKeys.map(async (key) => {
      if (((await stat(key.file)).mode & 0o077) !== 0) throw new Error('Signing keys must be private');
      return { id: key.id, privateKey: createPrivateKey(await readFile(key.file, 'utf8')) };
    }));
    const signer = createSigner({ keys, activeKeyId: config.activeKeyId });
    const service = createService({ identity: database.identity, fleet, signer, secrets: createSecrets(), now: () => Date.now(), config: config.service });
    if (args[0] === 'setup') {
      try {
        const fleetId = args.length === 1 && config.service.fleets.length === 1 ? config.service.fleets[0]?.id : args.length === 3 && args[1] === '--fleet' ? idSchema('fleet').parse(args[2]) : undefined;
        const fleet = config.service.fleets.find((registered) => registered.id === fleetId);
        if (fleet === undefined) throw new Error('Choose a configured fleet');
        process.exitCode = await runSetup({ fleet, terminal: privateTerminal(), setup: service.setup });
      } finally { await service.server.close(); await database.close(); }
      return;
    }
    await service.server.listen({ host: '0.0.0.0', port: config.port });
    process.stdout.write('Aeolus sign-in is listening behind its configured HTTPS origin.\n');
    let isClosing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let work = Promise.resolve();
    const retry = () => {
      work = access.reconcile().then(() => undefined).catch(() => {
        process.stderr.write('Cleanup is still pending. Check the server configuration and retry reconciliation.\n');
      }).finally(() => { if (!isClosing) timer = setTimeout(retry, 1000); });
    };
    retry();
    const close = async () => { isClosing = true; clearTimeout(timer); await work; await service.server.close(); await database.close(); };
    process.once('SIGTERM', () => { void close(); });
    process.once('SIGINT', () => { void close(); });
  } catch (error) { await database.close(); throw error; }
}

try { await main(); }
catch (error) {
  if (error instanceof CoreCompatibilityError) {
    const version = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))).version;
    process.stderr.write(`Sign-in ${version}: ${error.message}\n`);
  } else process.stderr.write('Sign-in could not complete. Check the command and its server configuration; no access was granted.\n');
  process.exitCode = 1;
}
