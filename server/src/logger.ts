import pino from 'pino';

// Silent in test so test output stays clean; info everywhere else.
const level = process.env.NODE_ENV === 'test' ? 'silent' : 'info';

export const logger = pino({ level });
