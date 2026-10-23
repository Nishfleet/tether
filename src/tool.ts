export const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

export const failure = (value: string) => ({ ...text(value), isError: true });
