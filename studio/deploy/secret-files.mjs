import { mkdirSync, writeFileSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// These files exist only in this container's private, bounded tmpfs.
export function secretFiles(names, environment = process.env, directory = '/tmp/creator-secrets') {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  for (const name of names) {
    const existing = environment[`${name}_FILE`];
    if (existing) {
      if (resolve(existing) !== existing || dirname(existing) !== '/config' || !lstatSync(existing).isFile() || lstatSync(existing).isSymbolicLink()) {
        throw new Error(`Invalid managed secret file: ${name}`);
      }
      const value = readFileSync(existing, 'utf8').trim();
      if (value.length < 32 || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`Invalid managed secret: ${name}`);
      delete environment[name];
      continue;
    }
    const value = environment[name];
    if (typeof value !== 'string' || value.length < 32 || /[\r\n\0]/.test(value)) {
      throw new Error(`Missing or invalid required secret: ${name}`);
    }
    const filename = `${directory}/${name.toLowerCase()}`;
    writeFileSync(filename, value, { mode: 0o600, flag: 'wx' });
    environment[`${name}_FILE`] = filename;
    delete environment[name];
  }
}
