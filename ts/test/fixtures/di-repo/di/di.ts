// container stubs — the grammar the binding scanner matches on, not a real DI runtime
export function createModule(): any { return { bind: (_t: any) => ({ toFactory: (_f: any, _s?: string) => {}, toClass: (_c: any, _d?: any[]) => {} }) }; }
export function bindModuleToClassOnToken(_o: any): any { return () => {}; }
