const path = require('path');
const winston = require('winston');
const config = require('./config');

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
  transports: [new winston.transports.Console()],
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

module.exports = { logger, createChild };
