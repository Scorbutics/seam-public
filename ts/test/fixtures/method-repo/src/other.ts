// An UNRELATED class that happens to expose a same-named `generate` method. A call to it must NOT be
// promoted — it is not in the Engine family — so it stays RESOLVED_PARTIAL (honest ambiguity), the
// signal that "this same-named call may not be your method."
class Report {
  generate(): string { return "report"; }
}

export function makeReport(): string {
  const report: Report = new Report();
  return report.generate();
}
