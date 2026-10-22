import { spawn } from 'node:child_process';
import { secretFiles } from './secret-files.mjs';

process.umask(0o007);
secretFiles(['CREATOR_PUBLISH_APPROVAL_SECRET', 'CREATOR_WORKER_TOKEN']);
const child = spawn(process.execPath, ['/app/studio/portal/server.mjs'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Creator gateway could not start'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
