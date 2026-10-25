import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import {
  controlPlaneAutomationCreateSchema,
  controlPlaneAutomationUpdateSchema,
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
  const [prompt, setPrompt] = useState(saved?.prompt ?? "");
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
      const signal = lifetime.current.controller.signal;
      const value = baseline
        ? await client.automations.update(
            baseline.id,
            controlPlaneAutomationUpdateSchema.parse({
              expectedRevision: baseline.revision,
              name,
              prompt,
              trigger,
            }),
            signal,
          )
        : await client.automations.create(
            controlPlaneAutomationCreateSchema.parse({
              originThreadId,
              name,
              prompt,
              trigger,
              enabled,
            }),
            signal,
          );
      return { ...value, prompt };
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
      setPrompt(value.prompt);
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
          <label className="block text-sm" htmlFor={promptId}>
            Automation prompt
          </label>
          <textarea
            id={promptId}
            className={`${fieldClass} min-h-32`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={131072}
            required
          />
        </div>
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
          <Button type="submit" disabled={!name.trim() || !prompt.trim()}>
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
