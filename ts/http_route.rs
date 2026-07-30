
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mask::MaskCtx;
    use crate::types::CouplingAdapter;

    fn keys(file: &str, text: &str) -> Vec<String> {
        let mask = MaskCtx::new(text);
        let mut v: Vec<String> = HttpRoute.scan(file, text, &mask).into_iter().map(|h| h.value).collect();
        v.sort();
        v.dedup();
        v
    }

    #[test]
    fn a_module_specifier_is_not_a_route() {
        // `next/server` matches BARE_ROUTE exactly — two literal segments, no extension for FILE_LIKE to reject —
        // so every Next.js route handler reported a phantom `http-route "next/server"` it "reads", and any two
        // files importing it were coupled to each other through it. Found in the first example picked for the
        // README, on a real repo, in the flagship output.
        let src = "import { NextRequest, NextResponse } from \"next/server\"\nconst x = require(\"pkg/sub\");\nconst y = await import(\"other/mod\");\n";
        assert!(keys("app/api/x/route.ts", src).iter().all(|k| !k.contains("next/server") && !k.contains("pkg/sub") && !k.contains("other/mod")),
            "a module specifier leaked in as a route: {:?}", keys("app/api/x/route.ts", src));
    }

    #[test]
    fn a_real_route_literal_still_resolves() {
        // FALSIFICATION of the guard above: it must reject import POSITIONS, not every bare literal. If it
        // over-reached, the indirected-route path (a URL stashed in a field) would go silently dark.
        let src = "const url = \"/api/admin/report-snapshots\";\nfetch(url);\n";
        assert!(keys("lib/services/x.ts", src).iter().any(|k| k.contains("/api/admin/report-snapshots")),
            "a real route literal was dropped: {:?}", keys("lib/services/x.ts", src));
    }
}
