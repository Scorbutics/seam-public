// THE HOST-BUS PUMP — lets the Rust core's LLM passes be served by the CALLER's model.
//
// `set_host_bus(...)` installs a model on the TypeScript side: a Claude Code skill lending the live session's
// model, the VS Code extension injecting the editor's configured one, an MCP client answering by sampling, or
// a test standing in with a scripted reply. Until now that model was invisible to the core, so every pass the
// core owns — key discovery, carrier synthesis, receiver classification, route composition — was reachable
// only through a local `claude`/`copilot` binary.
//
// WHY A PUMP AND NOT A CALLBACK. The JS thread is BLOCKED inside the synchronous addon call for as long as the
// core runs. Handing the core a function to call back into would queue work onto an event loop that cannot
// turn until the call returns: a deadlock presenting as a hang. So the core records the prompts it wants and
// returns; we serve them here with the host's model; we run it again with the answers in hand. Rounds repeat
// while NEW prompts keep appearing, which is what makes an iterative pass work — one whose next prompt depends
// on the last answer.
//
// The cost is that the wrapped call runs more than once. That is affordable because a recorded-but-unanswered
// pass returns an ERROR inside the core, and every flywheel caller treats an error as "no backend" and
// persists nothing — so the collecting rounds do no work and leave no trace. The final round is the real one.
import { get_host_bus } from "./llm.js";

// The addon is passed IN, not imported. `core/` sits below `codebase/` in the layering (the architecture test
// enforces it), and reaching up for the loader would invert that for no gain: every caller of the pump already
// holds the addon it wants to run. Typed structurally — the pump needs exactly three entry points from it.
export interface HostBusAddon {
  installHostBus(answers: string[][]): void;
  takeHostRecorded(): string[][];
  uninstallHostBus(): void;
}

// A cap, not a budget. An iterative pass converges in a handful of rounds; a pass that keeps producing NEW
// prompts every round is looping, and running it forever would look like a hang rather than a bug.
const MAX_ROUNDS = 8;

/// Run `fn` with the host's model available to the core. With no host bus installed this is a plain call —
/// the core resolves its own backend exactly as before, and nothing about the local-binary path changes.
export function withHostBus<T>(addon: HostBusAddon | null, fn: () => T): T {
  const bus = get_host_bus();
  if (!bus || !addon) return fn();

  const answers = new Map<string, string>();
  let out!: T, prev: { v: T } | null = null;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      addon.installHostBus([...answers].map(([k, v]) => [k, v]));
      out = fn();
      const recorded: string[][] = addon.takeHostRecorded();
      // NOTHING RECORDED means this round asked no question it could not answer — so the round BEFORE it is
      // the one that consumed the answers and did the work. That distinction matters because the core's passes
      // have side effects BY DESIGN (learn-once → persist → replay): the round after a successful one finds a
      // settled store and reports "nothing to learn". Returning it would throw away the result we just paid a
      // model for. With no previous round there is nothing to prefer, so this one stands.
      if (!recorded.length) return prev ? prev.v : out;
      prev = { v: out };
      let fresh = 0;
      for (const [key, tag, prompt, model, thinking] of recorded) {
        if (answers.has(key)) continue;               // already served and still unanswered ⇒ the host declined it
        answers.set(key, bus.serve(tag, prompt, model, thinking === "" ? null : Number(thinking)));
        fresh++;
      }
      // No NEW question means the host is declining the ones we have; running again would ask the same set
      // forever. Stop and keep this round's result — there is no later, better one coming.
      if (!fresh) return out;
    }
    // Round cap hit: return the last run's result rather than throwing. A flywheel that cannot finish learning
    // should degrade to what it already knows, not take the caller's query down with it.
    return out;
  } finally {
    addon.uninstallHostBus();
  }
}

/// The async form, for callers whose work is a Promise. Same protocol; `fn` is awaited each round.
export async function withHostBusAsync<T>(addon: HostBusAddon | null, fn: () => Promise<T>): Promise<T> {
  const bus = get_host_bus();
  if (!bus || !addon) return fn();

  const answers = new Map<string, string>();
  let out!: T, prev: { v: T } | null = null;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      addon.installHostBus([...answers].map(([k, v]) => [k, v]));
      out = await fn();
      const recorded: string[][] = addon.takeHostRecorded();
      if (!recorded.length) return prev ? prev.v : out;   // see withHostBus — the PREVIOUS round did the work
      prev = { v: out };
      let fresh = 0;
      for (const [key, tag, prompt, model, thinking] of recorded) {
        if (answers.has(key)) continue;
        answers.set(key, bus.serve(tag, prompt, model, thinking === "" ? null : Number(thinking)));
        fresh++;
      }
      if (!fresh) return out;
    }
    return out;
  } finally {
    addon.uninstallHostBus();
  }
}
