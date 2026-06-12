export function dispatcher(bus: any) {
  bus.invoke("process-payment");
  return true;
}
