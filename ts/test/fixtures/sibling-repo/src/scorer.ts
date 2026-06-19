// Abstract base whose `score` is overridden by each concrete scorer.
export abstract class Scorer {
  abstract score(ctx: number): number;
}
