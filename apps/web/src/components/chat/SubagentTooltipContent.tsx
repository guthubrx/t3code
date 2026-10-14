import type {
  BridgetLineageTask,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItemStatus,
  OrchestrationProjectShell,
  ServerProvider,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  resolveSubagentMetadata,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { getModelSelectionStringOptionValue, resolveSelectableModel } from "@t3tools/shared/model";
import { getTraitsSpeedDisplay, TraitsSpeedIcon } from "./TraitsSpeed";
import type { ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  FolderIcon,
  GitBranchIcon,
  TerminalIcon,
} from "lucide-react";
import { ThreadHoverCard } from "../ThreadHoverCard";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import bridgetLogoUrl from "~/assets/bridget-logo.svg";
import { deriveProviderInstanceEntries, shouldShowInstanceBadge } from "../../providerInstances";

/** Colour only attests a known local placement; legacy metadata stays neutral. */
export function BridgetTaskIcon({
  task,
  className,
}: {
  task: BridgetLineageTask | undefined;
  className?: string;
}) {
  const local = task?.placement === null;
  const label = local
    ? "Bridget · Local"
    : task?.placement
      ? "Bridget · Distant"
      : "Bridget · Localisation inconnue";
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-block size-4 shrink-0",
        !local && "bg-current text-muted-foreground",
        className,
      )}
      style={
        local
          ? {
              backgroundImage: `url(${JSON.stringify(bridgetLogoUrl)})`,
              backgroundSize: "contain",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "center",
            }
          : {
              maskImage: `url(${JSON.stringify(bridgetLogoUrl)})`,
              maskSize: "contain",
              maskRepeat: "no-repeat",
              maskPosition: "center",
            }
      }
    />
  );
}

/** A contact is an observation from the read, never a live connectivity clock. */
export function BridgetTaskPlacement({
  task,
  compact = false,
}: {
  task: BridgetLineageTask | undefined;
  compact?: boolean;
}) {
  const placement = task?.placement;
  if (placement === undefined) return <span>Métadonnées distantes indisponibles</span>;
  if (placement === null) return <span>Aucun placement distant</span>;
  const contact =
    placement.contact_state === "stale"
      ? "Contact perdu"
      : placement.contact_state === "unknown"
        ? "Contact inconnu"
        : "Contact observé";
  const observedAt =
    placement.last_contact_at === null ? null : new Date(placement.last_contact_at * 1000);
  return (
    <span className="block min-w-0 break-words">
      <span>{placement.display_name || placement.machine_id}</span>
      {!compact && placement.display_name && placement.display_name !== placement.machine_id ? (
        <span> ({placement.machine_id})</span>
      ) : null}
      <span> · {contact}</span>
      {!compact ? (
        <span className="block text-xs text-muted-foreground">
          {observedAt === null ? (
            "Date du contact inconnue"
          ) : (
            <>
              Dernier contact observé :{" "}
              <time dateTime={observedAt.toISOString()}>{observedAt.toLocaleString("fr-FR")}</time>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}

/** Geometry and preview limits stay identical in lineage and timeline tooltips. */
export function SubagentTooltipContent(props: {
  title: string;
  model: string | null;
  providerInstanceId: ProviderInstanceId;
  origin: OrchestrationV2Subagent["origin"];
  modelSelection?: OrchestrationV2Subagent["modelSelection"];
  provider?: ServerProvider | undefined;
  /** The environment's instances; with several accounts on one provider, the card names this one. */
  providers?: ReadonlyArray<ServerProvider> | undefined;
  driver?: ProviderDriverKind | undefined;
  elapsed?: ReactNode;
  parentThread?: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath"> | undefined;
  childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath" | "modelSelection" | "bridgetTask">
    | undefined;
  parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | undefined;
  childProject?: Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot"> | undefined;
  status: OrchestrationV2TurnItemStatus;
  result?: string | null | undefined;
  progress?: string | null | undefined;
}) {
  const { modelLabel, workspace: metadata } = resolveSubagentMetadata(props);
  const nativeTask = props.origin === "bridget_native" ? props.childThread?.bridgetTask : undefined;
  const preview = subagentDetailPreview(props);
  const model = props.model?.trim();
  const modelSlug = props.provider
    ? resolveSelectableModel(props.provider.driver, model, props.provider.models)
    : model;
  const providerModel = props.provider?.models.find((candidate) => candidate.slug === modelSlug);
  const childSelection =
    props.modelSelection ??
    (props.origin === "app_owned" ? props.childThread?.modelSelection : undefined);
  const childModel = props.provider
    ? (resolveSelectableModel(
        props.provider.driver,
        childSelection?.model,
        props.provider.models,
      ) ?? childSelection?.model.trim())
    : childSelection?.model.trim();
  const provider = props.provider;
  const matchingSelection =
    childModel === (modelSlug ?? model) && childSelection?.instanceId === props.providerInstanceId
      ? childSelection
      : undefined;
  const effort = ["reasoningEffort", "effort", "reasoning", "variant"]
    .map((id) => getModelSelectionStringOptionValue(matchingSelection, id))
    .find(Boolean);
  const speed = provider
    ? providerModel?.capabilities?.optionDescriptors
        ?.map((descriptor) => {
          const saved = matchingSelection?.options?.find((option) => option.id === descriptor.id);
          if (
            descriptor.id === "fastMode" &&
            descriptor.type === "boolean" &&
            typeof saved?.value === "boolean"
          ) {
            return getTraitsSpeedDisplay(provider.driver, {
              ...descriptor,
              currentValue: saved.value,
            });
          }
          if (
            provider.driver === "codex" &&
            descriptor.id === "serviceTier" &&
            descriptor.type === "select" &&
            typeof saved?.value === "string" &&
            descriptor.options.some((option) => option.id === saved.value)
          ) {
            return getTraitsSpeedDisplay(provider.driver, {
              ...descriptor,
              currentValue: saved.value,
            });
          }
          return null;
        })
        .find(Boolean)
    : undefined;
  const driver = props.provider?.driver ?? props.driver;
  const entries = deriveProviderInstanceEntries(props.providers ?? []);
  const entry = entries.find((candidate) => candidate.instanceId === props.provider?.instanceId);
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, entries);
  const working = ["running", "in_progress", "pending", "waiting"].includes(props.status);
  const failed = ["failed", "error"].includes(props.status);
  const StatusIcon = working
    ? CircleDashedIcon
    : failed
      ? CircleXIcon
      : props.status === "completed"
        ? CheckIcon
        : CircleDashedIcon;
  return (
    <ThreadHoverCard title={props.title}>
      <div className="flex min-w-0 items-center gap-2">
        {props.origin === "bridget_native" ? (
          <BridgetTaskIcon task={nativeTask} className="size-3" />
        ) : null}
        {driver ? (
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={entry?.displayName ?? props.provider?.displayName ?? driver}
            accentColor={entry?.accentColor}
            acpRegistryIconUrl={props.provider?.iconUrl}
            // Same treatment as the sidebar card: accent dot, account in the label.
            showBadge={showInstanceBadge && entry?.accentColor !== undefined}
            badgeContent="none"
            badgeClassName="h-2 min-w-2 px-0"
            iconClassName="size-3 shrink-0 grayscale opacity-60"
          />
        ) : (
          <BotIcon className="size-3 shrink-0" />
        )}
        <span className="inline-flex min-w-0 items-center gap-1 text-foreground/75">
          <span className="min-w-0 truncate">
            {nativeTask ? `${nativeTask.agent_type} · ` : null}
            {showInstanceBadge ? `${modelLabel} · ${entry.displayName}` : modelLabel}
          </span>
          {effort || speed?.speedIcon ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              {effort ? " · " : null}
              {speed?.speedIcon && provider ? (
                <TraitsSpeedIcon provider={provider.driver} speedIcon={speed.speedIcon} size="xs" />
              ) : null}
              {effort}
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-sm font-medium capitalize",
            working
              ? "text-info"
              : failed
                ? "text-error"
                : props.status === "completed"
                  ? "text-success"
                  : "text-muted-foreground",
          )}
        >
          <StatusIcon aria-hidden className="size-3 shrink-0" />
          {props.status.replaceAll("_", " ")}
        </span>
        {props.elapsed}
      </div>
      {props.origin === "bridget_native" ? <BridgetTaskPlacement task={nativeTask} /> : null}
      {nativeTask?.decision ? (
        <span className="block min-w-0 break-words">
          Choix{" "}
          {nativeTask.decision.mode === "automatic"
            ? "automatique"
            : nativeTask.decision.mode === "fallback"
              ? "de repli"
              : "explicite"}{" "}
          · {nativeTask.decision.candidate_id}
          {nativeTask.decision.reason !== undefined ? (
            <span className="block text-xs text-muted-foreground">
              {nativeTask.decision.reason}
            </span>
          ) : null}
        </span>
      ) : null}
      {metadata.map(({ label, value }) => {
        const Icon = label === "Branch" ? GitBranchIcon : FolderIcon;
        return (
          <div key={label} className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">{label}</span>
            <MiddleTruncate value={value} className="flex" showTitle={false} />
          </div>
        );
      })}
      {preview ? (
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={preview} className="flex" showTitle={false} />
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
