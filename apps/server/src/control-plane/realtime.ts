import type { BbRealtimeSocket, BbRealtimeSocketFactory } from "@bb/sdk";
import type { NotificationHub } from "../ws/hub.js";
import {
  onClientSocketOpen,
  onClientSocketMessage,
  onClientSocketClose,
} from "../ws/client-protocol.js";
import { assertServiceRealtimePrincipal } from "./access.js";

export function createPrivateRealtime(hub: NotificationHub) {
  const clients = new Set<() => void>();
  let disposed = false;
  const websocket: BbRealtimeSocketFactory = () => {
    if (disposed) throw new Error("Private realtime transport is closed");
    assertServiceRealtimePrincipal();
    let state = 0;
    const close = () => {
      if (state === 3) return;
      state = 3;
      onClientSocketClose(hub, server);
      clients.delete(close);
      queueMicrotask(() => client.onclose?.());
    };
    const server = {
      send(data: string) {
        queueMicrotask(() => {
          if (state === 1) client.onmessage?.({ data });
        });
      },
      close() {
        close();
      },
    };
    const client: BbRealtimeSocket = {
      get readyState() {
        return state;
      },
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send(data) {
        if (state !== 1)
          throw new Error("Private realtime transport is not open");
        assertServiceRealtimePrincipal();
        onClientSocketMessage(hub, server, data);
      },
      close,
    };
    clients.add(close);
    queueMicrotask(() => {
      if (state !== 0) return;
      if (disposed) {
        close();
        return;
      }
      onClientSocketOpen(hub, server);
      state = 1;
      client.onopen?.();
    });
    return client;
  };
  return {
    websocket,
    close() {
      disposed = true;
      for (const close of clients) close();
    },
  };
}
