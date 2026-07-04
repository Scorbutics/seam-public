export function getText(p) {
  if (p) return viaPdftotext(p);
  return viaPypdf(p);
}
function viaPdftotext(p) { return "a" + p; }
function viaPypdf(p) { return "b" + p; }
export function extractFromFile(f) { return getText(f); }
