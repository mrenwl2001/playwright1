/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect, countTimes, stripAnsi } from './playwright-test-fixtures';

test('should handle fixture timeout', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        timeout: async ({}, runTest) => {
          await runTest();
          await new Promise(f => setTimeout(f, 100000));
        }
      });

      test('fixture timeout', async ({timeout}) => {
        expect(1).toBe(1);
      });

      test('failing fixture timeout', async ({timeout}) => {
        expect(1).toBe(2);
      });
    `
  }, { timeout: 500 });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Test timeout of 500ms exceeded while tearing down "timeout".');
  expect(result.failed).toBe(2);
});

test('should handle worker fixture timeout', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        timeout: [async ({}, runTest) => {
          await runTest();
          await new Promise(f => setTimeout(f, 100000));
        }, { scope: 'worker' }]
      });

      test('fails', async ({timeout}) => {
      });
    `
  }, { timeout: 500 });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Worker teardown timeout of 500ms exceeded while tearing down "timeout".');
});

test('should handle worker fixture error', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        failure: [async ({}, runTest) => {
          throw new Error('Worker failed');
        }, { scope: 'worker' }]
      });

      test('fails', async ({failure}) => {
      });
    `
  });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.output).toContain('Worker failed');
});

test('should handle worker tear down fixture error', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        failure: [async ({}, runTest) => {
          await runTest();
          throw new Error('Worker failed');
        }, { scope: 'worker' }]
      });

      test('pass', async ({failure}) => {
        expect(true).toBe(true);
      });
    `
  });
  expect(result.report.errors[0].message).toContain('Worker failed');
  expect(result.exitCode).toBe(1);
});

test('should handle worker tear down fixture error after failed test', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        failure: [async ({}, runTest) => {
          await runTest();
          throw new Error('Worker failed');
        }, { scope: 'worker' }]
      });

      test('timeout', async ({failure}) => {
        await new Promise(f => setTimeout(f, 2000));
      });
    `
  }, { timeout: 1000 });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Test timeout of 1000ms exceeded.');
  expect(result.output).toContain('Worker failed');
});

test('should throw when using non-defined super worker fixture', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        foo: [async ({ foo }, runTest) => {
          await runTest();
        }, { scope: 'worker' }]
      });

      test('works', async ({foo}) => {});
    `
  });
  expect(result.output).toContain(`Fixture "foo" references itself, but does not have a base implementation.`);
  expect(result.output).toContain('a.spec.ts:5');
  expect(stripAnsi(result.output)).toContain('const test = pwt.test.extend');
  expect(result.exitCode).toBe(1);
});

test('should throw when defining test fixture with the same name as a worker fixture', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'e.spec.ts': `
      const test1 = pwt.test.extend({
        foo: [async ({}, runTest) => {
          await runTest();
        }, { scope: 'worker' }]
      });
      const test2 = test1.extend({
        foo: [async ({}, runTest) => {
          await runTest();
        }, { scope: 'test' }]
      });

      test2('works', async ({foo}) => {});
    `,
  });
  expect(result.output).toContain(`Fixture "foo" has already been registered as a { scope: 'worker' } fixture defined in e.spec.ts:5:30.`);
  expect(result.output).toContain(`e.spec.ts:10`);
  expect(stripAnsi(result.output)).toContain('const test2 = test1.extend');
  expect(result.exitCode).toBe(1);
});

test('should throw when defining worker fixture with the same name as a test fixture', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'e.spec.ts': `
      const test1 = pwt.test.extend({
        foo: [async ({}, runTest) => {
          await runTest();
        }, { scope: 'test' }]
      });
      const test2 = test1.extend({
        foo: [async ({}, runTest) => {
          await runTest();
        }, { scope: 'worker' }]
      });

      test2('works', async ({foo}) => {});
    `,
  });
  expect(result.output).toContain(`Fixture "foo" has already been registered as a { scope: 'test' } fixture defined in e.spec.ts:5:30.`);
  expect(result.output).toContain(`e.spec.ts:10`);
  expect(stripAnsi(result.output)).toContain('const test2 = test1.extend');
  expect(result.exitCode).toBe(1);
});

test('should throw when worker fixture depends on a test fixture', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'f.spec.ts': `
      const test = pwt.test.extend({
        foo: [async ({}, runTest) => {
          await runTest();
        }, { scope: 'test' }],

        bar: [async ({ foo }, runTest) => {
          await runTest();
        }, { scope: 'worker' }],
      });

      test('works', async ({bar}) => {});
    `,
  });
  expect(result.output).toContain('worker fixture "bar" cannot depend on a test fixture "foo" defined in f.spec.ts:5:29.');
  expect(result.exitCode).toBe(1);
});

test('should define the same fixture in two files', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test1 = pwt.test.extend({
        foo: [async ({}, runTest) => {
          await runTest();
        }, { scope: 'worker' }]
      });

      test1('works', async ({foo}) => {});
    `,
    'b.spec.ts': `
      const test2 = pwt.test.extend({
        foo: [async ({}, runTest) => {
          await runTest();
        }, { scope: 'worker' }]
      });

      test2('works', async ({foo}) => {});
    `,
  });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
});

test('should detect fixture dependency cycle', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'x.spec.ts': `
      const test = pwt.test.extend({
        good1: async ({}, run) => run(),
        foo: async ({bar}, run) => run(),
        bar: async ({baz}, run) => run(),
        good2: async ({good1}, run) => run(),
        baz: async ({qux}, run) => run(),
        qux: async ({foo}, run) => run(),
      });

      test('works', async ({foo}) => {});
    `,
  });
  expect(result.output).toContain('Fixtures "bar" -> "baz" -> "qux" -> "foo" -> "bar" form a dependency cycle:');
  expect(result.output).toContain('x.spec.ts:5:29 -> x.spec.ts:5:29 -> x.spec.ts:5:29 -> x.spec.ts:5:29');
  expect(result.exitCode).toBe(1);
});

test('should not reuse fixtures from one file in another one', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({ foo: ({}, run) => run() });
      test('test1', async ({}) => {});
    `,
    'b.spec.ts': `
      const test = pwt.test;
      test('test1', async ({}) => {});
      test('test2', async ({foo}) => {});
    `,
  });
  expect(result.output).toContain('Test has unknown parameter "foo".');
  expect(result.output).toContain('b.spec.ts:7');
  expect(stripAnsi(result.output)).toContain(`test('test2', async ({foo}) => {})`);
});

test('should throw for cycle in two overrides', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.js': `
      const test1 = pwt.test.extend({
        foo: async ({}, run) => await run('foo'),
        bar: async ({}, run) => await run('bar'),
      });
      const test2 = test1.extend({
        foo: async ({ foo, bar }, run) => await run(foo + '-' + bar),
      });
      const test3 = test2.extend({
        bar: async ({ bar, foo }, run) => await run(bar + '-' + foo),
      });

      test3('test', async ({foo, bar}) => {
        expect(1).toBe(1);
      });
    `,
  });
  expect(result.output).toContain('Fixtures "bar" -> "foo" -> "bar" form a dependency cycle:');
  expect(result.output).toContain('a.test.js:12:27 -> a.test.js:9:27');
});

test('should throw when overridden worker fixture depends on a test fixture', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'f.spec.ts': `
      const test1 = pwt.test.extend({
        foo: async ({}, run) => await run('foo'),
        bar: [ async ({}, run) => await run('bar'), { scope: 'worker' } ],
      });
      const test2 = test1.extend({
        bar: async ({ foo }, run) => await run(),
      });

      test2('works', async ({bar}) => {});
    `,
  });
  expect(result.output).toContain('worker fixture "bar" cannot depend on a test fixture "foo" defined in f.spec.ts:5:30.');
  expect(result.output).toContain('f.spec.ts:9');
  expect(result.exitCode).toBe(1);
});

test('should throw for unknown fixture parameter', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'f.spec.ts': `
      const test = pwt.test.extend({
        foo: async ({ bar }, run) => await run('foo'),
      });

      test('works', async ({ foo }) => {});
    `,
  });
  expect(result.output).toContain('Fixture "foo" has unknown parameter "bar".');
  expect(result.output).toContain('f.spec.ts:5');
  expect(stripAnsi(result.output)).toContain('const test = pwt.test.extend');
  expect(result.exitCode).toBe(1);
});

test('should throw when calling runTest twice', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'f.spec.ts': `
      const test = pwt.test.extend({
        foo: async ({}, run) => {
          await run();
          await run();
        }
      });

      test('works', async ({foo}) => {});
    `,
  });
  expect(result.results[0].error.message).toBe('Cannot provide fixture value for the second time');
  expect(result.exitCode).toBe(1);
});

test('should print nice error message for problematic fixtures', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'x.spec.ts': `
      const test = pwt.test.extend({
        bad: [ undefined, { get scope() { throw new Error('oh my!') } } ],
      });
      test('works', async ({foo}) => {});
    `,
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('oh my!');
  expect(result.output).toContain('x.spec.ts:6:49');
});

test('should exit with timeout when fixture causes an exception in the test', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        throwAfterTimeout: async ({}, use) => {
          let callback;
          const promise = new Promise((f, r) => callback = r);
          await use(promise);
          callback(new Error('BAD'));
        },
      });
      test('times out and throws', async ({ throwAfterTimeout }) => {
        await throwAfterTimeout;
      });
    `,
  }, { timeout: 500 });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.output).toContain('Test timeout of 500ms exceeded.');
});

test('should error for unsupported scope', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        failure: [async ({}, use) => {
          await use();
        }, { scope: 'foo' }]
      });
      test('skipped', async ({failure}) => {
      });
    `
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`Fixture "failure" has unknown { scope: 'foo' }`);
});

test('should give enough time for fixture teardown', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        fixture: async ({ }, use) => {
          await use();
          console.log('\\n%%teardown start');
          await new Promise(f => setTimeout(f, 800));
          console.log('\\n%%teardown finished');
        },
      });
      test('fast enough but close', async ({ fixture }) => {
        test.setTimeout(1000);
        await new Promise(f => setTimeout(f, 800));
      });
    `,
  });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.output).toContain('Test timeout of 1000ms exceeded while tearing down "fixture".');
  expect(result.output.split('\n').filter(line => line.startsWith('%%'))).toEqual([
    '%%teardown start',
    '%%teardown finished',
  ]);
});

test('should not teardown when setup times out', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        fixture: async ({ }, use) => {
          await new Promise(f => setTimeout(f, 1500));
          await use();
          console.log('\\n%%teardown');
        },
      });
      test('fast enough but close', async ({ fixture }) => {
      });
    `,
  }, { timeout: 1000 });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.output).toContain('Test timeout of 1000ms exceeded while setting up "fixture".');
  expect(result.output.split('\n').filter(line => line.startsWith('%%'))).toEqual([
  ]);
});

test('should not report fixture teardown error twice', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        fixture: async ({ }, use) => {
          await use();
          throw new Error('Oh my error');
        },
      });
      test('good', async ({ fixture }) => {
      });
    `,
  }, { reporter: 'list' });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.output).toContain('Error: Oh my error');
  expect(stripAnsi(result.output)).toContain(`throw new Error('Oh my error')`);
  expect(countTimes(stripAnsi(result.output), 'Oh my error')).toBe(2);
});

test('should not report fixture teardown timeout twice', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        fixture: async ({ }, use) => {
          await use();
          await new Promise(() => {});
        },
      });
      test('good', async ({ fixture }) => {
      });
    `,
  }, { reporter: 'list', timeout: 1000 });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.output).toContain('Test timeout of 1000ms exceeded while tearing down "fixture".');
  expect(stripAnsi(result.output)).not.toContain('pwt.test.extend'); // Should not point to the location.
  // TODO: this should be "not.toContain" actually.
  expect(result.output).toContain('Worker teardown timeout of 1000ms exceeded while tearing down "fixture".');
});

test('should handle fixture teardown error after test timeout and continue', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        fixture: async ({ }, use) => {
          await use();
          throw new Error('Oh my error');
        },
      });
      test('bad', async ({ fixture }) => {
        test.setTimeout(100);
        await new Promise(f => setTimeout(f, 500));
      });
      test('good', async ({}) => {
      });
    `,
  }, { reporter: 'list', workers: '1' });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.passed).toBe(1);
  expect(result.output).toContain('Test timeout of 100ms exceeded.');
  expect(result.output).toContain('Error: Oh my error');
});

test('should report worker fixture teardown with debug info', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        fixture: [ async ({ }, use) => {
          await use();
          await new Promise(() => {});
        }, { scope: 'worker' } ],
      });
      for (let i = 0; i < 20; i++)
        test('good' + i, async ({ fixture }) => {});
    `,
  }, { reporter: 'list', timeout: 1000 });
  expect(result.exitCode).toBe(1);
  expect(result.passed).toBe(20);
  expect(stripAnsi(result.output)).toContain([
    'Worker teardown timeout of 1000ms exceeded while tearing down "fixture".',
    '',
    'Failed worker ran 20 tests, last 10 tests were:',
    'a.spec.ts:12:9 › good10',
    'a.spec.ts:12:9 › good11',
    'a.spec.ts:12:9 › good12',
    'a.spec.ts:12:9 › good13',
    'a.spec.ts:12:9 › good14',
    'a.spec.ts:12:9 › good15',
    'a.spec.ts:12:9 › good16',
    'a.spec.ts:12:9 › good17',
    'a.spec.ts:12:9 › good18',
    'a.spec.ts:12:9 › good19',
  ].join('\n'));
});

test('should not run user fn when require fixture has failed', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.spec.ts': `
      const test = pwt.test.extend({
        foo: [ async ({ }, use) => {
          console.log('\\n%%foo');
          throw new Error('A test error!');
          await use();
        }, { scope: 'test' } ],
        bar: [ async ({ foo }, use) => {
          console.log('\\n%%bar-' + foo);
          await use();
        }, { scope: 'test' } ],
      });

      test.skip(({ foo }) => {
        console.log('\\n%%skip-' + foo);
        return true;
      });

      test.beforeEach(({ foo }) => {
        console.log('\\n%%beforeEach1-' + foo);
      });

      test.beforeEach(({ foo }) => {
        console.log('\\n%%beforeEach2-' + foo);
      });

      test.beforeEach(({ bar }) => {
        console.log('\\n%%beforeEach3-' + bar);
      });

      test.afterEach(({ foo }) => {
        console.log('\\n%%afterEach1-' + foo);
      });

      test.afterEach(({ bar }) => {
        console.log('\\n%%afterEach2-' + bar);
      });

      test('should not run', async ({ bar }) => {
        console.log('\\n%%test-' + bar);
      });
    `,
  });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.output.split('\n').filter(line => line.startsWith('%%'))).toEqual([
    '%%foo',
  ]);
});

test('should provide helpful error message when digests do not match', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'helper.ts': `
      export const test = pwt.test.extend({
        foo: [ async ({}, use) => use(), { scope: 'worker' } ],
      });

      test.use({ foo: 'foo' });
    `,
    'a.spec.ts': `
      import { test } from './helper';

      test('test-a', ({ foo }) => {
        expect(foo).toBe('foo');
      });
    `,
    'b.spec.ts': `
      import { test } from './helper';

      test('test-b', ({ foo }) => {
        expect(foo).toBe('foo');
      });
    `,
    'c.spec.ts': `
      import { test } from './helper';

      test('test-c', ({ foo }) => {
        expect(foo).toBe('foo');
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(stripAnsi(result.output)).toContain('Playwright detected inconsistent test.use() options.');
});
