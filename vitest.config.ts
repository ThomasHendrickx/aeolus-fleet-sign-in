import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

/**
 * The layers in the order a full run takes them, as each project's name ends
 * (`sign-in:unit`). CI runs each layer as its own job; a full local run takes
 * them one after another too, so no layer's time limits compete with another
 * layer's servers and databases on the same machine.
 */
const LAYERS = ['unit', 'integration', 'browser'];

function inLayerOrder(projects: TestProjectInlineConfiguration[]): TestProjectInlineConfiguration[] {
  return projects.map(withGroupOrder);
}

function withGroupOrder(project: TestProjectInlineConfiguration): TestProjectInlineConfiguration {
  const name = project.test?.name;
  const label = typeof name === 'object' ? name.label : (name ?? '');
  const groupOrder = LAYERS.indexOf(label.split(':').at(-1) ?? '');
  if (groupOrder === -1) {
    throw new Error(`the Vitest project ${label} is in no layer: name it <package>:<${LAYERS.join('|')}>`);
  }
  return { ...project, test: { ...project.test, sequence: { ...project.test?.sequence, groupOrder } } };
}

export default defineConfig({
  test: {
    // Half the machine per run: the tests start servers and databases beside
    // their workers, and other runs share the machine.
    maxWorkers: '50%',
    // A poll's own default (1 second) holds only on an idle machine.
    expect: { poll: { timeout: 10_000 } },
    projects: inLayerOrder([
      { extends: true, test: { name: 'sign-in:browser', root: 'packages/sign-in', include: ['test/**/*.browser.test.ts'], maxWorkers: 1 } },
      {
        extends: true,
        test: { name: 'sign-in:integration', root: 'packages/sign-in', include: ['src/**/*.integration.test.ts', 'test/**/*.integration.test.ts'], testTimeout: 60_000, maxWorkers: 1 },
      },
      {
        extends: true,
        test: {
          name: 'scripts:unit',
          include: ['scripts/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          // Each guardrail lint rule, proven against the real ESLint config.
          name: 'lint:unit',
          include: ['lint/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'sign-in:unit',
          root: 'packages/sign-in',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/*.integration.test.ts', '**/*.browser.test.ts'],
        },
      },
    ]),
  },
});
