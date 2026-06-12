export interface IRepo {
  fetchUser(id: string): any;
  saveUser(u: any): void;
}
