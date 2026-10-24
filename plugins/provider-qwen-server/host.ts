import { createQwenBridge } from "./src/bridge.js";
import { serverQuery } from "./src/server-query.js";
export const experimental_providerBridge = createQwenBridge({
  queryFactory: serverQuery,
});
