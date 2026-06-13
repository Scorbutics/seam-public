// Shared adapter helpers.
export const lineOf = (text: string, idx: number): number => (text.slice(0, idx).match(/\n/g)?.length ?? 0);
