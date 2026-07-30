import { renamedAway } from "./service"

export function r(n: number) { return renamedAway(n) + renamedAway(n + 1) + renamedAway(n + 2) }
