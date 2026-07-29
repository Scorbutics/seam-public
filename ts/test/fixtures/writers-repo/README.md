A reader and TWO writers of the same DB table, so `--query writers` (reverse data-coupling) has something to
answer. Measured before this existed: no fixture in the repo yielded a non-empty writers set — booking-app has
a shared key with zero counterpart sites — so that query shape sat outside the CLI gate's guarantee while its
case looked covered ("it reads no resolvable DB table").
