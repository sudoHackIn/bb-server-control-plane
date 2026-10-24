import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { PersonalWorkspace } from "./components/control-plane/PersonalWorkspace";
import { fetchWithAppSurface } from "./lib/app-surface";
import { initializePreferredTheme } from "./hooks/useTheme";
import { applyAppFrameGeometry, getBbDesktopInfo } from "./lib/bb-desktop";
import { installPluginRuntime } from "./lib/plugin-frontend";

export function mountPersonalApplication(): () => void {
  installPluginRuntime();
  initializePreferredTheme();
  applyAppFrameGeometry(document.documentElement, getBbDesktopInfo());
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const client = createControlPlaneClient({
    origin: window.location.origin,
    fetch: fetchWithAppSurface,
  });
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing application root");
  const root = createRoot(element);
  root.render(
    <QueryClientProvider client={queries}>
      <BrowserRouter>
        <PersonalWorkspace client={client} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return () => {
    root.unmount();
    void queries.cancelQueries();
    queries.clear();
  };
}
