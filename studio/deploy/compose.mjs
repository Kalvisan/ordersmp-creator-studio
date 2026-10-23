import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const images = {
  postgres: 'postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb',
  redis: 'redis:7.2-alpine@sha256:f8548b29a1f1cb358b5fcfec1e0126beab57ad15776c1e87623f865579f16c5a',
  nginx: 'nginx:stable-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951',
};
const config = name => `/etc/ordersmp-creator/${name}`;
const data = name => `/var/lib/ordersmp-creator/${name}`;
const mount = (source, target, readOnly = false) => ({ type: 'bind', source, target,
  read_only: readOnly, bind: { create_host_path: false } });
function base(name, uid, memory, cpus, pids, image, shared = false) {
  return { image, user: `${uid}:${uid}`, ...(shared ? { group_add: ['18009'] } : {}),
    network_mode: 'host', userns_mode: 'host', read_only: true, cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'], mem_limit: memory, memswap_limit: memory,
    cpus, pids_limit: pids, cgroup_parent: name === 'worker' ? 'creators-worker.slice' : 'creators.slice',
    init: true, restart: 'no', stop_grace_period: '60s',
    tmpfs: [`/tmp:rw,nosuid,nodev,noexec,size=128m,uid=${uid},gid=${uid},mode=0700`],
    env_file: [config(name) + '/service.env'],
    logging: { driver: 'local', options: { 'max-size': '5m', 'max-file': '3' } },
    volumes: [mount(data(name), '/data'), mount(config(name), '/config', true)] };
}
const health = command => ({ test: command, interval: '15s', timeout: '5s', retries: 8, start_period: '120s' });
const healthy = names => Object.fromEntries(names.map(name => [name, { condition: 'service_healthy' }]));

export function compose(environment = process.env) {
  const custom = {};
  for (const target of ['postiz', 'gateway', 'worker', 'temporal']) {
    const reference = environment[`CREATOR_IMAGE_${target.toUpperCase()}`];
    if (!/^ghcr\.io\/kalvisan\/ordersmp-creator-studio-[a-z]+@sha256:[a-f0-9]{64}$/.test(reference || '')) {
      throw new Error(`Set CREATOR_IMAGE_${target.toUpperCase()} to the reviewed GHCR image digest`);
    }
    if (!reference.startsWith(`ghcr.io/kalvisan/ordersmp-creator-studio-${target}@`)) throw new Error('Image target mismatch');
    custom[target] = reference;
  }
  const services = {};
  services.postiz = { ...base('postiz', 18001, '4G', 1, 512, custom.postiz, true),
    environment: { GOOGLE_ONLY_AUTH: 'true', FRONTEND_URL: 'https://studio.ordersmp.net', MAIN_URL: 'https://studio.ordersmp.net',
      NEXT_PUBLIC_BACKEND_URL: 'https://studio.ordersmp.net/api', BACKEND_INTERNAL_URL: 'http://127.0.0.1:3000',
      GOOGLE_AUTH_CALLBACK_URL: 'https://studio.ordersmp.net/api/auth/google/callback',
      TEMPORAL_ADDRESS: '127.0.0.1:17233', TEMPORAL_NAMESPACE: 'ordersmp',
      PORT: '3000', ORCHESTRATOR_PORT: '3002', STORAGE_PROVIDER: 'local',
      CREATOR_PUBLISH_APPROVAL_SECRET_FILE: '/config/approval.key',
      UPLOAD_DIRECTORY: '/data/uploads', NEXT_PUBLIC_UPLOAD_DIRECTORY: '/uploads',
      NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY: '/uploads', NX_DAEMON: 'false', NEXT_TELEMETRY_DISABLED: '1' },
    depends_on: healthy(['postgres', 'redis', 'temporal']),
    healthcheck: health(['CMD', 'node', '-e', "fetch('http://127.0.0.1:4007/auth/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]) };
  services.postiz.volumes.push(mount(data('media/delivery'), '/media/delivery', true));
  const pg = (name, uid, port, user, db) => ({ ...base(name, uid, '512M', 0.1, 128, images.postgres),
    tmpfs: [`/tmp:rw,nosuid,nodev,noexec,size=128m,uid=${uid},gid=${uid},mode=0700`,
      `/run/postgresql:rw,nosuid,nodev,noexec,size=4m,uid=${uid},gid=${uid},mode=0700`],
    environment: { PGDATA: '/var/lib/postgresql/data/pgdata', POSTGRES_USER: user, POSTGRES_DB: db, PGPORT: String(port),
      POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256 --auth-local=trust', POSTGRES_HOST_AUTH_METHOD: 'scram-sha-256' },
    command: ['postgres', '-c', 'listen_addresses=127.0.0.1', '-p', String(port),
      '-c', 'unix_socket_directories=/var/run/postgresql', '-c', 'shared_buffers=128MB',
      '-c', 'max_connections=80', '-c', 'password_encryption=scram-sha-256'],
    healthcheck: health(['CMD', 'pg_isready', '-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', db]) });
  services.postgres = pg('postgres', 18002, 15432, 'postiz', 'postiz');
  services.postgres.volumes[0].target = '/var/lib/postgresql/data';
  // POSTGRES_PASSWORD is supplied through each database's own protected env file.
  services.redis = { ...base('redis', 18003, '384M', 0.05, 64, images.redis),
    entrypoint: ['/bin/sh', '-euc'], command: [
      'case "$REDIS_PASSWORD" in *[!0-9a-f]*|"") exit 1;; esac; [ "${#REDIS_PASSWORD}" -ge 64 ]; umask 077; printf "bind 127.0.0.1\\nport 16379\\nprotected-mode yes\\nrequirepass %s\\ndir /data\\nappendonly yes\\nmaxmemory 192mb\\nmaxmemory-policy noeviction\\n" "$REDIS_PASSWORD" > /tmp/redis.conf; unset REDIS_PASSWORD; exec redis-server /tmp/redis.conf'.replaceAll('$', () => '$$') ],
    healthcheck: health(['CMD-SHELL', 'REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli -h 127.0.0.1 -p 16379 ping | grep -qx PONG']) };
  services.temporal = { ...base('temporal', 18004, '768M', 0.15, 128, custom.temporal),
    // Go's pure-Go user lookup needs these for an isolated UID absent from passwd.
    environment: { USER: 'creator-temporal', HOME: '/tmp' },
    depends_on: healthy(['temporalpg']),
    healthcheck: health(['CMD-SHELL', 'test -f /tmp/creator-temporal-ready && temporal --address 127.0.0.1:17233 operator cluster health >/dev/null 2>&1']) };
  services.temporalpg = pg('temporalpg', 18005, 15433, 'temporal', 'postgres');
  services.temporalpg.volumes[0].target = '/var/lib/postgresql/data';
  services.gateway = { ...base('gateway', 18006, '512M', 0.05, 128, custom.gateway, true),
    environment: { GOOGLE_ONLY_AUTH: 'true', FRONTEND_URL: 'https://studio.ordersmp.net', CREATOR_MEDIA_ROOT: '/media',
      CREATOR_PUBLISH_APPROVAL_SECRET_FILE: '/config/approval.key', CREATOR_WORKER_TOKEN_FILE: '/config/worker.token',
      CREATOR_REGISTRY_FILE: '/data/portal.json', CREATOR_PUBLIC_MEDIA_URL: 'https://ordersmp.net/creator-media/',
      CREATOR_POSTIZ_UPLOAD_ROOT: '/postiz-uploads' },
    depends_on: healthy(['postiz']), healthcheck: health(['CMD', 'node', '-e',
      "fetch('http://127.0.0.1:16080/creator/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]) };
  services.gateway.volumes.push(mount(data('media/inbox'), '/media/inbox'),
    mount(data('media/renders'), '/media/renders', true), mount(data('media/delivery'), '/media/delivery'),
    mount(data('postiz/uploads'), '/postiz-uploads', true));
  services.worker = { ...base('worker', 18007, '2G', 0.5, 128, custom.worker, true),
    environment: { CREATOR_INBOX: '/media/inbox', CREATOR_RENDERS: '/media/renders', OMP_NUM_THREADS: '1',
      CREATOR_WORKER_TOKEN_FILE: '/config/worker.token' },
    depends_on: healthy(['gateway']) };
  services.worker.volumes.push(mount(data('media/inbox'), '/media/inbox', true), mount(data('media/renders'), '/media/renders'));
  services['studio-nginx'] = { ...base('studio-nginx', 18008, '128M', 0.05, 64, images.nginx, true),
    entrypoint: ['nginx'], command: ['-c', '/config/nginx.conf', '-g', 'daemon off;'],
    healthcheck: health(['CMD', 'wget', '-q', '-O', '/dev/null', '--header', 'Host: studio.ordersmp.net', 'http://127.0.0.1:8444/auth/login']),
    depends_on: healthy(['postiz', 'gateway']) };
  services['studio-nginx'].volumes.push(mount(data('media/delivery'), '/media/delivery', true));
  return { name: 'ordersmp-creator', services };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] || 'studio/deploy/compose.json';
  writeFileSync(target, JSON.stringify(compose(), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write('Creator definition rendered with immutable image references. No service was started.\n');
}
