// FRAMEWORK adapter: JPA / Hibernate (Java). An `@Entity` class IS a DB table — its `@Table(name="X")` (or the
// class name) is the table key, the SAME `db-table` kind the SQL/builder adapters emit, so a JPA writer/reader and
// a raw-SQL query of the same table couple through ONE boundary. The persistence VERB decides produce vs consume.
//
// GROUNDED, no @Entity index / no type inference — the entity is NAMED at each site, or the verb guarantees it:
//   • `@Entity` [+ `@Table(name="X")`] declaration            → the boundary (keyed on BOTH the class name — how
//                                                                JPA callers name it — and the @Table name — how
//                                                                raw SQL names it — so both sides couple to it).
//   • EntityManager `persist|merge|remove` are ENTITY-MANAGER-ONLY, so their argument IS an entity: `new X(…)` /
//     `X.class` / a same-file-declared `X var`  → a db-WRITE of X. (A typeless var whose type isn't declared in
//     the file is an honest under-reach — not guessed.)
//   • `find|getReference(X.class, …)`                          → a db-READ of X.
//   • Spring-Data / Hibernate `save|saveOrUpdate(new X(…))`    → a db-WRITE of X (arg is a constructor).
//   • a JPQL string `… from X …`                              → a db-READ of X.
// Gated to .java. Comments/strings-in-code are masked so a commented `persist(` doesn't match.
import type { KeyHit, KeyKind } from "../types.js";
import { DB_TABLE_META } from "./db_table.js";
import { lineOf, maskComments } from "./util.js";

function scan(file: string, text0: string): KeyHit[] {
  if (!file.endsWith(".java")) return [];
  const text = maskComments(text0);
  const out: KeyHit[] = [];
  const seen = new Set<string>();
  const add = (value: string, line: number, produces: boolean, op?: string): void => {
    const k = `${value}|${line}|${produces}`; if (seen.has(k)) return; seen.add(k);
    out.push({ kind: "db-table", value, line, produces, ...(op ? { op } : {}) });
  };
  let m: RegExpExecArray | null;

  // 1) `@Entity` declaration → the table boundary. Key on the class name (JPA callers name the class) AND the
  //    @Table name (raw SQL names the table) so a caller and a SQL reader both couple to this one boundary.
  //    `@Entity` binds to the class DIRECTLY BELOW it — bind to the FIRST `class` after it, NOT a fixed char
  //    distance: a big javadoc or `@NamedQueries` block between `@Entity` and `class` used to push the class past
  //    a 400-char cap → the entity boundary was missed and its writers found no other side (acme MemberBooking).
  //    Comments are masked and JPQL strings don't contain `class X`, so the first `class` after `@Entity` is it.
  const ent = /@Entity\b/g;
  while ((m = ent.exec(text))) {
    const rest = text.slice(m.index);
    const cm = /\bclass\s+([A-Z]\w*)/.exec(rest);
    if (!cm) continue;
    const cls = cm[1], line = lineOf(text, m.index);
    const tbl = /@Table\s*\(\s*name\s*=\s*"([^"]+)"/.exec(rest.slice(0, cm.index))?.[1];   // @Table sits between @Entity and the class
    add(cls, line, false);
    if (tbl && tbl !== cls) add(tbl, line, false);
  }

  // same-file declared types: (name, Type, line) — used only to attribute a `persist/merge/remove(var)` (the verb
  // guarantees `var` is an entity). SCOPE-AWARE: a persist(var) resolves to the NEAREST PRECEDING declaration of
  // that name, so a local (`ProtocolMapperEntity entity = …` just above `em.persist(entity)`) beats a field of the
  // same name at the class top (`ClientEntity entity;`) — else the write mislabels as the adapter's subject entity.
  const decls: { name: string; type: string; line: number }[] = [];
  const vd = /\b([A-Z]\w*)\s+([a-z_]\w*)\s*[;=,)]/g;
  while ((m = vd.exec(text))) decls.push({ name: m[2], type: m[1], line: lineOf(text, m.index) });
  const resolveVar = (name: string, atLine: number): string | undefined => {
    let preceding: { type: string; line: number } | undefined, any: { type: string; line: number } | undefined;
    for (const d of decls) if (d.name === name) {
      if (!any || d.line < any.line) any = d;   // earliest declaration — a fallback when none precedes the use
      if (d.line <= atLine && (!preceding || d.line > preceding.line)) preceding = d;   // NEAREST preceding wins (shadowing)
    }
    return (preceding ?? any)?.type;
  };

  // 2) EntityManager / repository WRITES — persist/merge/remove AND the save-family (Spring-Data / Hibernate, and a
  //    CUSTOM `save(entity)` wrapper like acme's RequestScopedJpaEntityManager). Each NAMES or TYPE-RESOLVES its
  //    entity arg: `new X()` / `X.class` / a same-file-declared `X var` — a local, FIELD, or PARAM. The param case
  //    is the acme write: `updateAndSaveMemberBookingEntity(final MemberBooking memberBooking){ … ;
  //    mJpaEntityManager.save(memberBooking); }` — the arg is a typed parameter, not an inline `new` (which the
  //    old save-only-`new X()` rule required, so it was missed). `remove` is a DELETE (op-tagged so it never wins
  //    over a create as a table's representative write site); the rest are writes. A typeless var (its type not
  //    declared in the file) is an honest under-reach, not a guess.
  const emWrite = /\.(persist|merge|remove|save|saveAndFlush|saveOrUpdate|persistAndFlush)\s*\(\s*(?:new\s+([A-Z]\w*)|([A-Z]\w*)\.class|([a-z_]\w*))/g;
  while ((m = emWrite.exec(text))) {
    const ln = lineOf(text, m.index);
    const e = m[2] || m[3] || (m[4] ? resolveVar(m[4], ln) : undefined);
    if (e) add(e, ln, true, m[1] === "remove" ? "delete" : undefined);
  }
  // 3) reads — find/getReference on an `X.class`.
  const emRead = /\.(?:find|getReference)\s*\(\s*([A-Z]\w*)\.class/g;
  while ((m = emRead.exec(text))) add(m[1], lineOf(text, m.index), false);
  // 5) JPQL `from X` inside a query/named-query string. The keyword is case-INSENSITIVE (`from`/`FROM`), but the
  //    ENTITY must be PascalCase — a JPA entity always starts uppercase. Guard on the first char: the `i` flag would
  //    otherwise let `([A-Z]\w*)` match a lowercase word (`from where`, `from stream`, `select … from query`),
  //    fabricating garbage lowercase "tables" that then anchor the spine on a non-entity.
  const jpql = /\bfrom\s+([A-Za-z]\w*)\b/gi;
  const strings = (text0.match(/"(?:[^"\\]|\\.)*"/g) ?? []).join("\n");   // scan STRING literals (JPQL lives in strings)
  while ((m = jpql.exec(strings))) { if (/^[A-Z]/.test(m[1])) add(m[1], 0, false); }
  return out;
}

export const JPA_ENTITY: KeyKind = { ...DB_TABLE_META, name: "jpa-entity", blurb: "JPA/Hibernate @Entity persist/find/JPQL — DB-table read/write coupling", scan };
