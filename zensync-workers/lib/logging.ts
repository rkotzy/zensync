type LogLevel = 'log' | 'warn' | 'error';

export function safeLog(level: LogLevel, ...params: any[]) {
  // Validate the logging level; default to 'error' if invalid to ensure errors are always logged
  const validLevels: LogLevel[] = ['log', 'warn', 'error'];
  let chosenLevel: LogLevel = validLevels.includes(level) ? level : 'error';

  const output = params.map(param => {
    if (param instanceof Error) {
      return `Error: ${param.message}, Stack: ${param.stack}`;
    } else if (typeof param === 'object') {
      try {
        return JSON.stringify(param, null, 2);
      } catch (error) {
        chosenLevel = 'error';
        return `Failed to stringify object: ${error.message}`;
      }
    }
    return param;
  });

  console[chosenLevel](...output);
}
