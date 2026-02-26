const config = require('./config');
const winston = require('winston');
const cron = require('node-cron');
const http = require('http');
const stateDb = require('./db/state');
const { syncAll } = require('./sync/attendance');

// Configure logger
const logger = winston.createLogger({
  level: config.log.level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, service }) => {
      const svc = service ? `[${service}]` : '';
      return `${timestamp} ${level.toUpperCase()} ${svc} ${message}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

// Initialize SQLite
logger.info('Initializing database...');
stateDb.init();

// Track if sync is currently running
let syncing = false;

async function runSync() {
  if (syncing) {
    logger.warn('Previous sync still running, skipping this cycle');
    return;
  }
  syncing = true;
  try {
    await syncAll();
  } catch (err) {
    logger.error(`Sync failed: ${err.message}`);
  } finally {
    syncing = false;
  }
}

// Schedule cron job
logger.info(`Scheduling sync with cron: ${config.sync.interval}`);
cron.schedule(config.sync.interval, runSync);

// Run initial sync on startup
logger.info('Running initial sync...');
runSync();

// Health check HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', syncing }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(config.healthPort, () => {
  logger.info(`Health check server listening on port ${config.healthPort}`);
});

// Graceful shutdown
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close();
  stateDb.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
