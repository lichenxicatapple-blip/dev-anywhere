export function createApprovalRequestIdFactory(
  scope: string,
  now: () => number = Date.now,
): () => string {
  let seq = 0;
  return () => `${scope}-${now()}-${seq++}`;
}

export function createScopedApprovalRequestIdFactory(
  now: () => number = Date.now,
): (scope: string) => string {
  let seq = 0;
  return (scope: string) => `${scope}-${now()}-${seq++}`;
}
