import { createModule } from "./di";
import { DI_TOKENS } from "./tokens";
import { RealCache } from "../RealCache";
import { NoopCache } from "../NoopCache";
export const cacheModule = createModule();
cacheModule.bind(DI_TOKENS.CACHE).toFactory(() => {
  if (process.env.CACHE_URL && process.env.CACHE_TOKEN) {
    return new RealCache();
  }
  return new NoopCache();
}, "singleton");
