import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { controlPlaneThreadResolutionSchema } from "@bb/domain";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import {
  ThreadInteractionSourceContext,
  type ThreadInteractionSource,
} from "@/hooks/mutations/thread-interaction-source";
import { ThreadPendingInteractionBanners } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import type { PersonalWorkspaceClient } from "./PersonalWorkspace";
import { PersonalComposerEditor } from "./PersonalComposerEditor";

type Project = Awaited<ReturnType<PersonalWorkspaceClient["projects"]["get"]>>;
type Thread = Awaited<ReturnType<PersonalWorkspaceClient["threads"]["get"]>>;
export function PersonalConversationComposer({
  client,
  project,
  thread,
  onCreated,
}: {
  client: PersonalWorkspaceClient;
  project: Project;
  thread: Thread | null;
  onCreated: (thread: Thread) => void;
}) {
  const queries = useQueryClient();
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (lifetime.current === controller) lifetime.current = null;
    };
  }, []);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const draft = usePromptDraftStorage(
    thread
      ? { kind: "thread", projectId: project.projectId, threadId: thread.id }
      : { kind: "plugin-new-thread", key: `personal:${project.projectId}` },
  );
  const profiles = useInfiniteQuery({
    queryKey: ["personal", "composer-profiles"],
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) => client.profiles.list({ cursor: pageParam ?? undefined, signal }),
    getNextPageParam: (page) => page.nextCursor,
    enabled: thread === null,
    refetchInterval: 15_000,
  });
  const availableProfiles = profiles.isError
    ? []
    : (profiles.data?.pages.flatMap((page) => page.profiles) ?? []);
  const selectedProfile = availableProfiles.find(
    (profile) => profile.id === (profileId ?? availableProfiles[0]?.id),
  );
  const profile = useQuery({
    queryKey: [
      "personal",
      "composer-profile",
      thread?.id ?? null,
      selectedProfile?.id ?? null,
      selectedProfile?.latestVersionId ?? null,
    ],
    queryFn: ({ signal }) => {
      if (thread) return client.threads.profile(thread.id, signal);
      if (!selectedProfile) throw new Error("No profile selected");
      return client.profiles.get(selectedProfile.id, {
        versionId: selectedProfile.latestVersionId,
        signal,
      });
    },
    enabled: thread !== null || selectedProfile !== undefined,
    refetchInterval: 15_000,
  });
  const interactions = useQuery({
    queryKey: ["personal", "interactions", thread?.id],
    queryFn: ({ signal }) => {
      if (!thread) throw new Error("No conversation selected");
      return client.threads.interactions.list(thread.id, signal);
    },
    enabled: thread !== null,
    refetchInterval: 1000,
  });
  async function refresh() {
    await Promise.all([
      queries.invalidateQueries({ queryKey: ["personal", "threads"] }),
      queries.invalidateQueries({
        queryKey: ["personal", "thread", thread?.id],
      }),
      queries.invalidateQueries({
        queryKey: ["personal", "interactions", thread?.id],
      }),
    ]);
  }
  const interactionSource = useMemo<ThreadInteractionSource>(
    () => ({
      async resolve(input) {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted)
          throw new Error("Conversation is disconnected");
        if (!thread || input.threadId !== thread.id)
          throw new Error("Interaction must belong to this conversation");
        const result = await client.threads.interactions.resolve(
          thread.id,
          input.interactionId,
          controlPlaneThreadResolutionSchema.parse(input.resolution),
          signal,
        );
        if (!signal.aborted)
          await queries.invalidateQueries({
            queryKey: ["personal", "interactions", thread.id],
          });
        return result;
      },
      async stop(id) {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted)
          throw new Error("Conversation is disconnected");
        if (!thread || id !== thread.id)
          throw new Error("Stop must target this conversation");
        await client.threads.stop(id, signal);
        if (!signal.aborted)
          await queries.invalidateQueries({
            queryKey: ["personal", "thread", id],
          });
      },
    }),
    [client, lifetime, queries, thread],
  );
  async function submit() {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    if (
      busy.current ||
      !project.canRun ||
      !profile.data ||
      profile.isError ||
      !draft.text.trim() ||
      signal.aborted
    )
      return;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    const sent = draft.getCurrent();
    try {
      if (thread) {
        const result = await client.threads.send(
          thread.id,
          { message: sent.text },
          signal,
        );
        if (signal.aborted) return;
        draft.clearIfCurrentMatches(sent);
        setNotice(result.delivery === "queued" ? "Message queued" : null);
        await refresh();
      } else {
        const created = await client.threads.start(
          {
            projectId: project.projectId,
            profileVersionId: profile.data.version.id,
            message: sent.text,
          },
          signal,
        );
        if (signal.aborted) return;
        draft.clearIfCurrentMatches(sent);
        await refresh();
        if (!signal.aborted) onCreated(created);
      }
    } catch {
      if (!signal.aborted)
        setError(
          "Delivery could not be confirmed. Your draft has been kept. Check the conversation before retrying.",
        );
    } finally {
      busy.current = false;
      if (!signal.aborted) setPending(false);
    }
  }
  async function stop() {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    if (!thread || busy.current || signal.aborted) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await interactionSource.stop(thread.id);
      await refresh();
    } catch {
      if (!signal.aborted)
        setError(
          "Unable to stop this conversation. Check your access and retry.",
        );
    } finally {
      busy.current = false;
      if (!signal.aborted) setPending(false);
    }
  }
  const visibleInteractions = interactions.isError
    ? []
    : (interactions.data ?? []);
  const nativeInteractions = visibleInteractions.filter(
    (item) =>
      item.payload.kind === "approval" || item.payload.kind === "user_question",
  );
  const isRunning =
    thread !== null &&
    ["active", "starting", "stopping"].includes(thread.status);
  const controls = (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {thread ? (
        <span>
          {profile.isError
            ? "Profile unavailable"
            : (profile.data?.profile.name ?? "Loading profile…")}
        </span>
      ) : (
        <>
          <Select
            value={selectedProfile?.id ?? ""}
            onValueChange={(id) => {
              if (availableProfiles.some((item) => item.id === id))
                setProfileId(id);
            }}
            disabled={pending || profiles.isError}
          >
            <SelectTrigger aria-label="Agent profile">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {availableProfiles.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {profiles.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              disabled={profiles.isFetchingNextPage}
              onClick={() => void profiles.fetchNextPage()}
            >
              More agents
            </Button>
          )}
        </>
      )}
      {!profile.isError && profile.data && (
        <span>
          {profile.data.version.definition.model} ·{" "}
          {profile.data.version.definition.reasoningLevel}
        </span>
      )}
    </div>
  );
  return (
    <ThreadInteractionSourceContext.Provider value={interactionSource}>
      <div className="shrink-0 border-t p-3" aria-label="Message composer">
        {thread && !profile.isError && (
          <ThreadPendingInteractionBanners
            threadId={thread.id}
            interactions={nativeInteractions}
          />
        )}
        {visibleInteractions.length > nativeInteractions.length && (
          <p role="alert">
            This agent needs an interaction that is unavailable in this view.
            You can stop the conversation.
          </p>
        )}
        {interactions.isError && (
          <p role="alert">
            Unable to check pending requests. Reconnect before replying.
          </p>
        )}
        {error && (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="pb-2 text-sm">
            {notice}
          </p>
        )}
        {(profile.isError || profiles.isError) && (
          <p role="alert">
            This agent profile is unavailable. Sending is disabled.
          </p>
        )}
        {!thread && profiles.isSuccess && availableProfiles.length === 0 && (
          <p role="status">No agent profiles are available for this account.</p>
        )}
        <PersonalComposerEditor
          identity={{
            scope: thread
              ? { kind: "thread", threadId: thread.id }
              : { kind: "new-thread", projectId: project.projectId },
            key: `personal:${draft.storageKey}`,
          }}
          value={draft.text}
          onChange={(text) => draft.setTextAndMentions(text, [])}
          onSubmit={submit}
          isSubmitting={pending}
          isRunning={isRunning}
          disabled={
            !project.canRun ||
            profile.isError ||
            !profile.data ||
            interactions.isError
          }
          controls={controls}
          onStop={thread ? () => void stop() : undefined}
          surface={thread ? "thread" : "new-thread"}
        />
      </div>
    </ThreadInteractionSourceContext.Provider>
  );
}
