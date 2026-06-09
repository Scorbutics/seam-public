// A consumer in a TEST file → the `test` role (verification), not an in-footprint link.
import { makeWidget } from "@demo/lib/widget";

test("makes a widget", () => {
  makeWidget("t");
});
