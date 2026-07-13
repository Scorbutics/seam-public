export class Helper {
  static doWork(x: string): void { console.log(x); }
  static persist(y: string): void { Store.write(y); }
}
export class Store {
  static write(v: string): void { /* db write */ }
}
