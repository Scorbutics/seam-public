import type { ICache } from "./ICache";
import { PrismaRepo } from "./PrismaRepo";

// The anchor. Its dependency set contains a container-bound concrete impl (PrismaRepo) AND an interface
// type-ref (ICache) whose impls are bound — the two branches of the DI enrichment.
export class BookingService {
  constructor(private cache: ICache, private repo: PrismaRepo) {}
  confirm(id: string) {
    const hit = this.cache.get(id);
    return hit ?? this.repo.find(id);
  }
}
