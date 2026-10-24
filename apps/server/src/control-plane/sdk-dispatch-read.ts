import { AsyncLocalStorage } from "node:async_hooks";
import { requireControlPlaneThreadDispatch, type DbConnection } from "@bb/db";

type Scope = {
  db: DbConnection;
  threadId: string;
  pluginId: string;
  running: () => Response;
};
const scopes = new AsyncLocalStorage<Scope>();
export function withControlPlaneDispatchRead<T>(scope: Scope, run: () => T): T {
  return scopes.run(scope, run);
}
export function dispatchControlPlaneDispatchRead(
  userId: string,
  request: Request,
): Response | null {
  const scope = scopes.getStore();
  const url = new URL(request.url);
  if (
    !scope ||
    scope.pluginId !== "concurrency-limit" ||
    request.method !== "GET" ||
    url.pathname !== "/api/v1/threads/running" ||
    url.search !== ""
  )
    return null;
  const context = requireControlPlaneThreadDispatch(scope.db, scope.threadId);
  if (context?.user.id !== userId) return null;
  return scope.running();
}
