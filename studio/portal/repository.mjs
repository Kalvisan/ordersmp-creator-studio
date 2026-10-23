import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const collections = [
  'sources',
  'jobs',
  'drafts',
  'permissions',
  'approvals',
  'deliveries',
];
export class PortalRepository {
  constructor(
    filename,
    { maxBytes = 16 * 1024 * 1024, maxRecords = 5000 } = {}
  ) {
    this.filename = filename;
    this.maxBytes = maxBytes;
    this.maxRecords = maxRecords;
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.state = Object.fromEntries(collections.map((name) => [name, {}]));
    this.state.schema = 1;
    if (existsSync(filename)) {
      if (statSync(filename).size > maxBytes)
        throw new Error('Portal registry is too large');
      this.state = JSON.parse(readFileSync(filename, 'utf8'));
      this.validate(this.state);
    }
  }
  validate(state) {
    if (state.schema !== 1) throw new Error('Unsupported portal registry');
    for (const name of collections) {
      if (
        !state[name] ||
        typeof state[name] !== 'object' ||
        Array.isArray(state[name]) ||
        Object.keys(state[name]).length > this.maxRecords
      )
        throw new Error('Portal registry limit reached');
    }
  }
  collection(name) {
    if (!collections.includes(name))
      throw new Error('Unknown portal collection');
    return this.state[name];
  }
  read(name, id) {
    return structuredClone(
      Object.hasOwn(this.collection(name), id)
        ? this.collection(name)[id]
        : null
    );
  }
  list(name, predicate = () => true) {
    return structuredClone(
      Object.values(this.collection(name)).filter(predicate)
    );
  }
  put(name, id, record, expectedVersion) {
    this.collection(name);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(id))
      throw new Error('Invalid record ID');
    return this.transaction((state) => {
      const old = Object.hasOwn(state[name], id) ? state[name][id] : null;
      if ((old?.version || 0) !== expectedVersion)
        throw Object.assign(
          new Error('This item changed. Refresh and try again.'),
          { status: 409 }
        );
      const saved = {
        ...structuredClone(record),
        id,
        version: (old?.version || 0) + 1,
      };
      state[name][id] = saved;
      return saved;
    });
  }
  transaction(mutator) {
    const next = structuredClone(this.state);
    const result = mutator(next);
    if (result?.then)
      throw new Error('Registry transactions must be synchronous');
    this.validate(next);
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > this.maxBytes)
      throw Object.assign(new Error('Portal registry limit reached'), {
        status: 507,
      });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.filename);
    this.state = next;
    return structuredClone(result);
  }
}
