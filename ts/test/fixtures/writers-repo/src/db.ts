// A query-builder client stub. The floor grounds the syntactic `.from('t').verb` shape, not this object.
export const supabase = {
  from(_t: string) {
    return {
      select: (_c: string) => ({ data: [] as any[] }),
      insert: (_r: any) => ({ data: null }),
      update: (_r: any) => ({ data: null }),
    };
  },
};
