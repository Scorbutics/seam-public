//! `locale_compare` — a faithful port of JS `String.prototype.localeCompare()` (default locale) for the ASCII
//! range that file paths and identifiers use. The shape projections sort their output with localeCompare, so
//! byte-identical output requires the SAME ordering — which is NOT codepoint order (it is case-insensitive at
//! the primary level, with a lowercase-before-uppercase tiebreak, and a DUCET punctuation order).
//!
//! Model: a two-level collation. Primary = case-folded rank in the order JSC reports (extracted empirically);
//! tertiary = case (lowercase < uppercase). Compare the whole primary sequence first; only on a full primary
//! tie compare the tertiary sequence. Validated against bun/JSC on 200k random path/identifier pairs with
//! ZERO mismatches (and no distinct-but-equal cases). Non-ASCII falls back to codepoint order (unused on the
//! ASCII corpora; revisit if a non-ASCII repo needs it).

use once_cell::sync::Lazy;
use std::cmp::Ordering;
use std::collections::HashMap;

// The case-folded primary order JSC uses (letters folded to one rank each). Derived by sorting every ASCII
// char via localeCompare and folding case pairs.
const PRIMARY_ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

static PRIMARY_RANK: Lazy<HashMap<char, u32>> = Lazy::new(|| PRIMARY_ORDER.chars().enumerate().map(|(i, c)| (c, i as u32)).collect());

fn keys(s: &str) -> (Vec<u32>, Vec<u8>) {
    let mut primary = Vec::with_capacity(s.len());
    let mut tertiary = Vec::with_capacity(s.len());
    for ch in s.chars() {
        let folded = ch.to_ascii_lowercase();
        // Non-ASCII (or any char outside the table) → a high, codepoint-ordered weight; ASCII covers the corpus.
        primary.push(PRIMARY_RANK.get(&folded).copied().unwrap_or(1000 + ch as u32));
        tertiary.push(u8::from(ch.is_ascii_uppercase()));
    }
    (primary, tertiary)
}

/// Compare two strings the way JS `a.localeCompare(b)` (default locale) does, for ASCII text.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let (pa, ta) = keys(a);
    let (pb, tb) = keys(b);
    pa.cmp(&pb).then_with(|| ta.cmp(&tb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_jsc_orderings() {
        // case-insensitive primary, lowercase-first tiebreak
        assert_eq!(locale_compare("aB", "Ab"), Ordering::Less);
        // underscore < digit < letter at a diverging position
        assert_eq!(locale_compare("foo_bar", "Foo2"), Ordering::Less);
        assert_eq!(locale_compare("Foo2", "fooBar"), Ordering::Less);
        // punctuation order _ < - < .
        assert_eq!(locale_compare("a_b", "a-b"), Ordering::Less);
        assert_eq!(locale_compare("a-b", "a.b"), Ordering::Less);
        // prefix sorts before the longer string
        assert_eq!(locale_compare("foo", "foobar"), Ordering::Less);
    }

    #[test]
    fn sorts_a_vector_like_jsc() {
        let mut v = vec!["Foo", "abc", "ABC", "_helper", "foo_bar", "Foo2", "fooBar"];
        v.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(v, vec!["_helper", "abc", "ABC", "Foo", "foo_bar", "Foo2", "fooBar"]);
    }
}
