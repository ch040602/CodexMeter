import os from 'node:os';
import path from 'node:path';
import { CodexStatusClient } from './codexStatus';
import { LocalUsageScanner } from './scanner';

async function main(): Promise<void> {
  const roots = ['sessions', 'archived_sessions'].map(name => path.join(os.homedir(), '.codex', name));
  const status = new CodexStatusClient();
  try {
    const accountRateLimit = await status.readWeeklyLimit();
    const snapshot = await new LocalUsageScanner(roots).scan(80, Date.now(), accountRateLimit);
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } finally {
    status.close();
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
