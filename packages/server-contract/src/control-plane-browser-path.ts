import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const project = /^\/projects\/[A-Za-z0-9_-]{1,200}$/u;
const thread =
  /^\/(?:projects\/[A-Za-z0-9_-]{1,200}\/)?threads\/[A-Za-z0-9_-]{1,200}$/u;
export function isControlPlaneBrowserShellPath(path: string) {
  return (
    path === "/control-plane/app" || project.test(path) || thread.test(path)
  );
}
export function getControlPlaneProjectPath(projectId: string) {
  return `/projects/${id.parse(projectId)}`;
}
export function getControlPlaneThreadPath(
  projectId: string,
  threadId: string,
  messageSeq?: number,
) {
  const path = `${getControlPlaneProjectPath(projectId)}/threads/${id.parse(threadId)}`;
  return messageSeq === undefined
    ? path
    : `${path}#msg=${z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(messageSeq)}`;
}
export function controlPlaneBrowserReturnTo(
  value: string | undefined,
  origin: string,
): string | null {
  if (value === undefined) return "/control-plane/app";
  if (value.length > 4096 || !value.startsWith("/") || value.startsWith("//"))
    return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !isControlPlaneBrowserShellPath(url.pathname))
      return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
