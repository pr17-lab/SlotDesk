import pino from 'pino';

// Silent in test so test output stays clean; info everywhere else.
// shortcut: reads NODE_ENV directly, not through config.ts; move it into config.ts when the logger needs another setting (for example a log level)
const level = process.env.NODE_ENV === 'test' ? 'silent' : 'info';

export const logger = pino({ level });
