// def_treesitter: AST-grounded, language-agnostic def extraction (name + signature + enclosing + doc)
// across the five required languages — the cross-language counterpart to the TS/JS-tuned def_table regex.
import { describe, expect, test } from "bun:test";
import { defs_in_file_treesitter } from "../src/codebase/def_treesitter.js";

describe("def_treesitter cross-language extraction", () => {
  test("TypeScript: classes, methods (with enclosing), functions, const-arrows + doc", async () => {
    const SRC = `
/** Orchestrates the weekly run. */
export class MissionEngine {
  // builds one pass
  protected getPasses(): Pass[] { return []; }
}
export function weekTupleLE(a: number, b: number): boolean { return a <= b; }
const formatDate = (d: Date): string => d.toISOString();
`;
    const defs = (await defs_in_file_treesitter("svc/engine.ts", SRC))!;
    const by = (n: string) => defs.find((d) => d.name === n);
    expect(by("MissionEngine")?.kind).toBe("class");
    expect(by("MissionEngine")?.doc).toContain("Orchestrates the weekly run");
    expect(by("getPasses")?.enclosing).toBe("MissionEngine");
    expect(by("getPasses")?.doc).toContain("builds one pass");
    expect(by("weekTupleLE")?.kind).toBe("function");
    expect(by("formatDate")?.kind).toBe("function");   // const-arrow still captured (regex-floor parity)
  });

  test("Ruby: modules, classes, def methods + # doc — what the regex floor misses entirely", async () => {
    const SRC = `
module PSDK
  # the stderr logger
  class Logger
    # log an info line
    def info(msg)
      $stderr.puts(msg)
    end
  end
end
`;
    const defs = (await defs_in_file_treesitter("psdk/logger.rb", SRC))!;
    const by = (n: string) => defs.find((d) => d.name === n);
    expect(by("Logger")?.enclosing).toBe("PSDK");
    expect(by("info")?.kind).toBe("method");
    expect(by("info")?.enclosing).toBe("Logger");
    expect(by("info")?.doc).toContain("log an info line");   // `#` comment captured (regex couldn't)
  });

  test("C: free function name comes from the declarator, NOT a parameter name", async () => {
    const SRC = `
// log callback
static void on_log(LogListener* listener, const char* message) { }
int main(int argc, char** argv) { return 0; }
`;
    const defs = (await defs_in_file_treesitter("ext/example.c", SRC))!;
    const by = (n: string) => defs.find((d) => d.name === n);
    expect(by("on_log")?.kind).toBe("function");           // not "message" (the param)
    expect(by("on_log")?.doc).toContain("log callback");
    expect(by("main")).toBeDefined();                      // not "argv"
    expect(defs.find((d) => d.name === "message")).toBeUndefined();
  });

  test("Java: class + method declarations", async () => {
    const SRC = `
public final class Service {
  public boolean run(int n) { return true; }
}
`;
    const defs = (await defs_in_file_treesitter("Service.java", SRC))!;
    const by = (n: string) => defs.find((d) => d.name === n);
    expect(by("Service")?.kind).toBe("class");
    expect(by("run")?.enclosing).toBe("Service");
  });

  test("an unknown extension yields null so the caller falls back to the regex floor", async () => {
    expect(await defs_in_file_treesitter("notes.txt", "hello")).toBeNull();
  });
});
