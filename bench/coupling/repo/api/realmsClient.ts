// The admin client declares the COMPOSED path as a url-template, exactly as keycloak's
// keycloak-admin-client does (`path: "/{realm}/partial-export"`, expanded at call time by
// `url-template`). The literal never appears assembled anywhere else, so the only link to the
// Java resource is this route.
export const realmsClient = [
  { method: "POST", path: "/{realm}/partial-export" },
];

// The decoy's near-neighbour: shares only the trailing `providers` segment with
// PolicyProvidersResource. Different route, different resource, must not be linked.
export const policyClient = [
  { method: "GET", path: "/{realm}/client-registration-policy/providers" },
];
