// Reaches the Java controller ONLY over the route literal. No import, no call edge.
export function TechnicianPanel($http: any) {
  return $http.get("/api/technicians").then((r: any) => r.data);
}
