export interface Logger {
  info: (o: Record<string, unknown>, msg?: string) => void;
  warn: (o: Record<string, unknown>, msg?: string) => void;
  error: (o: Record<string, unknown>, msg?: string) => void;
}

/** JSON lines on standard output, one per event: what a process manager or a log shipper expects. */
export function consoleLogger(): Logger {
  const write = (level: string) => (o: Record<string, unknown>, msg?: string) => console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...o }));
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
