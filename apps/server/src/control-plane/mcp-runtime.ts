import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  controlPlaneMcpConnectors as connectors,
  controlPlaneMcpConnections as connections,
  controlPlaneMcpToolBindings as bindings,
  controlPlaneMcpCredentialMetadata,
  requireControlPlaneMcpConnector,
  requireControlPlaneThreadDispatch,
  type DbConnection,
} from "@bb/db";
import {
  jsonValueSchema,
  type JsonValue,
  type DynamicTool,
  type ToolCallResponse,
} from "@bb/domain";
import { createControlPlaneMcpCredentials } from "./mcp-credentials.js";
import { allowsProjectMcp, isProjectMcpTool } from "./mcp-policy.js";
import { assertControlPlaneDaemonRequest } from "./daemon-request-authority.js";
import { assertExecutionAdmission } from "../services/system/execution-admission.js";
import { ApiError } from "../errors.js";

const definitionSchema = ToolSchema;
const budgets = new WeakMap<
  DbConnection,
  { all: number; users: Map<string, number> }
>();
function validator(schema: z.output<typeof ToolSchema>["inputSchema"]) {
  if (schema["$async"]) throw fail();
  const version = schema["$schema"];
  const options = { strict: false, allErrors: false, validateFormats: false };
  const compiler =
    typeof version === "string" && /draft-0?7/u.test(version)
      ? new Ajv(options)
      : new Ajv2020(options);
  return compiler.compile(schema);
}
const fail = () =>
  new ApiError(
    409,
    "project_mcp_unavailable",
    "Project MCP configuration or authority changed; check the connection and restart the session",
  );
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: JsonValue) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value))
    return value.some((item) => containsSecret(item, secret));
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) => key.includes(secret) || containsSecret(item, secret),
    );
  return false;
}
function authority(db: DbConnection, threadId: string, connectionId: string) {
  assertExecutionAdmission(db);
  const context = requireControlPlaneThreadDispatch(db, threadId);
  const connection = db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (
    !context ||
    !connection?.enabled ||
    connection.projectId !== context.project.projectId
  )
    throw fail();
  const connector = requireControlPlaneMcpConnector(
    db,
    context.user.id,
    connection.connectorId,
    connection.connectorRevision,
  );
  if (!allowsProjectMcp(context.profileVersion.definition, connector.slug))
    throw fail();
  const credential = controlPlaneMcpCredentialMetadata(
    db,
    context.user.id,
    connector.id,
  );
  if (
    !credential.configured ||
    credential.connectorRevision !== connector.revision
  )
    throw fail();
  return { context, connection, connector, credential };
}
function identity(value: ReturnType<typeof authority>) {
  return JSON.stringify([
    value.context.user.id,
    value.context.thread.id,
    value.context.thread.environmentId,
    value.context.profileVersion.id,
    value.context.project.cwd,
    value.connector.id,
    value.connector.endpoint,
    value.connection.id,
    value.connection.revision,
    value.connector.revision,
    value.credential.revision,
  ]);
}
async function remote<T>(
  db: DbConnection,
  dataDir: string,
  threadId: string,
  connectionId: string,
  run: (
    client: Client,
    token: string,
    check: () => void,
    signal: AbortSignal,
  ) => Promise<T>,
  outer?: AbortSignal,
  extraCheck: () => void = () => {},
) {
  const original = authority(db, threadId, connectionId);
  const snapshot = identity(original);
  const check = () => {
    extraCheck();
    if (identity(authority(db, threadId, connectionId)) !== snapshot)
      throw fail();
  };
  let budget = budgets.get(db);
  if (!budget) {
    budget = { all: 0, users: new Map() };
    budgets.set(db, budget);
  }
  const userId = original.context.user.id;
  if (budget.all >= 16 || (budget.users.get(userId) ?? 0) >= 4) throw fail();
  budget.all++;
  budget.users.set(userId, (budget.users.get(userId) ?? 0) + 1);
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(30000),
    ...(outer ? [outer] : []),
  ]);
  const poll = setInterval(() => {
    try {
      check();
    } catch {
      controller.abort();
    }
  }, 250);
  const client = new Client(
    { name: "bb-project-mcp", version: "0.1.0" },
    { capabilities: {} },
  );
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    const token = await createControlPlaneMcpCredentials(db, dataDir).resolve(
      userId,
      original.connector.id,
      original.connector.revision,
    );
    check();
    const endpoint = new URL(original.connector.endpoint);
    transport = new StreamableHTTPClientTransport(endpoint, {
      redirectPolicy: "follow",
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 0,
        initialReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        check();
        signal.throwIfAborted();
        const url = new URL(input.toString());
        const method = init?.method ?? "GET";
        if (url.href !== endpoint.href) throw fail();
        if (method === "GET") return new Response(null, { status: 405 });
        if (!["POST", "DELETE"].includes(method)) throw fail();
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        const response = await fetch(url, {
          ...init,
          method,
          headers,
          credentials: "omit",
          redirect: "manual",
          signal: AbortSignal.any([
            signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw fail();
        }
        if (!response.body) return response;
        let size = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, target) {
              size += chunk.byteLength;
              if (size > 1048576) {
                controller.abort();
                throw fail();
              }
              target.enqueue(chunk);
            },
          }),
        );
        const copied = new Headers(response.headers);
        copied.delete("content-length");
        copied.delete("content-encoding");
        return new Response(body, { status: response.status, headers: copied });
      },
    });
    await client.connect(transport, { signal, timeout: 30000 });
    check();
    const result = await run(client, token, check, signal);
    check();
    signal.throwIfAborted();
    return result;
  } catch {
    throw fail();
  } finally {
    clearInterval(poll);
    if (transport) {
      try {
        await transport.terminateSession();
      } catch {}
    }
    controller.abort();
    await client.close().catch(() => {});
    budget.all--;
    const left = (budget.users.get(userId) ?? 1) - 1;
    if (left) budget.users.set(userId, left);
    else budget.users.delete(userId);
  }
}
async function list(client: Client, token: string, signal: AbortSignal) {
  const found: z.output<typeof ToolSchema>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      signal,
      timeout: 30000,
    });
    if (containsSecret(result, token)) throw fail();
    for (const value of result.tools) {
      const tool = definitionSchema.parse(value);
      if (
        Buffer.byteLength(JSON.stringify(tool)) > 32768 ||
        found.some((entry) => entry.name === tool.name)
      )
        throw fail();
      found.push(tool);
      if (found.length > 128) throw fail();
    }
    cursor = result.nextCursor;
    if (!cursor) return found;
  }
  throw fail();
}
export async function resolveProjectMcpTools(
  db: DbConnection,
  dataDir: string,
  threadId: string,
): Promise<DynamicTool[]> {
  const context = requireControlPlaneThreadDispatch(db, threadId);
  if (!context?.profileVersion.definition.mcpServers.includes("project"))
    return [];
  const rows = db
    .select({ id: connections.id, slug: connectors.slug })
    .from(connections)
    .innerJoin(connectors, eq(connectors.id, connections.connectorId))
    .where(
      and(
        eq(connections.projectId, context.project.projectId),
        eq(connections.enabled, true),
      ),
    )
    .limit(17)
    .all();
  if (rows.length > 16) throw fail();
  const tools: DynamicTool[] = [];
  const snapshots: Array<{ connectionId: string; identity: string }> = [];
  for (const row of rows) {
    if (!allowsProjectMcp(context.profileVersion.definition, row.slug))
      continue;
    const initial = authority(db, threadId, row.id);
    snapshots.push({ connectionId: row.id, identity: identity(initial) });
    await remote(
      db,
      dataDir,
      threadId,
      row.id,
      async (client, token, check, signal) => {
        for (const tool of await list(client, token, signal)) {
          if (
            !allowsProjectMcp(
              initial.context.profileVersion.definition,
              initial.connector.slug,
              tool.name,
            )
          )
            continue;
          validator(tool.inputSchema);
          const definition = jsonValueSchema.parse(tool);
          const name = `project_mcp_${hash(jsonValueSchema.parse([threadId, initial.context.profileVersion.id, row.id, initial.connection.revision, initial.credential.revision, definition])).slice(0, 40)}`;
          check();
          db.insert(bindings)
            .values({
              threadId,
              name,
              connectionId: row.id,
              connectionRevision: initial.connection.revision,
              connectorRevision: initial.connector.revision,
              credentialRevision: initial.credential.revision,
              profileVersionId: initial.context.profileVersion.id,
              definition,
              createdAt: Date.now(),
            })
            .onConflictDoNothing()
            .run();
          tools.push({
            name,
            description: `Project MCP ${initial.connector.slug}: ${tool.description ?? tool.name}`,
            inputSchema: tool.inputSchema,
          });
          if (tools.length > 128) throw fail();
        }
      },
    );
  }
  for (const snapshot of snapshots) {
    if (
      identity(authority(db, threadId, snapshot.connectionId)) !==
      snapshot.identity
    )
      throw fail();
  }
  return tools;
}
export async function invokeProjectMcpTool(
  db: DbConnection,
  dataDir: string,
  request: {
    threadId: string;
    turnId: string | null;
    providerThreadId: string;
    tool: string;
    arguments?: unknown;
  },
  signal: AbortSignal,
): Promise<ToolCallResponse> {
  try {
    if (
      !isProjectMcpTool(request.tool) ||
      Buffer.byteLength(JSON.stringify(request.arguments ?? {})) > 65536
    )
      throw fail();
    const binding = db
      .select()
      .from(bindings)
      .where(
        and(
          eq(bindings.threadId, request.threadId),
          eq(bindings.name, request.tool),
        ),
      )
      .get();
    if (!binding) throw fail();
    const definition = definitionSchema.parse(binding.definition);
    const check = () => {
      assertControlPlaneDaemonRequest(db, request);
      const current = authority(db, request.threadId, binding.connectionId);
      if (
        current.connection.revision !== binding.connectionRevision ||
        current.connector.revision !== binding.connectorRevision ||
        current.credential.revision !== binding.credentialRevision ||
        current.context.profileVersion.id !== binding.profileVersionId ||
        !allowsProjectMcp(
          current.context.profileVersion.definition,
          current.connector.slug,
          definition.name,
        )
      )
        throw fail();
      if (
        !db
          .select({ name: bindings.name })
          .from(bindings)
          .where(
            and(
              eq(bindings.threadId, request.threadId),
              eq(bindings.name, request.tool),
            ),
          )
          .get()
      )
        throw fail();
    };
    check();
    const args = z
      .record(z.string(), jsonValueSchema)
      .parse(request.arguments ?? {});
    if (!validator(definition.inputSchema)(args)) throw fail();
    const result = await remote<ToolCallResponse>(
      db,
      dataDir,
      request.threadId,
      binding.connectionId,
      async (client, token, validate, remoteSignal) => {
        const current = (await list(client, token, remoteSignal)).find(
          (tool) => tool.name === definition.name,
        );
        if (
          !current ||
          hash(jsonValueSchema.parse(current)) !==
            hash(jsonValueSchema.parse(definition))
        )
          throw fail();
        validate();
        const result = await client.callTool(
          { name: definition.name, arguments: args },
          undefined,
          { signal: remoteSignal, timeout: 30000 },
        );
        validate();
        if (containsSecret(result, token)) throw fail();
        return {
          success: result.isError !== true,
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
        };
      },
      signal,
      check,
    );
    check();
    return result;
  } catch {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Project MCP tool unavailable or not authorized; check the connection and restart the session",
        },
      ],
    };
  }
}
