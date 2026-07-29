A minimal ioctopus-shaped DI surface. Exists so the CLI snapshot gate covers the DI-BINDING ENRICHMENT on
`--query dependencies` (default-on via SEAM_DI_RESOLVE). Measured: the gate already ran that query, but only
against route-repo, where the answer is "none resolved — a leaf" — so the enrichment loop never iterated and
the whole DI code path sat outside the guarantee while looking covered.
