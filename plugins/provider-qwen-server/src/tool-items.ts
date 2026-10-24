import { resolve } from "node:path";
import {
  experimental_fileReadPresentation as fileReadPresentation,
  experimental_searchPresentation as searchPresentation,
  experimental_webSearchPresentation as webSearchPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_toolPresentation as toolPresentation,
  experimental_withTitle as withTitle,
  type DeltaItemShape,
  type DeltaPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";
export const OUTPUT_LIMIT = 128 * 1024;
export function bounded(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text && text.length > OUTPUT_LIMIT
    ? { truncated: true, preview: text.slice(0, OUTPUT_LIMIT) }
    : value;
}
export function outputText(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value
            .map((block) =>
              block?.type === "text" ? block.text : JSON.stringify(block),
            )
            .join("\n")
        : (JSON.stringify(value) ?? "");
  return text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n[truncated]`
    : text;
}
export type ToolDisplay = {
  item: DeltaItemShape;
  presentation?: DeltaPresentation;
};
export function toolDisplay(
  name: string,
  input: unknown,
  cwd: string,
): ToolDisplay {
  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const str = (key: string) =>
    typeof args[key] === "string" ? (args[key] as string) : undefined;
  const path = str("file_path") ?? str("path");
  const title = str("description");
  if (name === "run_shell_command" && str("command")) {
    const directory = str("directory");
    return {
      item: {
        type: "command",
        command: str("command")!,
        cwd: directory ? resolve(cwd, directory) : cwd,
      },
      ...(title
        ? {
            presentation: {
              icon: { glyph: "Terminal" },
              label: { pending: "Running", completed: "Ran" },
              title,
            },
          }
        : {}),
    };
  }
  if (name === "read_file" && path) {
    return {
      item: { type: "fileRead", path },
      presentation: withTitle(fileReadPresentation(path), title),
    };
  }
  if ((name === "grep_search" || name === "glob") && str("pattern")) {
    const mode = name === "glob" ? "path" : "content";
    const query = str("pattern")!;
    return {
      item: { type: "search", mode, query, ...(path ? { path } : {}) },
      presentation: withTitle(searchPresentation({ mode, query }), title),
    };
  }
  if (name === "list_directory" && path) {
    return {
      item: { type: "search", mode: "list", query: path, path },
      presentation: withTitle(
        searchPresentation({ mode: "path", query: path }),
        title,
      ),
    };
  }
  if (name === "web_search" && str("query")) {
    return {
      item: { type: "webSearch", queries: [str("query")!] },
      presentation: withTitle(webSearchPresentation(str("query")), title),
    };
  }
  if (name === "web_fetch" && str("url")) {
    return {
      item: {
        type: "webFetch",
        url: str("url")!,
        pattern: null,
        prompt: str("prompt"),
      },
      presentation: withTitle(webFetchPresentation(str("url")!), title),
    };
  }
  if ((name === "edit" || name === "write_file") && path) {
    return {
      item: { type: "tool", tool: name, args: bounded(input) },
      presentation: {
        icon: { glyph: "FilePenLine" },
        label: { pending: "Editing", completed: "Edited" },
        detail: path,
        ...(title ? { title } : {}),
      },
    };
  }
  return {
    item: { type: "tool", tool: name, args: bounded(input) },
    presentation: withTitle(toolPresentation(name), title),
  };
}
export function completeTool(
  item: DeltaItemShape,
  content: unknown,
  isError: boolean,
  durationMs: number,
): DeltaItemShape {
  if (item.type === "command")
    return { ...item, aggregatedOutput: outputText(content), durationMs };
  if (item.type === "tool")
    return {
      ...item,
      result: bounded(content),
      durationMs,
      ...(isError ? { error: outputText(content) } : {}),
    };
  return item;
}
