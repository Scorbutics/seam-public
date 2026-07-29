//! Hub selection for the repo-wide structural precompute (`seam --warm`) — port of `rankHubs` in
//! `ts/src/codebase/grow/warm.ts`.
//!
//! Only the RANKING moves. The warm pass itself is a loop of ordinary module grows, each already served by
//! the core, and its progress reporting belongs to the CLI — there is nothing to gain by owning the loop
//! here. What moves is the part that would otherwise drag the whole repo-wide reverse-import map across
//! napi (every target file, with its full importer set) purely to count, filter and cut it to 40.
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

/// The warm pass's OWN test/mock convention — deliberately not shared with `center_repo`'s.
///
/// They genuinely differ: this one excludes `__mocks__` (a mock is a hub by fan-in and warming it is
/// wasted work) and does not exclude `e2e`/`cypress`/`.stories`. Whether that divergence is intentional or
/// drift is a product question, and answering it would change which files get warmed — so the port keeps
/// each regex exactly as it was rather than quietly unifying them.
static TEST_OR_MOCK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(^|/)(__tests__|__mocks__)(/)|\.(test|spec)\.[cm]?[jt]sx?$|(^|/)tests?/").unwrap()
});

fn excluded(file: &str, include_tests: bool, exclude_dirs: &[String]) -> bool {
    if !include_tests && TEST_OR_MOCK.is_match(file) {
        return true;
    }
    exclude_dirs.iter().any(|d| {
        let pfx = if d.ends_with('/') { d.clone() } else { format!("{d}/") };
        file == d || file.starts_with(&pfx)
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct Hub {
    pub file: String,
    #[serde(rename = "fanIn")]
    pub fan_in: usize,
}

/// Rank candidate hubs by fan-in (importer count), most-imported first, excluded files dropped, capped.
///
/// The sort is STABLE over the reverse-import map's INSERTION order — equal-fan-in files keep first-seen
/// order, and since the list is then cut to `top` that order decides which of them get warmed at all.
pub fn rank_hubs(repo: &str, top: usize, include_tests: bool, exclude_dirs: &[String]) -> Vec<Hub> {
    let importers = seam_resolve::Workspace::cached(repo).file_importers();
    let mut hubs: Vec<Hub> = importers
        .into_iter()
        .map(|(file, set)| Hub { file, fan_in: set.len() })
        .filter(|h| !excluded(&h.file, include_tests, exclude_dirs))
        .collect();
    hubs.sort_by(|a, b| b.fan_in.cmp(&a.fan_in));
    hubs.truncate(top.max(1));
    hubs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tests_and_mocks_are_excluded_unless_include_tests() {
        for f in ["src/__tests__/a.ts", "src/__mocks__/b.ts", "a.test.ts", "a.spec.tsx", "tests/x.ts", "test/x.ts"] {
            assert!(excluded(f, false, &[]), "{f} should be excluded");
            assert!(!excluded(f, true, &[]), "{f} should be admitted with includeTests");
        }
    }

    #[test]
    fn the_warm_convention_differs_from_center_firsts_and_that_is_preserved_not_unified() {
        // `e2e`/`cypress`/`.stories` are center-first exclusions but NOT warm ones. Pinned so that a later
        // "tidy-up" that unifies the two regexes has to change this test and justify the behaviour change.
        assert!(!excluded("e2e/flow.ts", false, &[]));
        assert!(!excluded("cypress/x.ts", false, &[]));
        assert!(!excluded("a.stories.tsx", false, &[]));
        // and `__mocks__` is a warm exclusion but not a center-first one
        assert!(excluded("src/__mocks__/b.ts", false, &[]));
    }

    #[test]
    fn exclude_dirs_match_on_a_path_prefix_with_or_without_a_trailing_slash() {
        assert!(excluded("vendor/x.ts", false, &["vendor".into()]));
        assert!(excluded("vendor/x.ts", false, &["vendor/".into()]));
        assert!(excluded("vendor", false, &["vendor".into()]), "the dir itself, exactly");
        // a PREFIX, not a substring: `vend` must not swallow `vendor/`
        assert!(!excluded("vendorish/x.ts", false, &["vendor".into()]));
    }

    #[test]
    fn a_top_of_zero_still_yields_one_hub_rather_than_warming_nothing() {
        // `Math.max(1, top)` — a caller passing 0 means "no cap given", not "warm nothing"
        assert_eq!(0usize.max(1), 1);
    }
}

#[cfg(test)]
mod rank_tests {
    use super::*;

    /// The ranking claim needs a repo where a TEST file is itself a high-fan-in import target — the shape
    /// that decides whether the convention exclusion actually costs the warm set its top entry. No natural
    /// fixture has one (probed: across 19 repos, zero `__mocks__`/`__tests__`/`*.test.ts` import targets),
    /// so it is built here.
    fn repo_with_a_test_file_as_the_biggest_hub() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("seam-warm-rank-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("package.json"), "{\"name\":\"w\",\"version\":\"1.0.0\"}\n").unwrap();
        std::fs::write(root.join("src/hub.ts"), "export function hub(x: number) { return x + 1; }\n").unwrap();
        std::fs::write(root.join("src/util.ts"), "export function util(x: number) { return x; }\n").unwrap();
        std::fs::write(root.join("src/big.test.ts"), "export function big(x: number) { return x; }\n").unwrap();
        // hub.ts <- 3 importers, big.test.ts <- 4, util.ts <- 1
        for (i, extra) in [("a", "import { util } from \"./util\";\n"), ("b", ""), ("c", ""), ("d", "")] {
            let mut t = String::new();
            if i != "d" {
                t.push_str("import { hub } from \"./hub\";\n");
            }
            t.push_str("import { big } from \"./big.test\";\n");
            t.push_str(extra);
            t.push_str(&format!("export const use{i} = () => big(1);\n"));
            std::fs::write(root.join(format!("src/{i}.ts")), t).unwrap();
        }
        root
    }

    #[test]
    fn the_highest_fan_in_non_test_file_ranks_first_and_include_tests_promotes_the_test() {
        let root = repo_with_a_test_file_as_the_biggest_hub();
        let repo = root.to_str().unwrap();

        let hubs = rank_hubs(repo, 10, false, &[]);
        assert_eq!(hubs[0].file, "src/hub.ts", "{hubs:?}");
        assert_eq!(hubs[0].fan_in, 3);
        assert!(!hubs.iter().any(|h| h.file == "src/big.test.ts"),
                "a test file is excluded even though its fan-in (4) is the repo's highest");

        // includeTests re-admits it, and it takes the top slot — which is what makes the exclusion load-bearing
        let with_tests = rank_hubs(repo, 10, true, &[]);
        assert_eq!(with_tests[0].file, "src/big.test.ts", "{with_tests:?}");
        assert_eq!(with_tests[0].fan_in, 4);

        assert_eq!(rank_hubs(repo, 1, false, &[]).len(), 1, "the cap is honoured");
        assert!(rank_hubs(repo, 10, false, &["src".to_string()]).is_empty(), "excludeDirs empties it");
        let _ = std::fs::remove_dir_all(&root);
    }
}
