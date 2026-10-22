// Run only on a disposable GitHub-hosted Linux runner. Never use production secrets.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose } from './compose.mjs';

const services = ['postiz', 'postgres', 'redis', 'temporal', 'temporalpg', 'gateway', 'worker', 'studio-nginx'];
const custom = ['postiz', 'gateway', 'worker', 'temporal'];
const ports = new Map([[3000, 18001], [3002, 18001], [4007, 18001], [4200, 18001],
  [15432, 18002], [15433, 18005], [16379, 18003], [16080, 18006], [8444, 18008],
  ...[17233, 17234, 17235, 17236, 18233, 17333, 17334, 17335, 17339].map(port => [port, 18004])]);
const generatedSecrets = new Set();
const secret = () => {
  const value = randomBytes(48).toString('hex');
  generatedSecrets.add(value);
  return value;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function redactDiagnostic(value, secrets = generatedSecrets) {
  let text = String(value || '');
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  text = text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/((?:password|secret|token|api[_-]?key)["'\s:=]+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted-value]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .split('\n').slice(0, 6).join('\n');
  return text.length <= 800 ? text : `${text.slice(0, 200)} ... ${text.slice(-595)}`;
}
export function diagnosticTail(value, secrets = generatedSecrets) {
  const lines = String(value || '').trimEnd().split('\n').slice(-6).map(line => {
    try {
      const item = JSON.parse(line);
      if (typeof item.error === 'string') return `${item.level || 'error'}: ${String(item.msg || '')}: ${item.error}`;
    } catch { /* Keep ordinary process diagnostics. */ }
    return line;
  });
  return redactDiagnostic(lines.join('\n'), secrets);
}
function command(executable, args, options = {}) {
  const { combineOutput = false, ...spawnOptions } = options;
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120000,
    maxBuffer: 8 * 1024 * 1024, ...spawnOptions });
  if (result.status !== 0 || result.error) {
    const program = executable === 'sudo' ? args[1] : executable;
    const candidate = args[executable === 'sudo' ? 2 : executable === 'docker' ? 2 : 0];
    const subcommand = /^[a-z][a-z-]*$/.test(candidate || '') ? candidate : undefined;
    const error = new Error(`Command failed: ${program}${subcommand ? ` ${subcommand}` : ''}`);
    error.diagnostic = { executable: program, subcommand, exitCode: result.status,
      timedOut: result.error?.code === 'ETIMEDOUT', stderr: diagnosticTail(result.stderr) };
    throw error;
  }
  return combineOutput ? `${result.stdout || ''}\n${result.stderr || ''}` : result.stdout;
}
function root(args, options) { return command('sudo', ['-n', ...args], options); }
function docker(args, options) { return command('docker', ['--host', 'unix:///var/run/docker.sock', ...args], options); }
function checked(condition, message) { if (!condition) throw new Error(message); }

export function smokeEgressRules(table) {
  checked(/^creatorci[0-9]+_egress$/.test(table), 'Invalid smoke firewall table');
  return `table inet ${table} {\n  chain output {\n    type filter hook output priority -200; policy accept;\n    meta skuid { ${services.map((_, i) => 18001 + i).join(', ')} } oifname != "lo" reject\n  }\n}\n`;
}

export function terminateSmokeContainers(project, { composeDown, dockerCommand }) {
  if (!/^creatorci[0-9]+$/.test(project)) return false;
  try { composeDown(); } catch { /* Verify and recover using the fixed project label. */ }
  try {
    const remaining = () => dockerCommand(['ps', '--all', '--filter', `label=com.docker.compose.project=${project}`,
      '--format', '{{.ID}}']).trim().split(/\s+/).filter(Boolean);
    const ids = remaining();
    checked(ids.every(value => /^[a-f0-9]{12,64}$/.test(value)), 'Invalid smoke cleanup container ID');
    if (ids.length) dockerCommand(['rm', '--force', ...ids]);
    return remaining().length === 0;
  } catch { return false; }
}

export async function smoke(artifactRoot) {
  checked(process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Use a disposable GitHub-hosted Linux runner');
  const directory = await mkdtemp(join(tmpdir(), 'ordersmp-creator-smoke-'));
  const id = `creatorci${process.pid}`;
  const slice = `${id}.slice`, workerSlice = `${id}-worker.slice`;
  const table = `${id}_egress`;
  const definition = join(directory, 'compose.json');
  const report = { services: [], checks: [], outcome: 'failed', stage: 'driver-preflight' };
  let networkAdded = false, firewallAdded = false, slicesAdded = false, deploymentAttempted = false;
  // Production invokes Compose as root so it can read root-owned 0640 env files.
  // Public pinned GHCR images deliberately use anonymous root registry access.
  const dc = args => root(['docker', '--host', 'unix:///var/run/docker.sock', 'compose', '--project-name', id, '--project-directory', directory,
    '--file', definition, ...args], { timeout: 480000 });
  const inspect = () => {
    const ids = dc(['ps', '--all', '--quiet']).trim().split(/\s+/).filter(Boolean);
    return ids.length ? JSON.parse(docker(['inspect', ...ids])) : [];
  };
  try {
    checked(docker(['info', '--format', '{{.CgroupDriver}} {{.CgroupVersion}}']).trim() === 'systemd 2',
      'Smoke requires the production systemd/cgroups-v2 driver');
    report.stage = 'image-artifacts';
    const imageEnv = {};
    for (const target of custom) {
      const digest = (await readFile(join(resolve(artifactRoot), `digest-${target}`, 'image-digest.txt'), 'utf8')).trim();
      checked(/^sha256:[a-f0-9]{64}$/.test(digest), `Invalid ${target} digest artifact`);
      imageEnv[`CREATOR_IMAGE_${target.toUpperCase()}`] = `ghcr.io/kalvisan/ordersmp-creator-studio-${target}@${digest}`;
    }
    const doc = compose(imageEnv);
    doc.name = id;
    for (const [name, spec] of Object.entries(doc.services)) {
      spec.cgroup_parent = name === 'worker' ? workerSlice : slice;
      spec.env_file = [join(directory, 'config', name, 'service.env')];
      for (const mount of spec.volumes) {
        if (mount.source.startsWith('/etc/ordersmp-creator/'))
          mount.source = join(directory, 'config', mount.source.slice('/etc/ordersmp-creator/'.length));
        else if (mount.source.startsWith('/var/lib/ordersmp-creator/'))
          mount.source = join(directory, 'data', mount.source.slice('/var/lib/ordersmp-creator/'.length));
        else throw new Error('Unexpected production bind source');
      }
    }
    report.stage = 'private-config';
    const passwords = { postiz: secret(), temporal: secret(), redis: secret(), jwt: secret(), approval: secret(), worker: secret() };
    const common = { GOOGLE_AUTH_OWNER_EMAIL: 'smoke-owner@example.com' };
    const envs = Object.fromEntries(services.map(name => [name, {}]));
    Object.assign(envs.postiz, common, {
      DATABASE_URL: `postgresql://postiz:${passwords.postiz}@127.0.0.1:15432/postiz`,
      REDIS_URL: `redis://:${passwords.redis}@127.0.0.1:16379/0`, JWT_SECRET: passwords.jwt,
      GOOGLE_AUTH_CLIENT_ID: 'smoke-invalid.apps.googleusercontent.com', GOOGLE_AUTH_CLIENT_SECRET: secret(),
      IS_GENERAL: 'true', DISABLE_REGISTRATION: 'true', EMAIL_PROVIDER: 'empty',
    });
    Object.assign(envs.postgres, { POSTGRES_PASSWORD: passwords.postiz });
    Object.assign(envs.temporalpg, { POSTGRES_PASSWORD: passwords.temporal });
    Object.assign(envs.temporal, { SQL_PASSWORD: passwords.temporal });
    Object.assign(envs.redis, { REDIS_PASSWORD: passwords.redis });
    Object.assign(envs.gateway, common);
    for (const [index, name] of services.entries()) {
      const uid = 18001 + index;
      const config = join(directory, 'config', name), data = join(directory, 'data', name);
      await mkdir(config, { recursive: true, mode: 0o750 });
      await mkdir(data, { recursive: true, mode: 0o700 });
      await writeFile(join(config, 'service.env'), Object.entries(envs[name]).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o640 });
      if (name === 'postiz' || name === 'gateway') await writeFile(join(config, 'approval.key'), passwords.approval, { mode: 0o640 });
      if (name === 'worker' || name === 'gateway') await writeFile(join(config, 'worker.token'), passwords.worker, { mode: 0o640 });
      if (name === 'postiz') await writeFile(join(config, 'nginx.conf'), await readFile(new URL('./postiz-nginx.conf', import.meta.url)), { mode: 0o640 });
      if (name === 'studio-nginx') {
        await writeFile(join(config, 'nginx.conf'), await readFile(new URL('./studio-nginx.conf', import.meta.url)), { mode: 0o640 });
        command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
          '-subj', '/CN=studio.ordersmp.net', '-addext', 'subjectAltName=DNS:studio.ordersmp.net',
          '-keyout', join(config, 'tls.key'), '-out', join(config, 'tls.crt')]);
      }
      root(['chown', '-R', `0:${uid}`, config]);
      root(['chmod', '0750', config]);
      root(['find', config, '-type', 'f', '-exec', 'chmod', '0640', '{}', '+']);
      root(['chown', `${uid}:${uid}`, data]);
    }
    for (const path of ['media/inbox', 'media/renders', 'media/delivery', 'postiz/uploads']) {
      const folder = join(directory, 'data', path);
      root(['mkdir', '--parents', '--', folder]);
      root(['chown', `${path === 'postiz/uploads' ? 18001 : 0}:18009`, folder]);
      root(['chmod', '2770', folder]);
    }
    await writeFile(definition, JSON.stringify(doc), { mode: 0o600 });
    // Pull first. All application UIDs then lose non-loopback network access.
    report.stage = 'image-pull';
    dc(['pull', '--quiet']);
    report.stage = 'private-address';
    const aliases = JSON.parse(root(['ip', '-j', 'address', 'show', 'dev', 'lo']));
    checked(!aliases.some(row => row.addr_info.some(item => item.local === '10.64.64.1')), 'Private smoke address already exists');
    root(['ip', 'address', 'add', '10.64.64.1/32', 'dev', 'lo']); networkAdded = true;
    const rules = smokeEgressRules(table);
    report.stage = 'egress-policy-check';
    root(['nft', '--check', '-f', '-'], { input: rules });
    report.stage = 'egress-policy-install';
    root(['nft', '-f', '-'], { input: rules }); firewallAdded = true;
    report.stage = 'systemd-slices';
    const allow = [...ports.keys()].map(port => `SocketBindAllow=tcp:${port}`).join('\n');
    const unit = `[Slice]\nCPUQuota=200%\nMemoryMax=10G\nMemorySwapMax=0\nTasksMax=2048\nSocketBindDeny=any\n${allow}\nSocketBindAllow=udp:17333-17335\nSocketBindAllow=udp:17339\n`;
    slicesAdded = true;
    root(['tee', `/run/systemd/system/${slice}`], { input: unit });
    root(['tee', `/run/systemd/system/${workerSlice}`], { input: '[Slice]\nCPUQuota=50%\nMemoryMax=2G\nMemorySwapMax=0\nTasksMax=128\n' });
    root(['systemctl', 'daemon-reload']); root(['systemctl', 'start', slice, workerSlice]);
    report.stage = 'container-start';
    deploymentAttempted = true;
    dc(['up', '--detach', '--no-build', '--pull', 'never']);
    report.stage = 'container-readiness';
    const deadline = Date.now() + 360000;
    let rows, applicationReady = false;
    while (Date.now() < deadline) {
      rows = inspect();
      checked(!rows.some(row => ['exited', 'dead'].includes(row.State.Status)), 'A smoke service exited during startup');
      if (rows.length === 8 && rows.every(row => row.State.Running &&
        (!doc.services[row.Config.Labels['com.docker.compose.service']]?.healthcheck || row.State.Health?.Status === 'healthy'))) {
        try {
          const checks = await Promise.all([
            fetch('http://127.0.0.1:3002/health/status', { signal: AbortSignal.timeout(12000) }),
            fetch('http://127.0.0.1:3000/auth/can-register', { signal: AbortSignal.timeout(12000) }),
          ]);
          if (checks.every(response => response.ok)) { applicationReady = true; break; }
        } catch { /* Readiness is retried until the bounded deadline. */ }
      }
      await sleep(2000);
    }
    checked(applicationReady && rows?.length === 8 && rows.every(row => row.State.Running &&
      (!doc.services[row.Config.Labels['com.docker.compose.service']]?.healthcheck || row.State.Health?.Status === 'healthy')), 'Startup health deadline exceeded');
    report.stage = 'runtime-isolation';
    for (const row of rows) {
      const name = row.Config.Labels['com.docker.compose.service'], spec = doc.services[name];
      const memory = /^(\d+)([MG])$/.exec(spec?.mem_limit || '');
      checked(spec && row.Config.User === spec.user && row.HostConfig.ReadonlyRootfs && !row.HostConfig.Privileged &&
        row.HostConfig.CapDrop.includes('ALL') && row.HostConfig.SecurityOpt.some(item => item.startsWith('no-new-privileges')) &&
        row.HostConfig.NetworkMode === 'host' && row.HostConfig.CgroupParent === spec.cgroup_parent &&
        row.HostConfig.MemorySwap === row.HostConfig.Memory && memory &&
        row.HostConfig.Memory === Number(memory[1]) * 1024 ** (memory[2] === 'G' ? 3 : 2) &&
        row.HostConfig.NanoCpus === Math.round(spec.cpus * 1e9) && row.HostConfig.PidsLimit === spec.pids_limit,
      `Runtime isolation mismatch: ${name}`);
      const processGroup = await readFile(`/proc/${row.State.Pid}/cgroup`, 'utf8');
      checked(processGroup.includes(`/${spec.cgroup_parent}/`), `Process escaped expected slice: ${name}`);
      const status = await readFile(`/proc/${row.State.Pid}/status`, 'utf8');
      const uids = /^Uid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/);
      checked(uids?.length === 4 && uids.every(uid => uid === spec.user.split(':')[0]) &&
        /^CapEff:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status),
      `Effective process identity or privileges mismatch: ${name}`);
      for (const mount of spec.volumes) {
        const actual = row.Mounts.find(item => item.Destination === mount.target);
        checked(actual?.Source === mount.source && actual.RW === !mount.read_only, `Runtime mount mismatch: ${name}`);
      }
      report.services.push({ name, running: true, healthy: row.State.Health?.Status || 'functional probe follows', user: row.Config.User });
    }
    const observedTcp = new Set();
    for (const kind of ['tcp', 'tcp6', 'udp', 'udp6']) {
      for (const line of (await readFile(`/proc/net/${kind}`, 'utf8')).trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/), [address, portHex] = fields[1].split(':'), port = parseInt(portHex, 16);
        if (!ports.has(port) || (kind.startsWith('tcp') && fields[3] !== '0A')) continue;
        checked(!kind.endsWith('6') && address === (port === 8444 ? '0140400A' : '0100007F') && Number(fields[7]) === ports.get(port),
          `Unexpected listener address or UID: ${port}/${kind}`);
        if (kind === 'tcp') observedTcp.add(port);
      }
    }
    for (const port of [3000, 3002, 4007, 4200, 15432, 15433, 16379, 16080, 8444, 17233, 17234, 17235, 17236, 18233])
      checked(observedTcp.has(port), `Required loopback listener is missing: ${port}`);
    report.checks.push('eight services started; configured health checks and runtime isolation passed', 'creator TCP/UDP listeners use the required private addresses and UIDs');
    report.stage = 'worker-functional';
    const worker = rows.find(row => row.Config.Labels['com.docker.compose.service'] === 'worker');
    docker(['exec', '--user', '18007:18007', worker.Id, 'python', '-c',
      'import worker,subprocess; subprocess.run(["ffmpeg","-version"],check=True,stdout=subprocess.DEVNULL); assert worker.request("GET") is None']);
    report.checks.push('worker FFmpeg and authenticated private gateway probe passed');
    const cert = join(directory, 'config', 'studio-nginx', 'tls.crt');
    // Root reads the protected test certificate; the runner never prints responses or cookies.
    const request = (path, args = []) => {
      const output = root(['curl', '--silent', '--show-error', '--max-time', '20', '--noproxy', '*',
        '--cacert', cert, '--resolve', 'studio.ordersmp.net:8444:10.64.64.1', '--include',
        ...args, `https://studio.ordersmp.net:8444${path}`]);
      const boundary = output.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
      const index = output.indexOf(boundary), headers = output.slice(0, index), body = output.slice(index + boundary.length);
      return { status: Number(/^HTTP\/\S+ (\d+)/.exec(headers)?.[1]), headers, body };
    };
    report.stage = 'http-auth';
    const portal = request('/creator/');
    assert.equal(portal.status, 303); assert.match(portal.headers, /location: \/auth\/login/i);
    const login = request('/auth/login');
    assert.equal(login.status, 200); assert.match(login.body, /Sign in with Google/);
    assert.equal(request('/api/uploads/smoke.mp4').status, 403);
    assert.equal(request('/uploads/smoke.mp4').status, 401);
    assert.equal(request('/creator/internal/jobs').status, 404);
    assert.equal(request('/creator/api/session', ['--header', 'Cookie: auth=invalid-smoke-session']).status, 401);
    assert.equal(request('/api/auth/google/callback?code=invalid&state=invalid').status, 403);
    assert.equal(request('/api/auth/oauth/GITHUB').status, 403);
    const reset = request('/api/auth/forgot', ['--header', 'Content-Type: application/json',
      '--data', JSON.stringify({ email: 'smoke-owner@example.com' })]);
    assert.equal(reset.status, 200); assert.equal(JSON.parse(reset.body).forgot, false);
    for (const route of ['login', 'register']) {
      const legacy = request(`/api/auth/${route}`, ['--header', 'Content-Type: application/json', '--data',
        JSON.stringify({ provider: 'LOCAL', email: 'smoke-owner@example.com', password: 'smoke-invalid', company: 'Smoke' })]);
      checked([400, 403].includes(legacy.status) && legacy.body.includes('Use Google to sign in'), `Legacy ${route} was not explicitly denied`);
    }
    const start = request('/api/auth/google/start');
    assert.equal(start.status, 200);
    const authorization = new URL(JSON.parse(start.body).url);
    assert.equal(authorization.origin, 'https://accounts.google.com');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('redirect_uri'), 'https://studio.ordersmp.net/api/auth/google/callback');
    const loginCookie = start.headers.split(/\r?\n/).find(line => /^set-cookie: __Host-google-login=/i.test(line));
    checked(loginCookie && /HttpOnly/i.test(loginCookie) && /Secure/i.test(loginCookie) && /SameSite=Lax/i.test(loginCookie) && !/Domain=/i.test(loginCookie), 'Google state cookie protections missing');
    report.checks.push('private uploads, forged sessions, legacy login and invalid Google callback denied', 'portal redirects to Google-only sign-in; state cookie and PKCE present', 'application egress blocked throughout runtime; no live provider calls');
    report.outcome = 'passed';
    report.stage = 'verified';
  } catch (error) {
    // Fixed messages and selected state only. Container output can contain credentials.
    report.failure = error instanceof assert.AssertionError ? 'A smoke HTTP/runtime assertion failed' : redactDiagnostic(error.message);
    if (error.diagnostic) report.commandFailure = error.diagnostic;
    try {
      report.diagnostics = inspect().map(row => {
        const logs = docker(['logs', '--tail', '40', row.Id], { combineOutput: true, timeout: 15000, maxBuffer: 1024 * 1024 });
        return { name: row.Config.Labels['com.docker.compose.service'], status: row.State.Status,
          exitCode: row.State.ExitCode, oomKilled: row.State.OOMKilled, health: row.State.Health?.Status,
          logTail: diagnosticTail(logs),
          categories: ['permission denied', 'Cannot find module', 'Prisma', 'schema', 'Temporal', 'EACCES', 'EADDRINUSE']
            .filter(category => logs.includes(category)) };
      });
    } catch { report.diagnosticStatus = 'Selected container diagnostics unavailable'; }
  } finally {
    let containersStopped = !deploymentAttempted;
    if (deploymentAttempted) {
      containersStopped = terminateSmokeContainers(id, {
        composeDown: () => dc(['down', '--volumes', '--remove-orphans', '--timeout', '20']), dockerCommand: docker,
      });
    }
    if (containersStopped) {
      if (firewallAdded) try { root(['nft', 'delete', 'table', 'inet', table]); } catch { report.cleanupWarning = true; }
      if (networkAdded) try { root(['ip', 'address', 'del', '10.64.64.1/32', 'dev', 'lo']); } catch { report.cleanupWarning = true; }
      if (slicesAdded) {
        try {
          root(['systemctl', 'stop', workerSlice, slice]);
          root(['rm', '--force', '--', `/run/systemd/system/${slice}`, `/run/systemd/system/${workerSlice}`]);
          root(['systemctl', 'daemon-reload']);
        } catch { report.cleanupWarning = true; }
      }
      checked(directory.startsWith(`${tmpdir()}/ordersmp-creator-smoke-`) && directory !== tmpdir(), 'Unsafe smoke cleanup path');
      try { root(['rm', '--recursive', '--force', '--', directory]); } catch { report.cleanupWarning = true; }
    } else {
      report.cleanupWarning = true;
      report.cleanupRetainedProtection = 'Container termination was not confirmed; egress block, slices and private bind data retained until disposable runner destruction';
    }
    if (report.cleanupWarning) report.outcome = 'failed';
    await writeFile('creator-smoke-report.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
  if (report.outcome !== 'passed' || report.cleanupWarning) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await smoke(process.argv[2] || 'image-digests');
