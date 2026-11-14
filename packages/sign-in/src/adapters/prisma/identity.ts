/** Indexed installation identity state, with atomic transitions and restart-safe migrations. */
import { readFile } from 'node:fs/promises';

import { accountIdSchema, idSchema, type AccountId } from '@aeolus-fleet/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { z } from 'zod';

import type { Account, FleetRight, Identity, IdentityRecords } from '../../core/shared/identity.js';
import { PrismaClient, type Prisma } from './generated/client.js';

const sessionSchema = z.object({ accountId: accountIdSchema, expiresAt: z.number() });
const authorizationSchema = z.object({ clientId: z.string(), redirectUri: z.string(), state: z.string(), codeChallenge: z.string(), browser: z.string(), expiresAt: z.number() });
const codeSchema = z.object({ clientId: z.string(), redirectUri: z.string(), codeChallenge: z.string(), signInHash: z.string(), expiresAt: z.number() });
const attemptsSchema = z.object({ since: z.number(), failures: z.number(), refusedUntil: z.number() });

export async function openIdentity(databaseUrl: string) {
  await migrate(databaseUrl);
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 4 }) });
  const identity: Identity = {
    transaction: (work) => client.$transaction(async (transaction) => {
      // One installation's first-person identity transitions are short and serialized across processes.
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(1810)`;
      return work(recordsOf(transaction));
    }, { timeout: 15_000, maxWait: 15_000 }),
  };
  return { identity, close: () => client.$disconnect() };
}

function recordsOf(client: Prisma.TransactionClient): IdentityRecords {
  const load = async (key: string) => (await client.identityRecord.findUnique({ where: { key } }))?.data ?? null;
  const save = async (key: string, data: Prisma.InputJsonObject) => { await client.identityRecord.upsert({ where: { key }, create: { key, data }, update: { data } }); };
  const remove = async (key: string) => { await client.identityRecord.deleteMany({ where: { key } }); };
  return {
    account: async (email) => accountOf(await client.account.findUnique({ where: { email } })),
    accountById: async (id) => accountOf(await client.account.findUnique({ where: { id } })),
    saveAccount: async (account) => { await client.account.upsert({ where: { id: account.id }, create: account, update: account }); },
    right: async ({ accountId, fleetId }) => rightOf(await client.fleetRight.findUnique({ where: { fleetId_accountId: { fleetId, accountId } } })),
    saveRight: async (right) => {
      const data = { ...right, scopes: [...right.scopes], groupValues: [...right.groupValues] };
      await client.fleetRight.upsert({ where: { fleetId_accountId: { fleetId: right.fleetId, accountId: right.accountId } }, create: data, update: data });
    },
    session: async (hash) => nullable(sessionSchema, await load(`session/${hash}`)),
    saveSession: ({ hash, session }) => save(`session/${hash}`, { ...session }),
    deleteSession: (hash) => remove(`session/${hash}`),
    authorization: async (hash) => nullable(authorizationSchema, await load(`authorization/${hash}`)),
    saveAuthorization: ({ hash, authorization }) => save(`authorization/${hash}`, { ...authorization }),
    deleteAuthorization: (hash) => remove(`authorization/${hash}`),
    code: async (hash) => nullable(codeSchema, await load(`code/${hash}`)),
    saveCode: ({ hash, code }) => save(`code/${hash}`, { ...code }),
    deleteCode: (hash) => remove(`code/${hash}`),
    attempts: async (key) => nullable(attemptsSchema, await load(`attempts/${key}`)),
    saveAttempts: ({ key, attempts }) => save(`attempts/${key}`, { ...attempts }),
  };
}

function nullable<T>(schema: z.ZodType<T>, value: unknown): T | null {
  return value === null ? null : schema.parse(value);
}

function accountOf(row: Omit<Account, 'id'> & { id: string } | null): Account | null {
  return row === null ? null : { ...row, id: accountIdSchema.parse(row.id) };
}

function rightOf(row: { accountId: string; fleetId: string; personShipId: string | null; scopes: string[]; groupValues: string[]; isFleetManager: boolean } | null): FleetRight | null {
  if (row === null) return null;
  // Fleet/ship ids already passed public API validation before persistence.
  const { fleetId, personShipId } = z.object({ fleetId: idSchema('fleet'), personShipId: idSchema('ship').nullable() }).parse(row);
  const accountId: AccountId = accountIdSchema.parse(row.accountId);
  return { ...row, accountId, fleetId, personShipId };
}

async function migrate(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1810)');
    await client.query('CREATE TABLE IF NOT EXISTS sign_in_migrations (version INTEGER PRIMARY KEY)');
    const applied = await client.query('SELECT version FROM sign_in_migrations WHERE version = 1');
    if (applied.rowCount === 0) {
      await client.query(await readFile(new URL('./migrations/001-identity.sql', import.meta.url), 'utf8'));
      await client.query('INSERT INTO sign_in_migrations(version) VALUES (1)');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
