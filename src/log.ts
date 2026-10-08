/**
 * Logging. Everything goes to stderr: stdout is reserved for the MCP stdio transport and for CLI output.
 * Level via CALCITE_LOG_LEVEL (debug|info|warn|error|silent), default info.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let level: LogLevel = (process.env.CALCITE_LOG_LEVEL as LogLevel) in ORDER ? (process.env.CALCITE_LOG_LEVEL as LogLevel) : 'info';

export function setLogLevel(next: LogLevel): void {
  level = next;
}

function write(at: LogLevel, scope: string, message: string): void {
  if (ORDER[at] < ORDER[level]) return;
  const time = new Date().toISOString().slice(11, 23);
  process.stderr.write(`${time} ${at.toUpperCase().padEnd(5)} [${scope}] ${message}\n`);
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m) => write('debug', scope, m),
    info: (m) => write('info', scope, m),
    warn: (m) => write('warn', scope, m),
    error: (m) => write('error', scope, m),
  };
}
