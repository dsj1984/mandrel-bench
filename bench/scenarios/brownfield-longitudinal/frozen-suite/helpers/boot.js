import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const BOOT_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

export async function startApp({ dbPath, env = {}, ownedDir = null } = {}) {
  let resolvedDbPath = dbPath;
  let dir = ownedDir;
  if (!resolvedDbPath) {
    dir = mkdtempSync(path.join(tmpdir(), 'ledgerline-test-'));
    resolvedDbPath = path.join(dir, 'ledgerline.db');
  }

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      LEDGERLINE_DB_PATH: resolvedDbPath,
      LEDGERLINE_TOKEN_SECRET: 'ledgerline-test-signing-key',
      LEDGERLINE_LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `server did not report a port within ${BOOT_TIMEOUT_MS}ms\n${stderrBuf}`,
        ),
      );
    }, BOOT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const match = stdoutBuf.match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `server exited with code ${code} before reporting a port\n${stderrBuf}`,
        ),
      );
    });
  });

  async function stopProcess() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
      await waitForExit(child);
      clearTimeout(killTimer);
    }
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dbPath: resolvedDbPath,
    async stop() {
      await stopProcess();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
    async restart() {
      await stopProcess();
      return startApp({ dbPath: resolvedDbPath, env, ownedDir: dir });
    },
  };
}
