// In-process authority capability. A Symbol cannot be supplied through JSON,
// model tool arguments or HTTP parameters; only trusted server-side code that
// imports this module can attach it.
export const INTERNAL_AUTHORITY = Symbol("mneme.internalAuthority");
