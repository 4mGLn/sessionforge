// Hand-written ambient type declarations for @getpaseo/plugin's v0.8+ split client/server/shared module
// architecture (Paseo supplies the real runtime implementations at install time; consumers don't install
// this package themselves, so there's no real npm package here to pull types from). Reorganized from the
// pre-0.8 single-module shape when this plugin migrated for the v0.8 requirements.paseo breaking change —
// see https://paseo.sh/docs/plugins/v0.8/migration.
declare module "@getpaseo/plugin" {
  import type { ZodType } from "zod";

  export interface PluginRpcContract<InputSchema extends ZodType = ZodType, OutputSchema extends ZodType = ZodType> {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }

  export interface PluginAttachmentItem {
    id: string;
    identifier: string;
    title: string;
    subtitle?: string;
    url: string;
    text: string;
    resourceType: string;
  }

  export interface PluginAttachmentSearchPayload {
    items: PluginAttachmentItem[];
  }

  export interface PluginAttachmentSourceContribution {
    id: string;
    title: string;
    icon: string;
    pickerTitle: string;
    searchPlaceholder: string;
    search: PluginRpcContract;
  }

  export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(definition: {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }): PluginRpcContract<InputSchema, OutputSchema>;

  export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(definition: Definition): Definition;

  export const PluginAttachmentItemSchema: import("zod").ZodType<PluginAttachmentItem>;
  export const PluginAttachmentSearchPayloadSchema: import("zod").ZodType<PluginAttachmentSearchPayload>;

  export type PluginCleanup = () => void | Promise<void>;
}

declare module "@getpaseo/plugin/server" {
  import type { PaseoApi } from "@getpaseo/client";
  import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";
  import type { PluginCleanup, PluginRpcContract } from "@getpaseo/plugin";

  export interface PluginHandlerContext {
    paseo: PaseoApi;
  }

  export interface PluginServerContext {
    handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      handler: (
        input: ZodOutput<InputSchema>,
        context: PluginHandlerContext,
      ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    ): void;
  }

  export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
}

declare module "@getpaseo/plugin/client" {
  import type { ComponentType } from "react";
  import type { PaseoApi } from "@getpaseo/client";
  import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";
  import type { PluginAttachmentSourceContribution, PluginCleanup, PluginRpcContract } from "@getpaseo/plugin";

  export interface PluginTheme {
    readonly colors: {
      readonly surface0: string;
      readonly foreground: string;
      readonly foregroundMuted: string;
      readonly accent: string;
      readonly accentForeground: string;
      readonly statusDanger: string;
    };
  }

  export interface PluginHostProps {
    theme: PluginTheme;
    host: { id: string; label: string };
    layout: { compact: boolean; platform: "ios" | "android" | "web" };
  }

  export interface PluginSurfaceProps extends PluginHostProps {}

  export interface PluginWorkspaceSnapshot {
    readonly id: string;
    readonly projectId: string;
    readonly projectDisplayName: string;
    readonly projectRootPath: string;
    readonly directory: string;
    readonly projectKind: "git" | "non_git" | "directory";
    readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
    readonly name: string;
    readonly title: string | null;
    readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
    readonly statusEnteredAt: string | null;
    readonly archivingAt: string | null;
    readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
  }

  export interface PluginAgentSnapshot {
    readonly id: string;
    readonly workspaceId: string;
    readonly provider: string;
    readonly status: "initializing" | "idle" | "running" | "error" | "closed";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastActivityAt: string;
    readonly title: string | null;
    readonly cwd: string;
    readonly model: string | null;
    readonly currentModeId: string | null;
    readonly thinkingOptionId: string | null;
    readonly requiresAttention: boolean;
    readonly attentionReason: "finished" | "error" | "permission" | null;
    readonly parentAgentId: string | null;
    readonly labels: Readonly<Record<string, string>>;
  }

  export interface PluginWorkspacePanelProps extends PluginHostProps {
    context: "workspace";
    workspaceId: string;
  }

  export interface PluginAgentPanelProps extends PluginHostProps {
    context: "agent";
    workspaceId: string;
    agentId: string;
  }

  export type PluginPanelLocation = "workspace" | "explorer";
  export interface PluginOpenPanelOptions {
    location?: PluginPanelLocation;
  }

  export type PluginWorkspacePanelContribution =
    | {
        id: string;
        title: string;
        icon: string;
        locations?: readonly PluginPanelLocation[];
        context: "workspace";
        Component: ComponentType<PluginWorkspacePanelProps>;
      }
    | {
        id: string;
        title: string;
        icon: string;
        locations?: readonly PluginPanelLocation[];
        context: "agent";
        Component: ComponentType<PluginAgentPanelProps>;
      };

  export interface PluginSidebarContribution {
    id: string;
    title: string;
    icon: string;
    surface: string;
  }

  export interface PluginThemeColors {
    background: string;
    foreground: string;
    raised: string;
    control: string;
    border: string;
    accent?: string;
    mutedForeground: string;
    ring: string;
  }

  export interface PluginThemeContribution {
    id: string;
    name: string;
    appearance: "light" | "dark";
    colors: PluginThemeColors;
  }

  export interface PluginSurfaceContribution {
    id: string;
    Component: ComponentType<PluginSurfaceProps>;
  }

  export interface PluginCommandCapabilities {
    paseo: PaseoApi;
    rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>>;
    openSurface(id: string): void;
  }

  export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
    context: "global";
  }

  export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
    context: "workspace";
    workspace: PluginWorkspaceSnapshot;
    openPanel(id: string, options?: PluginOpenPanelOptions): void;
  }

  export interface PluginAgentCommandContext extends PluginCommandCapabilities {
    context: "agent";
    workspace: PluginWorkspaceSnapshot;
    agent: PluginAgentSnapshot;
    openPanel(id: string, options?: PluginOpenPanelOptions): void;
  }

  export type PluginCommandCenterItemContribution =
    | {
        id: string;
        title: string;
        icon: string;
        keywords?: readonly string[];
        context: "global";
        onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
      }
    | {
        id: string;
        title: string;
        icon: string;
        keywords?: readonly string[];
        context: "workspace";
        onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
      }
    | {
        id: string;
        title: string;
        icon: string;
        keywords?: readonly string[];
        context: "agent";
        onSelect(context: PluginAgentCommandContext): void | Promise<void>;
      };

  export interface PluginClientContext {
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
    addSidebarItem(contribution: PluginSidebarContribution): void;
    addWorkspacePanel(contribution: PluginWorkspacePanelContribution): void;
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution): void;
    addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
    addTheme(contribution: PluginThemeContribution): void;
  }

  export type PluginClientContribution = (client: PluginClientContext) => PluginCleanup;

  export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
  ): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>>;

  export function usePaseo(): PaseoApi;

  export function useWorkspace<Selection>(workspaceId: string, selector: (workspace: PluginWorkspaceSnapshot) => Selection): Selection | null;

  export function useAgent<Selection>(agentId: string, selector: (agent: PluginAgentSnapshot) => Selection): Selection | null;
}
