// JSX-specific tree-walk: what a CALLER binds into a JSX tag matching the anchor component
// (`<Anchor propName={value} />` -> {propName: [{value, line}]}). JSX has no equivalent in the other
// registered languages (Java/Ruby/Python), so this stays TS/JS-only rather than living in the generic,
// cross-language codebase/atoms.ts (moved out of there — a language-separation audit flagged the raw
// jsx_opening_element/jsx_self_closing_element/jsx_attribute node kinds as a leak into that shared file).
// `ctx` is an atoms.Ctx, duck-typed (this module can't import atoms.ts without risking a cycle back through
// the language registry — same convention as LanguageProvider.entrypoint).
export function consumerFeeds(ctx: any, anchorName: string): Record<string, any[]> {
  const feeds: Record<string, any[]> = {};
  const elements = ctx.collect(ctx.root, (k: string) => k === "jsx_opening_element" || k === "jsx_self_closing_element");
  for (const el of elements) {
    const tag = ctx.children(el).find((c: any) => ["identifier", "member_expression", "nested_identifier"].includes(c.type));
    if (!tag || ctx.text(tag) !== anchorName) continue;
    for (const attr of ctx.children(el).filter((c: any) => c.type === "jsx_attribute")) {
      const ch = ctx.children(attr);
      const pnameNode = ch.find((c: any) => c.type.includes("property_identifier") || c.type === "identifier");
      if (!pnameNode) continue;
      const pname = ctx.text(pnameNode);
      const valnode = ch.find((c: any) => c.type === "jsx_expression" || c.type === "string");
      let vnode: any = null, value: string;
      if (!valnode) value = "true";
      else if (valnode.type === "jsx_expression") {
        const inner = ctx.children(valnode).filter((c: any) => c.isNamed);
        vnode = inner.length ? inner[0] : valnode;
        value = ctx.text(vnode);
      } else { vnode = valnode; value = ctx.text(valnode); }
      const feed: any = { value: value.trim(), line: ctx.span(attr)[0] };
      if (vnode) { feed.valLine = ctx.span(vnode)[0]; feed.valCol = ctx.col(vnode.startIndex); }
      (feeds[pname] ??= []).push(feed);
    }
  }
  return feeds;
}
