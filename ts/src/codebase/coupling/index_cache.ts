// MOVED to core/ — the incremental per-file disk cache is GENERIC infra (it depends only on core/walk +
// core/progress), so it lives in core/resolve/index_cache.ts and is reused by core/resolve/consumers.ts (the
// reverse-import index) as well as the coupling floor and the DI impl-index. This re-export keeps the existing
// `coupling/index_cache` import sites working.
export { incrementalScan, incrementalScanAsync, indexCacheEnabled } from "../../core/resolve/index_cache.js";
