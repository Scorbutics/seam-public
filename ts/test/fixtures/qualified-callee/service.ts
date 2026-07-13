import { Helper } from "./helper.js";

export class Service {
  handle(req: string): void {
    Helper.doWork(req);
    Helper.persist(req);
    Helper.missingMethod(req);
  }
}
