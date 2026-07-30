import { mapTasks } from "./decl"
import { mapTasks as viaBarrel } from "./service"

export function both(rows: string[]) { return mapTasks(rows, "x").concat(viaBarrel(rows, "y")) }
