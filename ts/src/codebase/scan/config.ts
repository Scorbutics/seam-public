// SCAN phase tunables — centralized so the knobs live in one reviewable place. Values are identical to
// the literals they replaced; this is relocation, not a behavior change.
export const SCAN = {
  uiCap: 6,     // import_scan: max UI/coupling complement nodes materialized per anchor (bounds the fan)
  docCap: 200,  // def_table: max chars of a leading doc-comment kept (the concept the symbol name omits)
};
