import type { ICache } from "./ICache";
export class RealCache implements ICache { get(k: string) { return k; } }
