import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createControlPlaneClient } from "@bb/sdk/browser";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
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
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
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
  const selectedProject = visibleProjects.find(
    (project) => project.projectId === projectId,
  );
  const project = useQuery({
    queryKey: ["personal", "project", selectedProject?.projectId],
    queryFn: ({ signal }) => {
      if (!selectedProject) throw new Error("No project selected");
      return client.projects.get(selectedProject.projectId, signal);
    },
    enabled: selectedProject !== undefined,
    refetchInterval: 15_000,
  });
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
  const selectedThread = visibleThreads.find(
    (thread) => thread.id === threadId,
  );
  const detail = useQuery({
    queryKey: ["personal", "thread", selectedThread?.id],
    queryFn: ({ signal }) => {
      if (!selectedThread) throw new Error("No thread selected");
      return client.threads.get(selectedThread.id, signal);
    },
    enabled: selectedThread !== undefined && !project.isError,
    refetchInterval: 15_000,
  });
  const navigableProjects = visibleProjects.filter(
    (item) => !project.isError || item.projectId !== selectedProject?.projectId,
  );
  const navigableThreads = visibleThreads.filter(
    (item) => !detail.isError || item.id !== selectedThread?.id,
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
                    setProjectId(item.projectId);
                    setThreadId(null);
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
                            setThreadId(thread.id);
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
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <SidebarTrigger />
          <span className="truncate text-sm">
            {project.isError
              ? "Your workspace"
              : (selectedProject?.name ?? "Your workspace")}
          </span>
        </header>
        {project.isError || (selectedThread && detail.isError) ? (
          <Unavailable
            onRetry={() => {
              void project.refetch();
              void threads.refetch();
              if (selectedThread) void detail.refetch();
            }}
          />
        ) : (
          <section className="p-6">
            {selectedThread && detail.data ? (
              <>
                <h1 className="text-lg font-medium">
                  {detail.data.title ?? "Untitled thread"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {detail.data.status}
                </p>
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
      </SidebarInset>
    </>
  );
}
