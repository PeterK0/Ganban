/**
 * Logging utility for Ganban
 * Provides structured logging with different levels and categories
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'action' | 'api' | 'performance' | 'general';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  context?: string;
  message: string;
  data?: any;
}

const LOG_COLORS = {
  debug: '#6c7086',    // Subtext
  info: '#89b4fa',     // Blue
  warn: '#f9e2af',     // Yellow
  error: '#f38ba8',    // Red
  action: '#a6e3a1',   // Green
  api: '#89dceb',      // Sky
  performance: '#cba6f7', // Mauve
  general: '#cdd6f4',  // Text
};

class Logger {
  private enabled: boolean = true;

  /**
   * Enable or disable logging globally
   */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * Internal log method
   */
  private log(level: LogLevel, category: LogCategory, message: string, context?: string, data?: any) {
    if (!this.enabled) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      context,
      message,
      data,
    };

    const color = LOG_COLORS[level];
    const categoryColor = LOG_COLORS[category];
    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${category.toUpperCase()}]${context ? ` [${context}]` : ''}`;

    // Use console methods based on log level
    const consoleMethod = level === 'error' ? console.error :
                          level === 'warn' ? console.warn :
                          console.log;

    if (data !== undefined) {
      consoleMethod(
        `%c${prefix}%c ${message}`,
        `color: ${color}; font-weight: bold`,
        `color: ${categoryColor}`,
        data
      );
    } else {
      consoleMethod(
        `%c${prefix}%c ${message}`,
        `color: ${color}; font-weight: bold`,
        `color: ${categoryColor}`
      );
    }
  }

  /**
   * Debug level log
   */
  debug(message: string, context?: string, data?: any) {
    this.log('debug', 'general', message, context, data);
  }

  /**
   * Info level log
   */
  info(message: string, context?: string, data?: any) {
    this.log('info', 'general', message, context, data);
  }

  /**
   * Warning level log
   */
  warn(message: string, context?: string, data?: any) {
    this.log('warn', 'general', message, context, data);
  }

  /**
   * Error level log
   */
  error(message: string, context?: string, data?: any) {
    this.log('error', 'general', message, context, data);
  }

  /**
   * Log user actions (clicks, edits, etc.)
   */
  action(action: string, context?: string, details?: any) {
    this.log('info', 'action', `User action: ${action}`, context, details);
  }

  /**
   * Log API calls
   */
  api(method: string, context?: string, details?: any) {
    this.log('info', 'api', `API call: ${method}`, context, details);
  }

  /**
   * Performance timing wrapper
   * Returns the result of the function and logs the execution time
   */
  async time<T>(
    label: string,
    fn: () => Promise<T>,
    context?: string
  ): Promise<T> {
    const start = performance.now();
    this.log('debug', 'performance', `Starting: ${label}`, context);

    try {
      const result = await fn();
      const duration = performance.now() - start;
      this.log('info', 'performance', `Completed: ${label} (${duration.toFixed(2)}ms)`, context);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.log('error', 'performance', `Failed: ${label} (${duration.toFixed(2)}ms)`, context, error);
      throw error;
    }
  }

  /**
   * Synchronous performance timing wrapper
   */
  timeSync<T>(
    label: string,
    fn: () => T,
    context?: string
  ): T {
    const start = performance.now();
    this.log('debug', 'performance', `Starting: ${label}`, context);

    try {
      const result = fn();
      const duration = performance.now() - start;
      this.log('info', 'performance', `Completed: ${label} (${duration.toFixed(2)}ms)`, context);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.log('error', 'performance', `Failed: ${label} (${duration.toFixed(2)}ms)`, context, error);
      throw error;
    }
  }

  /**
   * Group related logs together
   */
  group(label: string, fn: () => void) {
    console.group(`%c${label}`, `color: ${LOG_COLORS.info}; font-weight: bold`);
    fn();
    console.groupEnd();
  }

  /**
   * Collapsed group (expand to see logs)
   */
  groupCollapsed(label: string, fn: () => void) {
    console.groupCollapsed(`%c${label}`, `color: ${LOG_COLORS.info}; font-weight: bold`);
    fn();
    console.groupEnd();
  }
}

// Export singleton instance
export const logger = new Logger();

// Export convenience methods
export const logAction = (action: string, context?: string, details?: any) =>
  logger.action(action, context, details);

export const logApi = (method: string, context?: string, details?: any) =>
  logger.api(method, context, details);

export const logPerformance = async <T>(
  label: string,
  fn: () => Promise<T>,
  context?: string
): Promise<T> => logger.time(label, fn, context);
