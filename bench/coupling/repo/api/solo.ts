// DECOY. `SOLO_ONLY_FLAG` is read here and nowhere else in the repo, so it has no other side. A counterpart
// reported for it would mean the symmetric union is pairing a file with itself.
export function solo(): boolean {
  return process.env.SOLO_ONLY_FLAG === "1";
}
