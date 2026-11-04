/**
 * Structured JSON Logger for SkillHive Backend
 * Replaces console.log/error/warn with structured JSON output
 */

const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = levels[process.env.LOG_LEVEL] ?? levels.info;

function formatMessage(level, message, meta = {}) {
  return JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ...meta,
  });
}

const logger = {
  debug: (message, meta = {}) => {
    if (currentLevel <= levels.debug) {
      console.debug(formatMessage('debug', message, meta));
    }
  },
  info: (message, meta = {}) => {
    if (currentLevel <= levels.info) {
      console.log(formatMessage('info', message, meta));
    }
  },
  warn: (message, meta = {}) => {
    if (currentLevel <= levels.warn) {
      console.warn(formatMessage('warn', message, meta));
    }
  },
  error: (message, meta = {}) => {
    if (currentLevel <= levels.error) {
      console.error(formatMessage('error', message, meta));
    }
  },
};

module.exports = { logger };