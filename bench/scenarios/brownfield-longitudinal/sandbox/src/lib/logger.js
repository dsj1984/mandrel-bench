const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function currentLevel() {
  const name = process.env.LEDGERLINE_LOG_LEVEL ?? 'info';
  return LEVELS[name] ?? LEVELS.info;
}

function write(stream, level, message, fields) {
  const line = { ts: new Date().toISOString(), level, message, ...fields };
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  error(message, fields = {}) {
    if (currentLevel() >= LEVELS.error) {
      write(process.stderr, 'error', message, fields);
    }
  },
  warn(message, fields = {}) {
    if (currentLevel() >= LEVELS.warn) {
      write(process.stderr, 'warn', message, fields);
    }
  },
  info(message, fields = {}) {
    if (currentLevel() >= LEVELS.info) {
      write(process.stdout, 'info', message, fields);
    }
  },
  debug(message, fields = {}) {
    if (currentLevel() >= LEVELS.debug) {
      write(process.stdout, 'debug', message, fields);
    }
  },
};
