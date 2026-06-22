// FRAMEWORK adapter: jOOQ (Java). `dsl.insertInto(PAYMENTS)`, `.selectFrom(Tables.PAYMENTS)`,
// `.deleteFrom(X)`, `.update(PAYMENTS)` — the table is the codegen constant's last component,
// lowercased (PAYMENTS → payments), sharing the `db-table` key with SQL/builder adapters. The
// distinctive methods match any arg; the ambiguous `.update(...)` requires a CONSTANT-looking
// (capitalized) arg so `messageDigest.update(bytes)` doesn't false-match. Gated to .java.
import type { KeyHit, KeyKind } from "../types.js";
import { DB_TABLE_META } from "./db_table.js";
import { lineOf } from "./util.js";

const table = (tok: string) => tok.split(".").pop()!.toLowerCase();

function scan(file: string, text: string): KeyHit[] {
  if (!file.endsWith(".java")) return [];
  const out: KeyHit[] = [];
  const passes: [RegExp, boolean][] = [
    [/\.(?:insertInto|mergeInto|deleteFrom)\s*\(\s*([A-Za-z_][\w.]*)\s*\)/g, true],
    [/\.selectFrom\s*\(\s*([A-Za-z_][\w.]*)\s*\)/g, false],
    [/\.update\s*\(\s*([A-Z][A-Za-z0-9_.]*)\s*\)/g, true],   // capitalized arg only → skip digest.update(bytes)
  ];
  for (const [re, produces] of passes) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ kind: "db-table", value: table(m[1]), line: lineOf(text, m.index), produces });
  }
  return out;
}

export const JOOQ: KeyKind = { ...DB_TABLE_META, name: "jooq", blurb: "jOOQ `.insertInto/.selectFrom(t)` — DB-table coupling", scan };
