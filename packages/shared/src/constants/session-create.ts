// Session creation is a two-sided deadline contract. The proxy must finish startup and
// respond before its deadline; the browser waits a little longer so the failure response
// can cross the relay instead of racing an equal local timeout.
export const SESSION_CREATE_SERVER_DEADLINE_MS = 30_000;
export const SESSION_CREATE_RESPONSE_GRACE_MS = 5_000;
export const SESSION_CREATE_CLIENT_TIMEOUT_MS =
  SESSION_CREATE_SERVER_DEADLINE_MS + SESSION_CREATE_RESPONSE_GRACE_MS;
