import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { secretFiles } from './secret-files.mjs';
import { Connection } from '@temporalio/client';

process.umask(0o007);
if (process.env.GOOGLE_ONLY_AUTH !== 'true') throw new Error('Google-only authentication is required');
if (process.env.FRONTEND_URL !== 'https://studio.ordersmp.net') throw new Error('Unexpected Studio origin');
secretFiles(['CREATOR_PUBLISH_APPROVAL_SECRET']);
mkdirSync('/tmp/nginx', { recursive: true });
mkdirSync('/tmp/next-cache', { recursive: true });
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 20000);
  timer.unref();
  if (!children.size) process.exit(code);
  process.exitCode = code;
}
function run(executable, args, cwd = '/app', bootstrap = false) {
  const child = spawn(executable, args, { cwd, stdio: 'inherit', env: process.env });
  children.add(child);
  return new Promise((resolve, reject) => {
    child.once('error', () => { children.delete(child); reject(new Error('Service could not start')); stop(1); });
    child.once('exit', (code) => {
      children.delete(child);
      if (bootstrap && code === 0) return resolve();
      if (!stopping) stop(code || 1);
      if (stopping && !children.size) process.exit(process.exitCode || code || 0);
      if (bootstrap) reject(new Error('Schema preparation failed'));
    });
  });
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
// Refuse destructive schema changes. A fresh database is initialised once.
await run('/app/node_modules/.bin/prisma', ['db', 'push', '--skip-generate', '--schema',
  '/app/libraries/nestjs-libraries/src/database/prisma/schema.prisma'], '/app', true);
const connection = await Connection.connect({ address: '127.0.0.1:17233' });
const namespace = process.env.TEMPORAL_NAMESPACE || 'ordersmp';
try {
  await connection.workflowService.describeNamespace({ namespace });
} catch (error) {
  if (error.code !== 5) throw new Error('Temporal namespace check failed');
  await connection.workflowService.registerNamespace({ namespace,
    workflowExecutionRetentionPeriod: { seconds: 7 * 86400 },
    description: 'OrderSMP reviewed publishing jobs' });
} finally { await connection.close(); }
run('nginx', ['-c', '/config/nginx.conf', '-g', 'daemon off;']).catch(() => stop(1));
run('node', ['--experimental-require-module', './dist/apps/backend/src/main.js'], '/app/apps/backend').catch(() => stop(1));
run('node', ['--experimental-require-module', './dist/apps/orchestrator/src/main.js'], '/app/apps/orchestrator').catch(() => stop(1));
run('node', ['/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '4200'], '/app/apps/frontend').catch(() => stop(1));
