import { createApp } from './app.js';
import { closeDb, openDb } from './lib/db.js';
import { logger } from './lib/logger.js';

openDb();

const app = createApp();
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info(`ledgerline listening on port ${app.address().port}`);
});

function shutdown() {
  app.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
