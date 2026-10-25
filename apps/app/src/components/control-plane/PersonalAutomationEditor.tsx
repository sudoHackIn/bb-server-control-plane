import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import {
  controlPlaneAutomationCreateSchema,
  controlPlaneAutomationUpdateSchema,
  controlPlaneAutomationDetailSchema,
} from "@bb/domain";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";

type AutomationDetail = Awaited<
  ReturnType<PersonalWorkspaceClient["automations"]["definition"]>
>;

function localDate(value: number) {
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

export function PersonalAutomationEditor({
  client,
  saved,
  originThreadId,
  canExecute,
  onSaved,
  onReload,
}: {
  client: PersonalWorkspaceClient;
  saved: AutomationDetail | null;
  originThreadId: string;
  canExecute: boolean;
  onReload: (() => Promise<AutomationDetail>) | null;
  onSaved: (
    value: Awaited<
      ReturnType<PersonalWorkspaceClient["automations"]["create"]>
    >,
  ) => void;
}) {
  const scheduleTypeId = useId();
  const promptId = useId();
  const [baseline, setBaseline] = useState(saved);
  const [name, setName] = useState(saved?.name ?? "");
  const [kind, setKind] = useState<"agent" | "script">(
    saved?.executionMode ?? "agent",
  );
  const [prompt, setPrompt] = useState(
    saved?.executionMode === "agent" ? saved.prompt : "",
  );
  const [script, setScript] = useState(
    saved?.executionMode === "script" ? saved.script.source : "",
  );
  const [timeoutMs, setTimeoutMs] = useState(
    String(saved?.executionMode === "script" ? saved.script.timeoutMs : 120000),
  );
  const kindId = useId();
  const [mode, setMode] = useState<"once" | "schedule">(
    saved?.trigger.triggerType ?? "once",
  );
  const [at, setAt] = useState(() =>
    localDate(
      saved?.trigger.triggerType === "once"
        ? saved.trigger.runAt
        : Date.now() + 3600000,
    ),
  );
  const [cron, setCron] = useState(
    saved?.trigger.triggerType === "schedule"
      ? saved.trigger.cron
      : "0 9 * * 1-5",
  );
  const [timezone, setTimezone] = useState(
    saved?.trigger.triggerType === "schedule"
      ? saved.trigger.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [enabled, setEnabled] = useState(true);
  const lifetime = useRef({ live: true, controller: new AbortController() });
  useEffect(() => {
    const current = { live: true, controller: new AbortController() };
    lifetime.current = current;
    return () => {
      current.live = false;
      current.controller.abort();
    };
  }, []);
  const save = useMutation({
    mutationFn: async () => {
      const trigger =
        mode === "once"
          ? { triggerType: "once", runAt: new Date(at).getTime() }
          : { triggerType: "schedule", cron, timezone };
      const content =
        kind === "agent"
          ? { prompt }
          : { script: { source: script, timeoutMs: Number(timeoutMs) } };
      const signal = lifetime.current.controller.signal;
      const value = baseline
        ? await client.automations.update(
            baseline.id,
            controlPlaneAutomationUpdateSchema.parse({
              expectedRevision: baseline.revision,
              name,
              ...content,
              trigger,
            }),
            signal,
          )
        : await client.automations.create(
            controlPlaneAutomationCreateSchema.parse({
              originThreadId,
              name,
              ...content,
              trigger,
              enabled,
            }),
            signal,
          );
      return controlPlaneAutomationDetailSchema.parse({
        ...value,
        ...content,
        executionMode: kind,
      });
    },
    onSuccess: (value) => {
      if (!lifetime.current.live) return;
      setBaseline(value);
      onSaved(value);
    },
  });
  const reload = useMutation({
    mutationFn: async () => {
      if (!onReload) throw new Error("No saved automation");
      return onReload();
    },
    onSuccess: (value) => {
      if (!lifetime.current.live) return;
      setBaseline(value);
      setName(value.name);
      setKind(value.executionMode);
      setPrompt(value.executionMode === "agent" ? value.prompt : "");
      setScript(value.executionMode === "script" ? value.script.source : "");
      setTimeoutMs(
        String(
          value.executionMode === "script" ? value.script.timeoutMs : 120000,
        ),
      );
      setMode(value.trigger.triggerType);
      if (value.trigger.triggerType === "once")
        setAt(localDate(value.trigger.runAt));
      else {
        setCron(value.trigger.cron);
        setTimezone(value.trigger.timezone);
      }
      save.reset();
    },
  });
  const fieldClass =
    "mt-1 block w-full rounded border bg-background p-2 text-sm";
  return (
    <form
      aria-label="Automation editor"
      className="space-y-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canExecute) save.mutate();
      }}
    >
      <h3 className="text-base font-medium">
        {baseline
          ? `Edit automation · v${baseline.revision}`
          : "Create automation"}
      </h3>
      <p className="text-sm text-muted-foreground">
        Uses the origin conversation's approved agent profile. Saving does not
        change the origin conversation.
      </p>
      <fieldset
        disabled={save.isPending || reload.isPending || !canExecute}
        className="space-y-3"
      >
        <label className="block text-sm">
          Automation name
          <input
            className={fieldClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            required
          />
        </label>
        <div>
          <label className="block text-sm" htmlFor={kindId}>
            Automation type
          </label>
          <select
            id={kindId}
            className={fieldClass}
            value={kind}
            disabled={baseline !== null}
            onChange={(event) =>
              setKind(event.target.value === "script" ? "script" : "agent")
            }
          >
            <option value="agent">Agent prompt</option>
            <option value="script">Node.js script</option>
          </select>
        </div>
        <div>
          <label className="block text-sm" htmlFor={promptId}>
            {kind === "agent" ? "Automation prompt" : "Script source"}
          </label>
          <textarea
            id={promptId}
            className={`${fieldClass} min-h-32`}
            value={kind === "agent" ? prompt : script}
            onChange={(event) =>
              kind === "agent"
                ? setPrompt(event.target.value)
                : setScript(event.target.value)
            }
            maxLength={kind === "agent" ? 131072 : 262144}
            required
          />
        </div>
        {kind === "script" && (
          <>
            <p className="text-sm text-muted-foreground">
              Node ESM in your project workspace. Requires an approved
              full-permission profile.
            </p>
            <label className="block text-sm">
              Script timeout (ms)
              <input
                type="number"
                min={1}
                max={900000}
                required
                className={fieldClass}
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(event.target.value)}
              />
            </label>
          </>
        )}
        <div>
          <label className="block text-sm" htmlFor={scheduleTypeId}>
            Schedule type
          </label>
          <select
            id={scheduleTypeId}
            className={fieldClass}
            value={mode}
            onChange={(event) =>
              setMode(event.target.value === "schedule" ? "schedule" : "once")
            }
          >
            <option value="once">Once</option>
            <option value="schedule">Recurring</option>
          </select>
        </div>
        {mode === "once" ? (
          <label className="block text-sm">
            Run at (local time)
            <input
              type="datetime-local"
              className={fieldClass}
              value={at}
              onChange={(event) => setAt(event.target.value)}
              required
            />
          </label>
        ) : (
          <>
            <label className="block text-sm">
              Cron expression
              <input
                className={fieldClass}
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                maxLength={100}
                required
              />
            </label>
            <label className="block text-sm">
              Schedule timezone
              <input
                className={fieldClass}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                maxLength={100}
                required
              />
            </label>
          </>
        )}
        {!baseline && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enable automation
          </label>
        )}
        {canExecute && (
          <Button
            type="submit"
            disabled={
              !name.trim() || !(kind === "agent" ? prompt : script).trim()
            }
          >
            {baseline ? "Save automation" : "Create automation"}
          </Button>
        )}
      </fieldset>
      {saved && (
        <Button
          type="button"
          variant="ghost"
          disabled={save.isPending || reload.isPending}
          onClick={() => reload.mutate()}
        >
          Reload saved automation
        </Button>
      )}
      {baseline && saved && baseline.revision !== saved.revision && (
        <p role="status">
          A newer revision is available. Reload saved automation to discard your
          draft and edit it.
        </p>
      )}
      {save.isError && (
        <p role="alert">
          Unable to save automation. Check the schedule and access, or reload
          the latest revision before editing. Your draft is retained.
        </p>
      )}
    </form>
  );
}
