package com.example.admin;

// JAX-RS SPLIT PATH — the shape that made the flagship cross-language claim miss on keycloak.
// The route this method serves is NOT the string on the method: it is the class-level @Path
// concatenated with the method-level one. Reading either half alone finds a path that exists
// nowhere in the client, which is why the real keycloak `partial-export` pair went unlinked.
@Path("/admin/realms/{realm}")
public class RealmAdminResource {

  @GET
  @Path("partial-export")
  public String partialExport() {
    return "{}";
  }
}
