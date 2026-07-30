# barrel-repo — the three re-export mechanisms, one fixture

Built for the defect the `bench/oracle` sweep found and the CLI gate could not have caught: the module-anchored
reverse-import scan matched only imports resolving DIRECTLY to the anchor, so every consumer behind a barrel was
invisible — to the contract, to `afferent`, and to the module footprint every module-anchored shape sits on.

Every file here exists to make one mechanism the ONLY path to a number, so a regression drops that number:

| file | mechanism | why it is here |
|---|---|---|
| `src/service.ts` | named barrel + **renaming** barrel | forwards and calls nothing — its own call count is 0, which is why stopping here read as an undercount rather than an error |
| `src/facade.ts` | second hop | proves the walk is transitive, not one hardcoded level |
| `src/star.ts` | `export * from` | names nothing, so it cannot be an import ref at all. private-app has 0 of these; cal.com has 343 |
| `src/nsstar.ts` | `export * as ns from` | DELIBERATELY not a hop: it binds a namespace, so members are reached as `ns.member`. Following it would invent bindings no caller can write |
| `src/route.ts` | reached via one named barrel | 2 call sites, the exact private-app shape |
| `src/deep.ts` | reached via two named barrels | |
| `src/starcons.ts` | reached via the star barrel | |
| `src/both.ts` | reached BOTH ways, under two names | must be ONE consumer (the module graph makes one node per entry) while BOTH call sites count |
| `src/renamed.ts` | calls `renamedAway`, never `renamedOnly` | counting by the export name found 0 of 3 |
| `unusedByAnyone` | — | falsification: following barrels must not turn every export into a consumed one |
