import { mapTasks } from "./facade"

export function deep(rows: string[]) { return mapTasks(rows, "deep") }
