// Minimal query-builder client stub (Supabase-shaped `client.from(table).verb(...)`). The deterministic
// db-table coupling floor recognises this syntax, so the fixture's DB crossings are grounded offline.
export const client = {
  from(_table: string) {
    return {
      select: (_q?: any): any[] => [],
      insert: (_row?: any): { id: string } => ({ id: "b1" }),
    };
  },
};
