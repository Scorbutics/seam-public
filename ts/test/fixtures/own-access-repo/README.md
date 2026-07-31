# own-access-repo — the anchor's OWN access sites

Shaped after the cal.com case that exposed the defect (bench/grep-vs-seam, cal-booking-flow, 2026-07-31):
`--query coupling` on `createBooking` printed `db-table "booking" — anchor writes` above 241 counterpart
citations and never cited the anchor's own file. The write it was describing was one line inside it.

Two things this fixture must hold that a simpler one would not:

1. **A TRANSACTION-ALIAS receiver.** The real write is `tx.booking.create(...)`, not `prisma.booking.create(...)`.
   `saveBooking` here does the same, so a site-rendering pass that matched a literal `prisma.` receiver would
   show nothing for the very line the shape exists to point at.
2. **Both roles on ONE key, in one anchor.** `bookings` is read at one line and written at two others, so
   `anchorRole: "reads+writes"` has to resolve to three distinct sites with per-site roles — a renderer that
   copied the KEY's role onto every site would look correct until exactly this shape.

`otherReader.ts` supplies the far side, so the near-side assertions cannot pass merely because the key has no
counterparts.
