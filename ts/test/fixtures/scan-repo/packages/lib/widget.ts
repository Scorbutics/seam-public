// The ANCHOR: a module-level exported function with several cross-project consumers.
export function makeWidget(name: string) {
  return { name, kind: "widget" };
}

// A second exported member — module mode treats it as a carrier; co-occurrence with makeWidget
// (consumer.ts imports BOTH) should fuse them into one intent seam.
export const WIDGET_KIND = "widget";

// A member with NO consumer → an isolated carrier (its own seam) in module mode.
export function makeOrphan() {
  return { kind: "orphan" };
}
