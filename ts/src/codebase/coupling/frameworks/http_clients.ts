// FRAMEWORK REGISTRY — HTTP CLIENT vocabulary (the consumer half of the http-route boundary). A call
// `<client>("/path")` / `<client>.<verb>("/path")` is an HTTP-route CONSUMER. The client NAMES were baked into a
// regex in http_route.ts; they live here now as data so the community adds a client (got/wretch/superagent/a
// custom wrapper) by adding a row — no engine edit (Phase 2 loads rows from a config file). The structural match
// (a string-literal path arg) is generic; only WHICH receiver names count is per-ecosystem. Keep this SMALL.
export interface HttpClient {
  name: string;          // the receiver token as WRITTEN — `fetch`, `axios`, `$http`, `this.$http` uses the bare `$http`
  verbForms?: boolean;   // true if it's called as `<name>.<verb>(...)` too (axios.get / $http.post), not only `<name>(...)`
  framework?: string;    // provenance label (nuxt/angularjs/axios/…) — docs only
}

// Built-in catalogue: the browser `fetch`, Nuxt `$fetch`/`useFetch`, AngularJS/Vue-resource `$http`/`$resource`,
// a bare `request`, and the verb-form clients axios/ky. (A CUSTOM axios/ky INSTANCE — `const api =
// axios.create(); api.get()` — has an arbitrary receiver name and is the LLM/effect-inference tier's job.)
export const HTTP_CLIENTS: HttpClient[] = [
  { name: "fetch",     framework: "web" },
  { name: "$fetch",    framework: "nuxt" },
  { name: "useFetch",  framework: "nuxt" },
  { name: "$http",     verbForms: true, framework: "angularjs" },
  { name: "$resource", framework: "angularjs" },
  { name: "request",   framework: "generic" },
  { name: "axios",     verbForms: true, framework: "axios" },
  { name: "ky",        verbForms: true, framework: "ky" },
];

let _extra: HttpClient[] = [];
export function registerHttpClients(cs: HttpClient[]): void { _extra = _extra.concat(cs.filter((c) => c && typeof c.name === "string")); _re = null; }
export function _resetHttpClients(): void { _extra = []; _re = null; }

const _esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let _re: RegExp | null = null;
// The FETCH-CALL matcher, built from the registry: `(?<![\w$])(?:<clients>)\s*\(\s*["'`]<captured path>`. A
// verb-form client also matches `<name>.<verb>`. Cached; rebuilt when the registry changes. The `g` flag means
// callers reset `.lastIndex` before use (single-threaded per scan, as the old module-const regex was used).
function _build(): RegExp {
  const alt = [...HTTP_CLIENTS, ..._extra].map((c) => _esc(c.name) + (c.verbForms ? "(?:\\.\\w+)?" : "")).join("|");
  return new RegExp("(?<![\\w$])(?:" + alt + ")\\s*\\(\\s*[`'\"]([^`'\"]*)", "g");
}
export function httpClientCallRegex(): RegExp { return (_re ??= _build()); }
