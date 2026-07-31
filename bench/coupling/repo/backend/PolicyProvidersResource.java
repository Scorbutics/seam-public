package com.example.admin;

// DECOY. Its composed path is /admin/policies/providers/{id}, which shares the literal segment
// `providers` with the client's /{realm}/client-registration-policy/providers and NOTHING else.
// Seam matched exactly this pair on the real keycloak repo. A segment in common is not a route
// in common, and a matcher that links these is inventing a cross-stack edge.
@Path("/admin/policies")
public class PolicyProvidersResource {

  @GET
  @Path("/providers/{id}")
  public String provider() {
    return "{}";
  }
}
