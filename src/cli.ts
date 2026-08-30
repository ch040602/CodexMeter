import os from 'node:os';
import path from 'node:path';
import { LocalUsageScanner } from './scanner';

async function main(): Promise<void> {
  const roots = ['sessions', 'archived_sessions'].map(name => path.join(os.homedir(), '.codex', name));
  const snapshot = await new LocalUsageScanner(roots).scan(80);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
