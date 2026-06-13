// A base (abstract) class whose `generate` method is the anchor. Consumers never import `generate`
// (methods are not import bindings) and call it on a SUBCLASS instance — the import-scan front is
// blind to this; only the receiver-agnostic call-site pass recovers it (RESOLVED_PARTIAL).
export abstract class Engine {
  abstract build(): number;
  generate(week: number): number {
    return this.build() + week;
  }
}
