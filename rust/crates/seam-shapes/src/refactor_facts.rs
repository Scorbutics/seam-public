//! COMPOSITION — the "refactor facts" bundle. "How to refactor X" splits into FACTS (structural) and a
//! PLAN (judgement). The plan is the LLM's; this gathers the FACTS in one call so the model has the whole
//! structural picture before planning a change to X:
//!   impact       — the transitive blast radius (what breaks if X changes), the safety net
//!   dependencies — what X uses (to preserve / rewire)
//!   contract     — X's module boundary (what it promises + its outbound deps)
//! NOT a new analysis — just the existing shapes, composed. Port of grow/refactor_facts.ts.

use crate::contract::{project_contract, ModuleContract};
use crate::impact::{project_impact, Impact, ImpactOpts};
use crate::project_set::{project_dependency_set, ConsumerSet};
use seam_scan::build_footprint;

pub struct RefactorFacts {
    pub shape: String, // "refactor"
    pub anchor_symbol: String,
    pub anchor_file: String,
    pub impact: Impact,
    pub dependencies: ConsumerSet,
    pub contract: ModuleContract,
}

pub fn gather_refactor_facts(repo: &str, anchor_file: &str, symbol: &str) -> RefactorFacts {
    let impact = project_impact(repo, anchor_file, symbol, &ImpactOpts::default());
    let dependencies = match build_footprint(repo, anchor_file, Some(symbol), "down", false) {
        Some(g) => project_dependency_set(&g),
        // THE FOOTPRINT COULD NOT BE BUILT AT ALL — unreadable file, unparseable language, symbol not found.
        // This branch used to report `reason: "none"` with `resolution_quality: "FULL"`, i.e. `--query refactor`
        // answered "resolution: FULL | resolved: 0 dependency edges" when the analysis had never run. That is a
        // stronger overclaim than the empty-set one it shares a crate with: there the scan ran and found
        // nothing; here there was no scan. `unavailable` → UNKNOWN says so.
        None => ConsumerSet {
            shape: "deps".to_string(),
            anchor_symbol: symbol.to_string(),
            anchor_file: anchor_file.to_string(),
            members: Vec::new(),
            unresolved: Vec::new(),
            recalled: Vec::new(),
            no_structure: true,
            reason: Some("unavailable".to_string()),
            resolution_quality: crate::project_set::quality_for(true, Some("unavailable")).to_string(),
        },
    };
    let contract = project_contract(repo, anchor_file);
    RefactorFacts {
        shape: "refactor".to_string(),
        anchor_symbol: symbol.to_string(),
        anchor_file: anchor_file.to_string(),
        impact,
        dependencies,
        contract,
    }
}
