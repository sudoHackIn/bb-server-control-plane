import { startBrowserApplication } from "./lib/browser-bootstrap";
import "./app.css";

let dispose: (() => void) | undefined;
void startBrowserApplication(
  async () => (await import("./native-main")).mountNativeApplication,
)
  .then((stop) => {
    dispose = stop;
  })
  .catch(() => {
    const root = document.getElementById("root");
    if (root)
      root.textContent =
        "Unable to verify your BB session. Reload to reconnect.";
  });

import.meta.hot?.dispose(() => dispose?.());
