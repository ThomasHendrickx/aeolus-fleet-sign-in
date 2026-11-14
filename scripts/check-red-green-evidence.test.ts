import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isProductionFile, isTestFile, readCommits, redGreenViolations } from './check-red-green-evidence.ts';
import { createTemporaryRepository, type TemporaryRepository } from './support/temporary-repository.ts';

let repository: TemporaryRepository;
let base: string;

beforeEach(() => {
  repository = createTemporaryRepository();
  repository.write('packages/sign-in/src/core/accounts/rules.ts', 'export const fleet = 1;\n');
  repository.write('packages/sign-in/src/core/accounts/rules.test.ts', 'test 1\n');
  base = repository.commit('feat(accounts): fleet');
});

afterEach(() => {
  repository.dispose();
});

function violations(head: string): string[] {
  return redGreenViolations(readCommits(repository.path, { base, head }));
}

function red(subject = 'test(accounts): fleet name rule (red)'): string {
  repository.write('packages/sign-in/src/core/accounts/rules.test.ts', `test ${subject}\n`);
  return repository.commit(subject);
}

function green(subject = 'feat(accounts): fleet name rule'): string {
  repository.write('packages/sign-in/src/core/accounts/rules.ts', `export const fleet = '${subject}';\n`);
  return repository.commit(subject);
}

describe('the red-green evidence check', () => {
  it('passes a (red) commit followed by the code that makes it pass', () => {
    red();
    const head = green();

    expect(violations(head)).toEqual([]);
  });

  it('passes several red and green pairs', () => {
    red('test(accounts): first rule (red)');
    green('feat(accounts): first rule');
    red('test(accounts): second rule (red)');
    const head = green('feat(accounts): second rule');

    expect(violations(head)).toEqual([]);
  });

  it('refuses production code without a (red) commit before it, naming commit and files', () => {
    const head = green('feat(accounts): untested');

    expect(violations(head)).toEqual([
      `${head.slice(0, 12)} "feat(accounts): untested" changes production code (packages/sign-in/src/core/accounts/rules.ts), but the commit before it is not a (red) commit that only adds or changes tests`,
    ]);
  });

  it('refuses when the (red) commit is not directly before the code', () => {
    red();
    repository.write('docs/notes.md', 'notes\n');
    repository.commit('docs: notes');
    const head = green();

    expect(violations(head)).toHaveLength(1);
  });

  it('refuses a second production commit after one (red) commit', () => {
    red();
    green('feat(accounts): the rule');
    const head = green('feat(accounts): another rule');

    expect(violations(head)).toEqual([expect.stringContaining('"feat(accounts): another rule"')]);
  });

  it('refuses the code after a (red) commit that also changes production code', () => {
    repository.write('packages/sign-in/src/core/accounts/rules.test.ts', 'test red\n');
    repository.write('packages/sign-in/src/core/accounts/supply.ts', 'export const supply = 1;\n');
    repository.commit('test(accounts): fleet name rule (red)');
    const head = green();

    expect(violations(head)).toEqual([expect.stringContaining('"feat(accounts): fleet name rule"')]);
  });

  it('refuses a (red) commit that changes anything but tests', () => {
    repository.write('packages/sign-in/src/core/accounts/rules.test.ts', 'test red\n');
    repository.write('docs/notes.md', 'notes\n');
    repository.commit('test(accounts): fleet name rule (red)');
    const head = green();

    expect(violations(head)).toHaveLength(1);
  });

  it('refuses a test commit whose subject does not end in (red)', () => {
    red('test(accounts): fleet name rule');
    const head = green();

    expect(violations(head)).toHaveLength(1);
  });

  it('refuses a (red) commit that deletes a test', () => {
    repository.remove('packages/sign-in/src/core/accounts/rules.test.ts');
    repository.commit('test(accounts): drop a test (red)');
    const head = green();

    expect(violations(head)).toHaveLength(1);
  });

  it('refuses a fix commit without a (red) commit before it', () => {
    const head = green('fix(accounts): the fleet name');

    expect(violations(head)).toEqual([expect.stringContaining('"fix(accounts): the fleet name"')]);
  });

  it('passes a fix commit directly after a (red) commit', () => {
    red();
    const head = green('fix(accounts): the fleet name');

    expect(violations(head)).toEqual([]);
  });

  it.each(['feat: fleet name', 'feat(accounts)!: fleet name', 'fix!: fleet name'])(
    'judges %j as a feat or fix commit, with or without a scope or a breaking mark',
    (subject) => {
      const head = green(subject);

      expect(violations(head)).toHaveLength(1);
    },
  );

  it('refuses a feat commit that only deletes production code without a (red) commit', () => {
    repository.remove('packages/sign-in/src/core/accounts/rules.ts');
    const head = repository.commit('feat(accounts): remove fleet');

    expect(violations(head)).toHaveLength(1);
  });

  it.each([
    'refactor(accounts): tidy the rule',
    'docs(accounts): say what the fleet is',
    'chore(accounts): bump',
    'style(accounts): format',
    'perf(accounts): faster',
    'test(accounts): more cases',
    'build: the package',
    'ci: the check',
    'revert: the rule',
  ])('passes %j, which is neither feat nor fix, wherever it comes', (subject) => {
    const head = green(subject);

    expect(violations(head)).toEqual([]);
  });

  it('takes only the type at the start of the subject: feat or fix elsewhere in it does not count', () => {
    const head = green('chore(accounts): feat(accounts) and fix the rule');

    expect(violations(head)).toEqual([]);
  });

  it('takes test support in a test folder as a test', () => {
    repository.write('packages/sign-in/test/support/in-memory.ts', 'fake\n');
    repository.commit('test(accounts): an in-memory fake (red)');
    const head = green();

    expect(violations(head)).toEqual([]);
  });

  it('judges every file in src, adapters included', () => {
    repository.write('packages/sign-in/src/adapters/fleet/rest-fleet-door.ts', 'export const door = 1;\n');
    const head = repository.commit('feat(accounts): a door');

    expect(violations(head)).toEqual([
      expect.stringContaining('changes production code (packages/sign-in/src/adapters/fleet/rest-fleet-door.ts)'),
    ]);
  });

  it('does not judge tests, docs, scripts, config or Markdown in src', () => {
    repository.write('packages/sign-in/src/core/accounts/rules.test.ts', 'test only\n');
    repository.commit('test(accounts): more cases');
    repository.write('packages/sign-in/src/core/accounts/README.md', '# Accounts\n');
    repository.write('packages/sign-in/prisma.config.ts', 'config\n');
    repository.write('scripts/set-version.ts', 'script\n');
    repository.write('docs/blueprint.md', 'blueprint\n');
    const head = repository.commit('docs: many things');

    expect(violations(head)).toEqual([]);
  });

  it('judges only the pull request, not its base', () => {
    const head = repository.commit('chore: nothing');

    expect(violations(head)).toEqual([]);
  });

  it('does not judge merge commits, and a merge is no (red) commit', () => {
    repository.git(['switch', '--quiet', '--create', 'slice']);
    red();
    green();
    repository.git(['switch', '--quiet', 'main']);
    repository.write('packages/sign-in/src/core/accounts/supply.ts', 'export const supply = 1;\n');
    const movedBase = repository.commit('feat(accounts): supply, merged on main meanwhile');
    repository.git(['switch', '--quiet', 'slice']);
    repository.git(['merge', '--quiet', '--no-edit', 'main']);
    const afterMerge = green('feat(accounts): after the merge');
    // CI passes the base branch as it is now, so what the merge brought in is not the pull request's.
    base = movedBase;

    expect(violations(afterMerge)).toEqual([expect.stringContaining('"feat(accounts): after the merge"')]);
  });

  it('reads renames with their previous path', () => {
    repository.git(['mv', 'packages/sign-in/src/core/accounts/rules.test.ts', 'packages/sign-in/src/core/accounts/rules-name.test.ts']);
    repository.commit('test(accounts): rename the test (red)');
    repository.git(['mv', 'packages/sign-in/src/core/accounts/rules.ts', 'packages/sign-in/src/core/accounts/rules-name.ts']);
    const head = repository.commit('refactor(accounts): rename the module');

    const commits = readCommits(repository.path, { base, head });
    expect(commits.map((commit) => commit.files)).toEqual([
      [
        {
          status: 'R100',
          previousPath: 'packages/sign-in/src/core/accounts/rules.test.ts',
          path: 'packages/sign-in/src/core/accounts/rules-name.test.ts',
        },
      ],
      [
        {
          status: 'R100',
          previousPath: 'packages/sign-in/src/core/accounts/rules.ts',
          path: 'packages/sign-in/src/core/accounts/rules-name.ts',
        },
      ],
    ]);
    expect(redGreenViolations(commits)).toEqual([]);
  });
});

describe('what counts as a test and as production code', () => {
  it.each([
    'packages/sign-in/src/core/accounts/rules.test.ts',
    'packages/sign-in/src/adapters/http/version.test.tsx',
    'packages/sign-in/test/support/connection.ts',
    'packages/sign-in/test/plugin.integration.test.ts',
  ])('%s is a test file', (path) => {
    expect(isTestFile(path)).toBe(true);
    expect(isProductionFile(path)).toBe(false);
  });

  it.each([
    'packages/sign-in/src/core/accounts/rules.ts',
    'packages/sign-in/src/adapters/prisma/schema.prisma',
    'packages/sign-in/src/adapters/prisma/migrations/20261010100000_init/migration.sql',
    'packages/sign-in/src/app.ts',
  ])('%s is production code', (path) => {
    expect(isProductionFile(path)).toBe(true);
  });

  it.each(['packages/sign-in/src/core/accounts/README.md', 'scripts/set-version.ts', 'packages/sign-in/prisma.config.ts'])(
    '%s is not judged',
    (path) => {
      expect(isProductionFile(path)).toBe(false);
    },
  );
});
