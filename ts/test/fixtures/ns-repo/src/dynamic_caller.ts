export async function useDynamicNs() {
  const api = await import("./index");
  return api.doThing();
}
