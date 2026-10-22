import test from 'node:test';
import assert from 'node:assert/strict';
import { terminateSmokeContainers } from './smoke.mjs';

test('failed compose teardown recovers only the fixed smoke project and verifies termination', () => {
  const calls = [];
  let running = true;
  const stopped = terminateSmokeContainers('creatorci123', {
    composeDown() { calls.push('compose-down'); throw new Error('daemon transient'); },
    dockerCommand(args) {
      calls.push(args);
      if (args[0] === 'ps') return running ? 'abcdef123456\n' : '';
      assert.deepEqual(args, ['rm', '--force', 'abcdef123456']);
      running = false;
      return '';
    },
  });
  assert.equal(stopped, true);
  assert.equal(calls.filter(args => Array.isArray(args) && args[0] === 'ps').length, 2);
  for (const args of calls.filter(args => Array.isArray(args) && args[0] === 'ps'))
    assert.ok(args.includes('label=com.docker.compose.project=creatorci123'));
});

for (const mode of ['query failure', 'invalid ID', 'remove failure', 'survivor']) {
  test(`cleanup retains protection when termination is uncertain: ${mode}`, () => {
    let removes = 0;
    const stopped = terminateSmokeContainers('creatorci123', {
      composeDown() {},
      dockerCommand(args) {
        if (args[0] === 'ps') {
          if (mode === 'query failure') throw new Error('unavailable');
          return mode === 'invalid ID' ? 'unrelated-container-name' : 'abcdef123456';
        }
        removes++;
        if (mode === 'remove failure') throw new Error('unavailable');
        return '';
      },
    });
    assert.equal(stopped, false);
    assert.equal(removes, ['remove failure', 'survivor'].includes(mode) ? 1 : 0);
  });
}

test('cleanup refuses production project identities before any command', () => {
  assert.equal(terminateSmokeContainers('ordersmp-creator', {
    composeDown() { assert.fail('production mutation'); },
    dockerCommand() { assert.fail('production mutation'); },
  }), false);
});
