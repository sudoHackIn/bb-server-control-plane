import {
  activeBrowserIdentity,
  activeBrowserSessionEpoch,
} from "./account-storage";
import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_HEADER_NAME,
  APP_SURFACE_WEB,
  type RequestAppSurface,
} from "@bb/config/app-surface";
import { isInsideNativeShell } from "@/lib/native-shell";

const APP_SURFACE_MOBILE: RequestAppSurface = "mobile";

export function getAppSurface(): RequestAppSurface {
  if (typeof window !== "undefined" && window.bbDesktop !== undefined) {
    return APP_SURFACE_DESKTOP;
  }
  if (isInsideNativeShell()) {
    return APP_SURFACE_MOBILE;
  }
  return APP_SURFACE_WEB;
}

export function appSurfaceRequestInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(APP_SURFACE_HEADER_NAME, getAppSurface());
  return {
    ...init,
    cache: init?.cache ?? "no-store",
    headers,
  };
}

export function fetchWithAppSurface(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): ReturnType<typeof fetch> {
  const request = appSurfaceRequestInit(init);
  const identity = activeBrowserIdentity();
  if (identity && typeof window !== "undefined") {
    const url = new URL(
      typeof input !== "string" && "url" in input
        ? input.url
        : input.toString(),
      window.location.origin,
    );
    if (url.origin === window.location.origin) {
      const headers = new Headers(request.headers);
      headers.set("x-bb-client-identity", encodeURIComponent(identity));
      const epoch = activeBrowserSessionEpoch();
      if (epoch) headers.set("x-bb-client-session", epoch);
      request.headers = headers;
    }
  }
  return fetch(input, request);
}
