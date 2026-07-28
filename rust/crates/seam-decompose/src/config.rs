//! RENDER tunables — the caps that shape the emitted seam map. Port of `RENDER` in
//! `ts/src/codebase/config.ts`, and now its single source.
//!
//! All five live here even though only three are read by the ported passes so far. Defining half of them
//! here and leaving half as TypeScript literals is the drift this crate exists to avoid: the value that
//! DECIDES a cap and the value a renderer EXCLUDES by must be the same number, and two copies of it are a
//! silent disagreement waiting for someone to edit one.

/// A seam with more inline call-sites than this is a guard/policy fan → cap + summarise.
pub const FAN_CAP: usize = 8;
/// Max OFF-tier seams shown before collapsing the rest.
pub const OFF_CAP: usize = 8;
/// Max terminals surfaced.
pub const TERMINAL_CAP: usize = 12;
/// Max blindspots emitted.
pub const BLINDSPOT_CAP: usize = 50;
/// A wide import-only fan with at least this many consumers reads as a policy, not a flow.
pub const POLICY_MIN_CONSUMERS: usize = 8;

/// The tunables as sorted `[key, value]` rows. Rows, not a map: a `HashMap` crossing napi leaks Rust's hash
/// iteration order into the JS object's key order.
pub fn tunables() -> Vec<Vec<String>> {
    [
        ("blindspotCap", BLINDSPOT_CAP),
        ("fanCap", FAN_CAP),
        ("offCap", OFF_CAP),
        ("policyMinConsumers", POLICY_MIN_CONSUMERS),
        ("terminalCap", TERMINAL_CAP),
    ]
    .iter()
    .map(|(k, v)| vec![k.to_string(), v.to_string()])
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunables_are_sorted_and_cover_every_constant() {
        let rows = tunables();
        let keys: Vec<&str> = rows.iter().map(|r| r[0].as_str()).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "rows must be key-sorted so the wire order is stable");
        assert_eq!(rows.len(), 5, "a new RENDER constant must be added to tunables() too");
    }
}
