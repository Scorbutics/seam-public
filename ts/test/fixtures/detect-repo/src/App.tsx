import { Widget } from "./Widget";
export function App() {
  const remove = (t) => {};
  const busy = false;
  return <Widget onDelete={remove} isLoading={busy} title="hi" />;
}
