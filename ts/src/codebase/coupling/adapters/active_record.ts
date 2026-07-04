// FRAMEWORK adapter: ActiveRecord (Ruby). `Model.where/create!/find_each/…` — the table is
// ActiveRecord's `tableize` of the model constant (CamelCase → snake_case → pluralized last word), so
// `Payment.where` and a SQL `… FROM payments` share the same `db-table` key. Only AR-DISTINCTIVE
// methods match; the ambiguous ones (find/update/delete/select/all/save) are deliberately excluded so
// ordinary `Const.method` (File.delete, JSON.parse, Time.now) doesn't false-match. Gated to .rb.
import type { KeyHit, KeyKind } from "../types.js";
import { DB_TABLE_META } from "./db_table.js";
import { lineOf } from "./util.js";
import { isOrmRead, isOrmWrite } from "../frameworks/orm_methods.js";

function pluralize(w: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(w)) return w + "es";
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + "ies";
  return w + "s";
}
function tableize(cls: string): string {
  const parts = cls.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split("_");
  return parts.map((p, i) => (i === parts.length - 1 ? pluralize(p) : p)).join("_");
}

function scan(file: string, text: string): KeyHit[] {
  if (!file.endsWith(".rb")) return [];
  const out: KeyHit[] = [];
  const re = /\b([A-Z][A-Za-z0-9_]*)\.([a-z_][a-z0-9_]*[!?]?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const method = m[2];
    const write = isOrmWrite(method);
    if (!write && !isOrmRead(method)) continue;
    out.push({ kind: "db-table", value: tableize(m[1]), line: lineOf(text, m.index), produces: write });
  }
  return out;
}

export const ACTIVE_RECORD: KeyKind = { ...DB_TABLE_META, name: "active-record", blurb: "Rails ActiveRecord model reads/writes — DB-table coupling", scan };
