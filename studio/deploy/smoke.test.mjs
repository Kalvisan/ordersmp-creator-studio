import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { terminateSmokeContainers, smokeEgressRules, redactDiagnostic } from './smoke.mjs';

test('setup diagnostics redact credentials and bound child stderr', () => {
  const token = 'fixture-sensitive-value-0123456789abcdef';
  const raw = `password=short-secret Bearer hidden-bearer postgresql://user:dbpass@127.0.0.1/db ${token}\n` + 'detail\n'.repeat(1000);
  const result = redactDiagnostic(raw, [token]);
  for (const privateValue of ['short-secret', 'hidden-bearer', 'user:dbpass', token]) assert.ok(!result.includes(privateValue));
  assert.ok(result.includes('[redacted]'));
  assert.ok(result.length <= 800);
  assert.ok(result.split('\n').length <= 6);
});

test('generated smoke firewall parses in an isolated Linux network namespace', { skip: process.platform !== 'linux' }, () => {
  const result = spawnSync('sudo', ['-n', 'unshare', '--net', 'nft', '--check', '--file', '-'], {
    input: smokeEgressRules('creatorci123_egress'), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, redactDiagnostic(result.stderr));
});

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
