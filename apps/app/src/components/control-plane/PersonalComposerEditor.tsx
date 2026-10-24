import type { ReactNode } from "react";
import type {
  ExperimentalComposerThreadLinks,
  PluginComposerScope,
} from "@get-bb/plugin-sdk";
import {
  ComposerRendererHostProvider,
  useComposerRendererApi,
  type TypeaheadConfig,
} from "@/components/promptbox/ComposerBox";
import type { ComposerSearches } from "@/components/promptbox/composer-search";
import { PluginContext } from "@/components/plugin/plugin-context";
import { PromptBoxInternal } from "../../../../../plugins/composer/src/PromptBoxInternal";
import "../../../../../plugins/composer/src/composer.css";

const searches: ComposerSearches = {
  mention: { status: "idle", refreshing: false, groups: [], search() {} },
  command: { status: "idle", refreshing: false, groups: [], search() {} },
  prefetchCommands() {},
};
const threadLinks: ExperimentalComposerThreadLinks = {
  parse: () => null,
  cached: () => null,
  resolve: async () => {},
};
const typeahead: TypeaheadConfig = {
  mention: {
    triggers: [],
    source: { projectId: undefined, environmentId: null },
  },
  command: {
    source: {
      projectId: undefined,
      providerId: undefined,
      commandScope: "thread",
      skillsTriggers: [],
      environmentId: null,
    },
  },
};
function Editor() {
  const { input } = useComposerRendererApi();
  return <PromptBoxInternal {...input} />;
}
export function PersonalComposerEditor({
  value,
  onChange,
  onSubmit,
  isSubmitting,
  isRunning,
  disabled,
  controls,
  onStop,
  surface,
  identity,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  isSubmitting: boolean;
  isRunning: boolean;
  disabled: boolean;
  controls: ReactNode;
  onStop?: () => void;
  surface: "thread" | "new-thread";
  identity: { scope: PluginComposerScope; key: string };
}) {
  return (
    <ComposerRendererHostProvider
      identity={identity}
      surface={surface}
      value={value}
      mentionRanges={[]}
      onChange={(text) => onChange(text)}
      onSubmit={onSubmit}
      mentionMenuPlacement="top"
      typeahead={typeahead}
      searches={searches}
      threadLinks={threadLinks}
      suppressPluginComposerCustomizations
      executionControls={controls}
      submission={{
        isSubmitting,
        isRunning,
        disabled,
        onStop,
        queuesDraft: isRunning,
      }}
      placeholder="Message your agent…"
    >
      <PluginContext.Provider value="bb--composer">
        <Editor />
      </PluginContext.Provider>
    </ComposerRendererHostProvider>
  );
}
