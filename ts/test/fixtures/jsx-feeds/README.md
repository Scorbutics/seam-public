JSX corpus for the consumer-feeds differential (`rust/parity/feeds.ts`).

The repo's own sources contain almost no JSX, so the harness run over `ts/src` reported
`255 ok / 0 bad (non-empty 1)` — thousands of agreements about nothing, the same shape as the
`httpcalls.ts` harness that sat green while comparing empty against empty. These files exist so the
comparison has something to compare: expression attributes (braces unwrapped), string attributes
(quotes kept), BARE attributes (value "true", no value position), member-expression and lowercase
tags that must NOT match, spreads, duplicate props, and a nested occurrence.
