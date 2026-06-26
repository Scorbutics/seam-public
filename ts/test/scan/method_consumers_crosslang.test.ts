// REGRESSION — a class METHOD's callers must be discovered as consumers (the UP / "who uses it" footprint),
// across the typed/flat-call grammars. This is the bug behind a backend-anchored grow going DOWN (into the
// method's return-type / params) instead of UP (to its callers): anchored at `createBooking`, the grow had no
// upward frontier because the callers were invisible, so it followed the only thing left — a downstream data
// object. Three root causes, all here:
//   1. NAME extraction — `Booking createBooking(...)` returned the return TYPE ("Booking") not the method name,
//      because the positional scan grabbed the leading type_identifier. Fixed by reading the `name` FIELD.
//   2. CALL-SITE matching — Java `method_invocation` / Ruby `call` are FLAT (object/name are fields, no nested
//      member node), so the nested-shape matcher skipped every Java/Ruby method call. Fixed by `_callee` reading
//      the flat name/receiver fields.
//   3. METHOD vs FUNCTION — Ruby `def` / a C++ in-class body aren't in _METHOD_KINDS, so a class method was
//      mislabelled a plain function and the receiver-agnostic call-site pass never ran. Fixed by class-enclosure.
//
// Assert the STRUCTURAL contract (the caller appears in the UP footprint), not internal counters. Guards on
// tree-sitter — early-returns when absent so the offline .vsix / CI stays green.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "method-consumers-"));
  // JAVA — `Booking createBooking(...)` (return type precedes the name); two services call it via an injected
  // field `mBookingService.createBooking(...)` (flat method_invocation, receiver from DI).
  w("java/BookingBean.java", `package app;\nimport java.util.Map;\npublic class BookingBean {\n  private BookingRepository bookingRepository;\n  public Booking createBooking(final User user, final Map<String,Object> member) {\n    return bookingRepository.save(new BookingData(member));\n  }\n}\n`);
  w("java/BookingsService.java", `package app;\nimport java.util.Map;\npublic class BookingsService {\n  private BookingBean mBookingService;\n  public Booking create(User user, Map<String,Object> m) { return mBookingService.createBooking(user, m); }\n}\n`);
  w("java/AcmeCheckBookingsService.java", `package app;\nimport java.util.Map;\npublic class AcmeCheckBookingsService {\n  private BookingBean mBookingService;\n  public Booking make(User u, Map<String,Object> m) { return mBookingService.createBooking(u, m); }\n}\n`);
  // RUBY — `def create_booking` inside a bare `class` node (kind "class"); caller via `@booking_bean.create_booking`.
  w("ruby/booking_bean.rb", `class BookingBean\n  def create_booking(user, member)\n    @repo.save(BookingData.new(member))\n  end\nend\n`);
  w("ruby/bookings_service.rb", `class BookingsService\n  def create(user, member)\n    @booking_bean.create_booking(user, member)\n  end\nend\n`);
  // C++ — in-class inline method (a function_definition not in _METHOD_KINDS); caller via `b->createBooking(u)`.
  w("cpp/bean.cpp", `struct Booking {};\nclass BookingBean { public: Booking createBooking(int user) { return svc.save(user); } };\n`);
  w("cpp/service.cpp", `#include "bean.cpp"\nclass BookingsService { BookingBean* b; public: Booking create(int u) { return b->createBooking(u); } };\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

// the UP footprint's files, excluding the anchor file itself — "where is this method used".
const consumerFiles = async (file: string, symbol: string): Promise<string[]> => {
  const g = await build_footprint(REPO, file, symbol, { direction: "up" });
  return g.nodes.filter((n: any) => n.id !== "n1" && n.file && n.file !== file).map((n: any) => n.file as string);
};

describe("a class method's callers are discovered as consumers (cross-language)", () => {
  test("Java: createBooking's two service callers are reached (not just its return type)", async () => {
    if (!available()) return;
    const files = await consumerFiles("java/BookingBean.java", "createBooking");
    expect(files).toContain("java/BookingsService.java");
    expect(files).toContain("java/AcmeCheckBookingsService.java");
  });

  test("Ruby: create_booking's caller is reached (flat `call` node + `class`/`def` kinds)", async () => {
    if (!available()) return;
    const files = await consumerFiles("ruby/booking_bean.rb", "create_booking");
    expect(files).toContain("ruby/bookings_service.rb");
  });

  test("C++: createBooking's caller is reached (in-class method via `->`)", async () => {
    if (!available()) return;
    const files = await consumerFiles("cpp/bean.cpp", "createBooking");
    expect(files).toContain("cpp/service.cpp");
  });
});
