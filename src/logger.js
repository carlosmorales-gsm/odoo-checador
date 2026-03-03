const path = require('path');
const winston = require('winston');
const config = require('./config');

const MAX_LOG_ENTRIES = 2000;
const logBuffer = [];

class MemoryTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    const entry = {
      timestamp: info.timestamp,
      level: info.level,
      message: info.message,
      service: info.service || null,
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    callback();
  }
}

const format = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, message, service }) => {
    const svc = service ? `[${service}]` : '';
    return `${timestamp} ${level.toUpperCase()} ${svc} ${message}`;
  })
);

const logger = winston.createLogger({
  level: config.log.level,
  format,
  transports: [
    new winston.transports.Console(),
    new MemoryTransport(),
  ],
});

if (config.log.filePath) {
  const DailyRotateFile = require('winston-daily-rotate-file');
  const resolved = path.isAbsolute(config.log.filePath)
    ? config.log.filePath
    : path.resolve(process.cwd(), config.log.filePath);
  const ext = path.extname(resolved);
  const base = ext ? resolved.slice(0, -ext.length) : resolved;
  const filename = base + '-%DATE%' + (ext || '.log');

  logger.add(
    new DailyRotateFile({
      filename,
      datePattern: 'YYYY-MM-DD',
      maxSize: config.log.maxSize,
      maxFiles: config.log.maxFiles,
      format,
    })
  );
}

function createChild(service) {
  return logger.child({ service });
}

/**
 * Returns the last N log entries from the in-memory buffer (for GET /api/logs).
 * @param {number} [limit=500] - max entries to return (capped at MAX_LOG_ENTRIES)
 * @returns {{ entries: Array<{ timestamp, level, message, service }> }}
 */
function getRecentLogs(limit = 500) {
  const n = Math.min(Math.max(1, parseInt(limit, 10) || 500), MAX_LOG_ENTRIES);
  const entries = logBuffer.slice(-n);
  return { entries };
}

module.exports = { logger, createChild, getRecentLogs };
