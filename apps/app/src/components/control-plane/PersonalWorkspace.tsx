import { useState } from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import {
  getControlPlaneProjectPath,
  getControlPlaneThreadPath,
} from "@bb/server-contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { PersonalTimeline } from "./PersonalTimeline";
import { PersonalAutomations } from "./PersonalAutomations";
import { PersonalWorkflows } from "./PersonalWorkflows";
import { PersonalConversationComposer } from "./PersonalConversationComposer";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useCloseMobileSidebar,
} from "@/components/ui/sidebar";

export type PersonalWorkspaceClient = ReturnType<
  typeof createControlPlaneClient
>;

export function PersonalWorkspace({
  client,
}: {
  client: PersonalWorkspaceClient;
}) {
  const bootstrap = useQuery({
    queryKey: ["personal", "bootstrap"],
    queryFn: ({ signal }) => client.bootstrap(signal),
    refetchInterval: 15_000,
  });
  if (bootstrap.isError)
    return <Unavailable onRetry={() => void bootstrap.refetch()} />;
  if (!bootstrap.data) return <p role="status">Loading your workspace…</p>;
  return (
    <SidebarProvider className="h-dvh min-h-0">
      <WorkspaceNavigation client={client} bootstrap={bootstrap.data} />
    </SidebarProvider>
  );
}

function Unavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="p-6">
      <p>Your workspace is unavailable. Check your access and reconnect.</p>
      <Button variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function WorkspaceNavigation({
  client,
  bootstrap,
}: {
  client: PersonalWorkspaceClient;
  bootstrap: Awaited<ReturnType<PersonalWorkspaceClient["bootstrap"]>>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const view = new URLSearchParams(location.search).get("view");
  const workflowView = view === "workflows";
  const automationView = view === "automations";
  const projectRoute = useMatch("/projects/:projectId");
  const threadRoute = useMatch("/projects/:projectId/threads/:threadId");
  const shortThreadRoute = useMatch("/threads/:threadId");
  const threadId =
    threadRoute?.params.threadId ?? shortThreadRoute?.params.threadId ?? null;
  const pathProjectId =
    threadRoute?.params.projectId ?? projectRoute?.params.projectId ?? null;
  const messageSeq = new URLSearchParams(location.hash.slice(1)).get("msg");
  const invalidMessage =
    messageSeq !== null &&
    (!/^(0|[1-9]\d*)$/u.test(messageSeq) ||
      !Number.isSafeInteger(Number(messageSeq)));
  const detail = useQuery({
    queryKey: ["personal", "thread", threadId],
    queryFn: ({ signal }) => {
      if (!threadId) throw new Error("No thread selected");
      return client.threads.get(threadId, signal);
    },
    enabled: threadId !== null,
    refetchInterval: 15_000,
  });
  const projectId =
    pathProjectId ??
    (detail.data?.id === threadId ? detail.data.projectId : null);
  const [logoutError, setLogoutError] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const closeSidebar = useCloseMobileSidebar();
  const projects = useInfiniteQuery({
    queryKey: ["personal", "projects", bootstrap.projects],
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) =>
      pageParam === null
        ? Promise.resolve(bootstrap.projects)
        : client.projects.list({ cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const visibleProjects = projects.isError
    ? []
    : (projects.data?.pages.flatMap((page) => page.projects) ??
      bootstrap.projects.projects);
  const project = useQuery({
    queryKey: ["personal", "project", projectId],
    queryFn: ({ signal }) => {
      if (!projectId) throw new Error("No project selected");
      return client.projects.get(projectId, signal);
    },
    enabled: projectId !== null,
    refetchInterval: 15_000,
  });
  const selectedProject =
    !project.isError && project.data?.projectId === projectId
      ? project.data
      : undefined;
  const threads = useInfiniteQuery({
    queryKey: ["personal", "threads", selectedProject?.projectId],
    initialPageParam: null,
    queryFn: ({
      pageParam,
      signal,
    }: {
      pageParam: string | null;
      signal: AbortSignal;
    }) => {
      if (!selectedProject) throw new Error("No project selected");
      return client.threads.list({
        projectId: selectedProject.projectId,
        cursor: pageParam ?? undefined,
        signal,
      });
    },
    getNextPageParam: (page) => page.nextCursor,
    enabled: selectedProject !== undefined && project.isSuccess,
    refetchInterval: 15_000,
  });
  const visibleThreads =
    project.isError || threads.isError
      ? []
      : (threads.data?.pages.flatMap((page) => page.threads) ?? []);
  const selectedThread =
    selectedProject &&
    !detail.isError &&
    detail.data?.id === threadId &&
    detail.data.projectId === projectId
      ? detail.data
      : undefined;
  const mismatchedThread =
    detail.data !== undefined &&
    detail.data.id === threadId &&
    detail.data.projectId !== projectId;
  const navigationProjects =
    selectedProject &&
    !visibleProjects.some(
      (item) => item.projectId === selectedProject.projectId,
    )
      ? [...visibleProjects, selectedProject]
      : visibleProjects;
  const navigationThreads =
    selectedThread &&
    !visibleThreads.some((item) => item.id === selectedThread.id)
      ? [...visibleThreads, selectedThread]
      : visibleThreads;
  const navigableProjects = navigationProjects.filter(
    (item) => !project.isError || item.projectId !== projectId,
  );
  const navigableThreads = navigationThreads.filter(
    (item) => !detail.isError || item.id !== threadId,
  );
  async function logout() {
    setLoggingOut(true);
    setLogoutError(false);
    try {
      await client.logout();
      window.location.replace(client.browserLoginUrl());
    } catch {
      setLogoutError(true);
      setLoggingOut(false);
    }
  }
  return (
    <>
      <Sidebar aria-label="Projects and threads">
        <div className="px-4 py-3 text-sm font-medium">BB</div>
        <SidebarContent>
          <SidebarMenu aria-label="Projects" className="px-2">
            {navigableProjects.map((item) => (
              <SidebarMenuItem key={item.projectId}>
                <SidebarMenuButton
                  className="aria-[current=page]:bg-sidebar-accent"
                  aria-current={
                    projectId === item.projectId ? "page" : undefined
                  }
                  onClick={() => {
                    navigate(getControlPlaneProjectPath(item.projectId));
                  }}
                >
                  <Icon name="Folder" />
                  <span>{item.name}</span>
                </SidebarMenuButton>
                {projectId === item.projectId && (
                  <SidebarMenu
                    aria-label={`${item.name} threads`}
                    className="pl-4"
                  >
                    {navigableThreads.map((thread) => (
                      <SidebarMenuItem key={thread.id}>
                        <SidebarMenuButton
                          className="aria-[current=page]:bg-sidebar-accent"
                          aria-current={
                            threadId === thread.id ? "page" : undefined
                          }
                          onClick={() => {
                            navigate(
                              getControlPlaneThreadPath(
                                thread.projectId,
                                thread.id,
                              ),
                            );
                            closeSidebar();
                          }}
                        >
                          <Icon name="MessageSquare" />
                          <span>{thread.title ?? "Untitled thread"}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                    {threads.hasNextPage && (
                      <SidebarMenuItem>
                        <Button
                          variant="ghost"
                          disabled={threads.isFetchingNextPage}
                          onClick={() => void threads.fetchNextPage()}
                        >
                          More threads
                        </Button>
                      </SidebarMenuItem>
                    )}
                    {threads.isError && (
                      <li role="alert">Unable to load threads</li>
                    )}
                  </SidebarMenu>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          {navigableProjects.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No accessible projects
            </p>
          )}
          {projects.hasNextPage && (
            <Button
              variant="ghost"
              disabled={projects.isFetchingNextPage}
              onClick={() => void projects.fetchNextPage()}
            >
              More projects
            </Button>
          )}
          {projects.isError && <p role="alert">Unable to load projects</p>}
        </SidebarContent>
        <SidebarFooter>
          <span className="truncate px-2 text-sm">
            {bootstrap.session.user.login}
          </span>
          <Button
            variant="ghost"
            disabled={loggingOut}
            onClick={() => void logout()}
          >
            Sign out
          </Button>
          {logoutError && <p role="alert">Unable to sign out. Retry.</p>}
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2">
          <SidebarTrigger />
          <span className="truncate text-sm">
            {project.isError
              ? "Your workspace"
              : (selectedProject?.name ?? "Your workspace")}
          </span>
          {selectedProject && project.data?.canRun && !project.isError && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (projectId) navigate(getControlPlaneProjectPath(projectId));
                closeSidebar();
              }}
            >
              New conversation
            </Button>
          )}
          {selectedProject && !project.isError && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigate({
                  pathname: location.pathname,
                  search: workflowView ? "" : "?view=workflows",
                });
                closeSidebar();
              }}
            >
              {workflowView ? "Conversation" : "Workflows"}
            </Button>
          )}
          {selectedProject && !project.isError && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={automationView}
              onClick={() => {
                navigate({
                  pathname: location.pathname,
                  search: automationView ? "" : "?view=automations",
                });
                closeSidebar();
              }}
            >
              {automationView ? "Conversation" : "Automations"}
            </Button>
          )}
        </header>
        {project.isError ||
        (threadId !== null && detail.isError) ||
        mismatchedThread ||
        invalidMessage ? (
          <Unavailable
            onRetry={() => {
              void project.refetch();
              void threads.refetch();
              if (threadId) void detail.refetch();
            }}
          />
        ) : automationView && selectedProject ? (
          <PersonalAutomations
            key={`${selectedProject.projectId}:${selectedThread?.id ?? "project"}`}
            client={client}
            projectId={selectedProject.projectId}
            originThreadId={
              project.data?.canRun ? (selectedThread?.id ?? null) : null
            }
            canExecute={project.data?.canRun === true}
            onOpenThread={(id) =>
              navigate(getControlPlaneThreadPath(selectedProject.projectId, id))
            }
          />
        ) : workflowView && selectedProject ? (
          <PersonalWorkflows
            key={`${selectedProject.projectId}:${selectedThread?.id ?? "project"}`}
            client={client}
            projectId={selectedProject.projectId}
            canExecute={project.data?.canRun === true}
            originThreadId={
              project.data?.canRun ? (selectedThread?.id ?? null) : null
            }
          />
        ) : (
          <section className="flex min-h-0 flex-1 flex-col">
            {threadId !== null && !selectedThread ? (
              <p role="status" className="p-6">
                Loading conversation…
              </p>
            ) : selectedThread && detail.data ? (
              <>
                <h1 className="px-6 pt-4 text-lg font-medium">
                  {detail.data.title ?? "Untitled thread"}
                </h1>
                <p className="px-6 pb-3 text-sm text-muted-foreground">
                  {detail.data.status}
                </p>
                <PersonalTimeline
                  key={selectedThread.id}
                  client={client}
                  threadId={selectedThread.id}
                  projectId={selectedThread.projectId}
                  status={detail.data.status}
                  cwd={selectedProject?.cwd ?? ""}
                />
              </>
            ) : (
              <>
                <h1 className="text-lg font-medium">
                  {selectedProject?.name ?? "Your projects"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  Choose a project and a conversation from the sidebar.
                </p>
              </>
            )}
          </section>
        )}
        {selectedProject &&
          !workflowView &&
          !automationView &&
          project.data &&
          !project.isError &&
          !mismatchedThread &&
          !invalidMessage &&
          (threadId === null ||
            (selectedThread && detail.data && !detail.isError)) && (
            <PersonalConversationComposer
              key={`${selectedProject.projectId}:${selectedThread?.id ?? "new"}`}
              client={client}
              project={project.data}
              thread={selectedThread ? (detail.data ?? null) : null}
              onCreated={(created) =>
                navigate(
                  getControlPlaneThreadPath(created.projectId, created.id),
                )
              }
            />
          )}
      </SidebarInset>
    </>
  );
}
