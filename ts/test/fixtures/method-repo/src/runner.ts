import { Engine } from "./engine";

// Subclass overriding only the abstract hook; `generate` is inherited from the base Engine.
class MissionEngine extends Engine {
  build(): number { return 42; }
}
// A transitive subclass (extends a subclass of the owner) — must still resolve via the family closure.
class DeepEngine extends MissionEngine {}

// Consumer: calls the inherited base-class method on a SUBCLASS instance, typed as the subclass. No
// `import { generate }` anywhere; the receiver's type is recoverable → RESOLVED_FULL.
export function run(): number {
  const engine: MissionEngine = new MissionEngine();
  return engine.generate(7);
}

// Receiver is a `new`-expression of a transitive subclass → RESOLVED_FULL via the closure.
export function runDeep(): number {
  return new DeepEngine().generate(1);
}
