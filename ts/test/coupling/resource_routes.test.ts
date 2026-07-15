// CLASS-BASE-ROUTE inheritance (resource_routes.ts) — the consumer-side mirror of the sub-resource composer.
// An SDK resource class declares its route base path once (constructor `super({path})`), and each request
// method (`create = this.makeRequest({method})`) inherits it. Coupling keys are attributed span-locally, so
// without this the method node carries no route and its cross-stack crossing never materialises. We assert the
// resolver stamps each method's FULL route AT ITS OWN LINE (base ⊕ the method's own path) — offline, no LLM.
import { describe, expect, test } from "bun:test";
import { resolveResourceRoutes } from "../../src/codebase/coupling/resource_routes.js";

const USERS = `export class Users extends Resource<{ realm?: string }> {
  public find = this.makeRequest<UserQuery, UserRepresentation[]>({
    method: "GET",
  });

  public create = this.makeRequest<UserRepresentation, { id: string }>({
    method: "POST",
  });

  public findOne = this.makeRequest<{ id: string }, UserRepresentation>({
    method: "GET",
    path: "/{id}",
  });

  constructor(client: KeycloakAdminClient) {
    super(client, {
      path: "/admin/realms/{realm}/users",
      getUrlParams: () => ({ realm: client.realmName }),
    });
  }
}
`;

describe("resource_routes — class-base-route inheritance", () => {
  test("a bare request method inherits the class base path AT ITS OWN LINE", () => {
    const hits = resolveResourceRoutes("resources/users.ts", USERS);
    const create = hits.find((h) => h.value === "/admin/realms/*/users" && h.method === "POST");
    expect(create).toBeTruthy();
    // the route is stamped at the `create` member line (line index 5), NOT the constructor's `path:` line — so
    // the footprint's `create` method node (its own span) owns the crossing to the backend handler.
    expect(create!.line).toBe(5);
    expect(create!.produces).toBe(false);   // the SDK method is a route CONSUMER (it calls the backend)
  });

  test("a method with its OWN path composes base ⊕ own", () => {
    const hits = resolveResourceRoutes("resources/users.ts", USERS);
    expect(hits.some((h) => h.value === "/admin/realms/*/users/*" && h.method === "GET")).toBe(true);   // findOne: base + /{id}
  });

  test("a file with no base-path resource class yields nothing", () => {
    expect(resolveResourceRoutes("util.ts", "export const x = () => fetch('/api/thing');\n")).toEqual([]);
    // no `super({path})` / base field → not a resource class, even though it makes an HTTP call.
    expect(resolveResourceRoutes("r.ts", "class R { m = this.makeRequest({ method: 'GET' }); }")).toEqual([]);
  });

  test("only .ts/.js files are scanned", () => {
    expect(resolveResourceRoutes("resources/users.py", USERS)).toEqual([]);
  });
});
