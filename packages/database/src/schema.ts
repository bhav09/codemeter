import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export function getDatabaseDir(): string {
  const homeDir = os.homedir();
  const codemeterDir = path.join(homeDir, '.codemeter');
  
  if (!fs.existsSync(codemeterDir)) {
    fs.mkdirSync(codemeterDir, { recursive: true });
  }
  
  return codemeterDir;
}

export type StoreKind = 'projects' | 'sessions' | 'events' | 'attributions' | 'budgets' | 'sync_state';

export function getStoreFile(kind: StoreKind): string {
  return path.join(getDatabaseDir(), `${kind}.jsonl`);
}

export function getSnapshotFile(kind: StoreKind): string {
  return path.join(getDatabaseDir(), `${kind}.snapshot.json`);
}

export function getDerivedFile(name: string): string {
  return path.join(getDatabaseDir(), `${name}.json`);
}

export function writeJsonDerived(name: string, value: unknown): void {
  const file = getDerivedFile(name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

export function readJsonDerived<T>(name: string): T | null {
  const file = getDerivedFile(name);
  if (!fs.existsSync(file)) return null;
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

export function appendJsonl(kind: StoreKind, record: unknown): void {
  const file = getStoreFile(kind);
  const line = JSON.stringify(record) + '\n';
  // Append is atomic for small writes on POSIX; good enough for cross-IDE MVP.
  fs.appendFileSync(file, line, { encoding: 'utf8' });
}

export function writeJsonSnapshot(kind: StoreKind, snapshot: unknown): void {
  const file = getSnapshotFile(kind);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
  fs.renameSync(tmp, file);
}

export function readJsonl<T>(kind: StoreKind): T[] {
  // Prefer snapshot when present (fast path), otherwise scan JSONL.
  const snapshotFile = getSnapshotFile(kind);
  if (fs.existsSync(snapshotFile)) {
    try {
      const txt = fs.readFileSync(snapshotFile, 'utf8');
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) return parsed as T[];
    } catch {
      // fall through to JSONL scan
    }
  }

  const file = getStoreFile(kind);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const out: T[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore corrupt line
    }
  }
  return out;
}
