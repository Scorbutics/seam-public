export function go() {
  return client.functions.invoke("my-handler", { source: "plain-value" });
}
