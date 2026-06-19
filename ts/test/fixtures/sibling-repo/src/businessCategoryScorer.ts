import { Scorer } from "./scorer";
// The anchor: one concrete scorer in the family.
export class BusinessCategoryScorer extends Scorer {
  score(ctx: number): number { return ctx * 2; }
}
