export function isPersonalBrowserUiPath(path: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return (
    isControlPlaneBrowserShellPath(path) ||
    /^\/assets\/[A-Za-z0-9_.-]+$/u.test(path) ||
    [
      "/favicon-32x32.png",
      "/favicon-16x16.png",
      "/apple-touch-icon.png",
      "/manifest.webmanifest",
    ].includes(path)
  );
}
import { isControlPlaneBrowserShellPath } from "@bb/server-contract";
