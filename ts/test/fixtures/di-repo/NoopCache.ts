import type { ICache } from "./ICache";
export class NoopCache implements ICache { get(_k: string) { return null; } }
