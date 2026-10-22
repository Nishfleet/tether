export type Log = (event: string, fields?: Record<string, string | number | boolean>) => void;

export const stdoutLog: Log = (event, fields) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
};
