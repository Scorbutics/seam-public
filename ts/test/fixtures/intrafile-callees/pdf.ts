export function getText(p: string): string {
  if (p) return viaPdftotext(p);
  return viaPypdf(p);
}
function viaPdftotext(p: string): string { return "a" + p; }
function viaPypdf(p: string): string { return "b" + p; }
export function extractFromFile(f: string): string { return getText(f); }
