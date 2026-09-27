import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, fields, message) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: config.serviceName,
    msg: message,
    ...fields,
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line, (k, v) => (v === undefined ? null : v)) + '\n');
}

export function logger(bindings = {}) {
  const base = { ...bindings };
  return {
    debug: (message, fields = {}) => emit('debug', { ...base, ...fields }, message),
    info: (message, fields = {}) => emit('info', { ...base, ...fields }, message),
    warn: (message, fields = {}) => emit('warn', { ...base, ...fields }, message),
    error: (message, fields = {}) => emit('error', { ...base, ...fields }, message),
    child: (extra) => logger({ ...base, ...extra }),
  };
}

export const log = logger();
