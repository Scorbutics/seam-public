import { IRepo } from "./repo";
export function service(repo: IRepo) {
  const u = repo.fetchUser("1");
  repo.saveUser(u);
}
