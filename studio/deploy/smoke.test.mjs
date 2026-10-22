import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { terminateSmokeContainers, smokeEgressRules, redactDiagnostic, diagnosticTail } from './smoke.mjs';
import { compose } from './compose.mjs';

test('fresh PostgreSQL bootstrap clients and temporary servers share each isolated port and writable default socket', () => {
  const environment = Object.fromEntries(['postiz', 'gateway', 'worker', 'temporal'].map(name =>
    [`CREATOR_IMAGE_${name.toUpperCase()}`, `ghcr.io/kalvisan/ordersmp-creator-studio-${name}@sha256:${'a'.repeat(64)}`]));
  const { services } = compose(environment);
  for (const [name, uid, port] of [['postgres', 18002, 15432], ['temporalpg', 18005, 15433]]) {
    const service = services[name];
    // The official entrypoint clears PGHOST and uses compiled /var/run/postgresql.
    // Alpine resolves /var/run to /run; PGPORT also controls bootstrap psql.
    assert.equal(service.environment.PGPORT, String(port));
    assert.equal(service.command[service.command.indexOf('-p') + 1], String(port));
    assert.ok(service.command.includes('unix_socket_directories=/var/run/postgresql'));
    assert.ok(service.tmpfs.includes(`/run/postgresql:rw,nosuid,nodev,noexec,size=4m,uid=${uid},gid=${uid},mode=0700`));
    assert.ok(service.tmpfs.includes(`/tmp:rw,nosuid,nodev,noexec,size=128m,uid=${uid},gid=${uid},mode=0700`));
    assert.ok(service.command.includes('listen_addresses=127.0.0.1'));
    assert.equal(service.healthcheck.test[service.healthcheck.test.indexOf('-p') + 1], String(port));
    assert.equal(service.read_only, true);
    assert.equal(service.user, `${uid}:${uid}`);
    assert.deepEqual(service.cap_drop, ['ALL']);
  }
});

test('setup diagnostics redact credentials and bound child stderr', () => {
  const token = 'fixture-sensitive-value-0123456789abcdef';
  const raw = `password=short-secret Bearer hidden-bearer postgresql://user:dbpass@127.0.0.1/db ${token}\n` + 'detail\n'.repeat(1000);
  const result = redactDiagnostic(raw, [token]);
  for (const privateValue of ['short-secret', 'hidden-bearer', 'user:dbpass', token]) assert.ok(!result.includes(privateValue));
  assert.ok(result.includes('[redacted]'));
  assert.ok(result.length <= 800);
  assert.ok(result.split('\n').length <= 6);
});

test('failure diagnostics retain the final error after progress output and redact its credentials', () => {
  const token = 'fixture-sensitive-value-0123456789abcdef';
  const result = diagnosticTail('Container creating\n'.repeat(100) +
    `Final startup failure password=short-secret Bearer hidden-bearer ${token}\n`, [token]);
  assert.ok(result.includes('Final startup failure'));
  for (const secret of ['short-secret', 'hidden-bearer', token]) assert.ok(!result.includes(secret));
  assert.ok(result.length <= 800);
  assert.ok(result.split('\n').length <= 6);
});

test('long structured Go error chains retain their final cause without stacks or credentials', () => {
  const raw = JSON.stringify({ level: 'error', msg: 'invoke failed',
    error: 'dependency chain: '.repeat(500) + 'dial tcp 127.0.0.1:15433: connection refused password=short-secret',
    stacktrace: 'irrelevant stack frame\n'.repeat(500) });
  const result = diagnosticTail(raw);
  assert.ok(result.includes('invoke failed'));
  assert.ok(result.includes('connection refused'));
  assert.ok(!result.includes('short-secret'));
  assert.ok(!result.includes('irrelevant stack'));
  assert.ok(result.length <= 800);
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
