// FRAMEWORK REGISTRY — ORM method vocabulary for the `Model.<method>` db-table boundary. Which query methods
// READ a table vs WRITE it is per-ORM VOCABULARY (ActiveRecord's `where`/`create!`/…); the scan SHAPE
// (`Const.method` on a model, table = tableize(Const)) is generic. These names were baked into two Sets in
// active_record.ts; they live here now as data so the community teaches Seam a new AR-style ORM (Sequel, a house
// DSL) by adding rows — no engine edit (Phase 2 loads rows from `frameworks.json` ormMethods). Keep this SMALL:
// AR-DISTINCTIVE methods only — the ambiguous ones (find/update/delete/select/all/save) are deliberately ABSENT
// so ordinary `Const.method` (File.delete, JSON.parse, Time.now) doesn't false-match a table.
export interface OrmMethod {
  method: string;                // the method token as written (`where`, `create!`) — trailing `!`/`?` included
  role: "read" | "write";        // read = consumes the table (produces:false); write = emits it (produces:true)
  orm?: string;                  // provenance label (activerecord/…) — docs only
}

export const ORM_METHODS: OrmMethod[] = [
  { method: "where",           role: "read",  orm: "activerecord" },
  { method: "find_by",         role: "read",  orm: "activerecord" },
  { method: "find_by!",        role: "read",  orm: "activerecord" },
  { method: "find_each",       role: "read",  orm: "activerecord" },
  { method: "find_in_batches", role: "read",  orm: "activerecord" },
  { method: "pluck",           role: "read",  orm: "activerecord" },
  { method: "includes",        role: "read",  orm: "activerecord" },
  { method: "preload",         role: "read",  orm: "activerecord" },
  { method: "eager_load",      role: "read",  orm: "activerecord" },
  { method: "references",      role: "read",  orm: "activerecord" },
  { method: "create",          role: "write", orm: "activerecord" },
  { method: "create!",         role: "write", orm: "activerecord" },
  { method: "update_all",      role: "write", orm: "activerecord" },
  { method: "delete_all",      role: "write", orm: "activerecord" },
  { method: "destroy_all",     role: "write", orm: "activerecord" },
  { method: "insert",          role: "write", orm: "activerecord" },
  { method: "insert!",         role: "write", orm: "activerecord" },
  { method: "insert_all",      role: "write", orm: "activerecord" },
  { method: "insert_all!",     role: "write", orm: "activerecord" },
  { method: "upsert",          role: "write", orm: "activerecord" },
  { method: "upsert_all",      role: "write", orm: "activerecord" },
];

let _read = new Set<string>();
let _write = new Set<string>();
function _rebuild(): void {
  _read = new Set(ORM_METHODS.filter((o) => o.role === "read").map((o) => o.method));
  _write = new Set(ORM_METHODS.filter((o) => o.role === "write").map((o) => o.method));
  for (const o of _extra) (o.role === "write" ? _write : _read).add(o.method);
}
let _extra: OrmMethod[] = [];
_rebuild();

export function registerOrmMethods(ms: OrmMethod[]): void {
  _extra = _extra.concat(ms.filter((o) => o && typeof o.method === "string" && (o.role === "read" || o.role === "write")));
  _rebuild();
}
export function _resetOrmMethods(): void { _extra = []; _rebuild(); }

export function isOrmRead(method: string): boolean { return _read.has(method); }
export function isOrmWrite(method: string): boolean { return _write.has(method); }
// Stable vocab fingerprint (folded into the coupling cache salt so a manifest-added ORM method invalidates a stale floor).
export function ormVocab(): string { return `r:${[..._read].sort().join(",")}|w:${[..._write].sort().join(",")}`; }
