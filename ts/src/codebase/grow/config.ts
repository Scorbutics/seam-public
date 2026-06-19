// GROW phase tunables — centralized knobs (values identical to the inlined literals).
export const GROW = {
  moveCap: 30,       // orchestrate: a single grow move adding more nodes than this is "too broad" → skipped
  maxConsecNoop: 2,  // orchestrate: bail auto-grow after this many consecutive no-op moves (genuinely stuck)
};
