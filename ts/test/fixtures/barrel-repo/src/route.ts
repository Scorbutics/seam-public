import { mapTasks } from "./service"

export async function GET(rows: string[]) {
  const a = mapTasks(rows, "me")
  const b = mapTasks(rows, "you")
  return a.concat(b)
}
