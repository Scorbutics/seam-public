// Used inside a CLASS METHOD → enclosing symbol = build (method), enclosing class = Svc.
import { makeWidget } from "@demo/lib/widget";

export class Svc {
  build() {
    return makeWidget("svc");
  }
}
