// DECOY. Mentions `work_orders` in user-facing help text and in a comment, and touches no database at all.
// grep on the table name matches this file; it is not coupled to anything.
export function Help() {
  return "Your open jobs live in the work_orders view. Ask an admin if a work_orders row looks wrong.";
}
