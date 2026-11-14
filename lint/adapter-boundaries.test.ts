import { describe, expect, it } from 'vitest';

import { createLint, reportsOf } from './support/lint-probe.ts';

// Prisma and pg live in the Prisma adapter only, and core's internals in tests
// only (CLAUDE.md, "Architecture rules").

const signIn = {
  prisma: 'packages/sign-in/src/adapters/prisma/boundary-probe.ts',
  http: 'packages/sign-in/src/adapters/http/boundary-probe.ts',
  test: 'packages/sign-in/test/boundary-probe.ts',
  adapterTest: 'packages/sign-in/src/adapters/fleet/boundary-probe.test.ts',
};
const script = 'scripts/boundary-probe.ts';

// Import rules need no package-specific typing, so every probe is typed with the root tsconfig.
const lint = createLint({ tsconfig: 'tsconfig.json', probes: [...Object.values(signIn), script] });

async function importViolations(messages: Promise<Parameters<typeof reportsOf>[0]>): Promise<string[]> {
  const reported = await messages;
  return [...reportsOf(reported, 'no-restricted-imports'), ...reportsOf(reported, 'no-restricted-syntax')];
}

const databaseImports = [
  { label: 'the Prisma client', code: "import { PrismaClient } from '@prisma/client';" },
  { label: 'the Prisma pg adapter', code: "import { PrismaPg } from '@prisma/adapter-pg';" },
  { label: 'pg', code: "import pg from 'pg';" },
  { label: 'a pg package', code: "import Pool from 'pg-pool';" },
];

describe('Prisma and pg outside the Prisma adapter', () => {
  it.each(databaseImports)('refuses $label in another adapter', async ({ code }) => {
    await expect(importViolations(lint(code, signIn.http))).resolves.toEqual([
      expect.stringMatching(/is imported only in the prisma adapter \(src\/adapters\/prisma\)/),
    ]);
  });

  it.each(databaseImports)('refuses $label in a test', async ({ code }) => {
    await expect(importViolations(lint(code, signIn.test))).resolves.toHaveLength(1);
  });

  it.each(databaseImports)('refuses $label in scripts', async ({ code }) => {
    await expect(importViolations(lint(code, script))).resolves.toHaveLength(1);
  });

  it.each(databaseImports)('allows $label in the Prisma adapter', async ({ code }) => {
    await expect(importViolations(lint(code, signIn.prisma))).resolves.toEqual([]);
  });

  it('allows the Prisma adapter itself everywhere else', async () => {
    const code = "import { createPrismaClient } from '../src/adapters/prisma/client.js';";

    await expect(importViolations(lint(code, signIn.test))).resolves.toEqual([]);
  });
});

const coreImports = [
  { label: 'Aeolus core', code: "import type { AppRouter } from '@aeolus-fleet/core';" },
  { label: "Aeolus core's test support", code: "import { createApp } from '@aeolus-fleet/core/testing';" },
  { label: 'Aeolus core through import()', code: "export const load = () => import('@aeolus-fleet/core');" },
];

describe("core's server internals outside tests", () => {
  it.each(coreImports)('refuses $label in an adapter', async ({ code }) => {
    await expect(importViolations(lint(code, signIn.http))).resolves.toEqual([
      expect.stringMatching(/@aeolus-fleet\/core is imported only in tests/),
    ]);
  });

  it.each(coreImports)('refuses $label in the Prisma adapter', async ({ code }) => {
    await expect(importViolations(lint(code, signIn.prisma))).resolves.toHaveLength(1);
  });

  it.each(coreImports)('allows $label in a test', async ({ code }) => {
    await expect(importViolations(lint(code, signIn.adapterTest))).resolves.toEqual([]);
    await expect(importViolations(lint(code, signIn.test))).resolves.toEqual([]);
  });

  it('allows common in an adapter', async () => {
    await expect(importViolations(lint("import { SCOPES } from '@aeolus-fleet/common';", signIn.http))).resolves.toEqual([]);
  });
});
