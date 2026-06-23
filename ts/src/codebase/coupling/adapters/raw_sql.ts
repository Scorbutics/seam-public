// FRAMEWORK adapter: raw SQL DML embedded in source — the CROSS-LANGUAGE floor. SQL text is uniform
// regardless of host language, so one text scan covers JDBC (Java), libpq/sqlite3 (C/C++), ActiveRecord
// `find_by_sql`/Sequel raw (Ruby), and any query string in TS — all emitting the SAME `db-table` key as
// the Supabase builder adapter, so a SQL writer couples to a builder reader of the same table.
//
// Distinctive DML only (INSERT INTO / REPLACE INTO / DELETE FROM, UPDATE … SET, SELECT … FROM). The
// SELECT/SET guards keep ordinary host syntax — notably JS `import … from "mod"` — from false-matching.
import type { KeyHit, KeyKind, MaskCtx } from "../types.js";
import { DB_TABLE_META } from "./db_table.js";
import { lineOf, stringLiteralsOnly } from "./util.js";

// an (optionally schema-qualified, optionally "/`/[ ]-quoted) SQL identifier
const TOK = '([`"\\[]?[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)?[`"\\]]?)';
function cleanTable(tok: string): string {
  const bare = tok.replace(/[`"\[\]]/g, "");
  const dot = bare.lastIndexOf(".");
  return dot >= 0 ? bare.slice(dot + 1) : bare;
}

function scan(_file: string, text: string, masked?: MaskCtx): KeyHit[] {
  text = masked?.strings ?? stringLiteralsOnly(text);   // raw SQL lives INSIDE a string literal — scan only those, so SQL-shaped prose in code/comments can't false-match (shared mask across adapters)
  if (!/\b(?:INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|SELECT)\b/i.test(text)) return [];
  const out: KeyHit[] = [];
  // WRITES — distinctive keywords (UPDATE requires a following SET so prose/identifiers don't match)
  for (const re of [
    new RegExp(`\\b(?:INSERT|REPLACE)\\s+INTO\\s+${TOK}`, "gi"),
    new RegExp(`\\bDELETE\\s+FROM\\s+${TOK}`, "gi"),
    new RegExp(`\\bUPDATE\\s+${TOK}\\s+SET\\b`, "gi"),
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ kind: "db-table", value: cleanTable(m[1]), line: lineOf(text, m.index), produces: true });
  }
  // READS — require a preceding SELECT so `import … from "x"` (no SELECT) can't match a FROM
  const selRe = new RegExp(`\\bSELECT\\b[\\s\\S]{0,2000}?\\bFROM\\s+${TOK}`, "gi");
  let m: RegExpExecArray | null;
  while ((m = selRe.exec(text)) !== null) {
    const tableIdx = m.index + m[0].length - m[1].length;   // anchor the line at the table, not at SELECT
    out.push({ kind: "db-table", value: cleanTable(m[1]), line: lineOf(text, tableIdx), produces: false });
  }
  return out;
}

export const RAW_SQL: KeyKind = { ...DB_TABLE_META, name: "raw-sql", blurb: "Raw SQL INSERT/UPDATE/SELECT — DB-table read/write coupling", scan };
