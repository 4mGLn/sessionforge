import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Image, Modal, Pressable, ScrollView, SectionList, Text, TextInput, View } from "react-native";
import {
  archiveSessionRpc,
  cleanupSessionsRpc,
  deleteSessionsRpc,
  discoverSessionsRpc,
  listSessionsRpc,
  restoreSessionRpc,
  SessionRelationshipSchema,
  SessionSchema,
  showSessionRpc,
} from "./src/server/session-contracts.shared";
import type { z } from "zod";

type SessionDto = z.infer<typeof SessionSchema>;
type RelationshipDto = z.infer<typeof SessionRelationshipSchema>;
type Tone = "neutral" | "danger" | "accent";

const CATEGORY_FILTERS = ["ALL", "KEEP", "ARCHIVE", "JUNK"] as const;
type CategoryFilter = (typeof CATEGORY_FILTERS)[number];

const AGENT_TAB_ALL = "ALL";

// Matches packages/app/src/styles/theme.ts's FONT_SIZE/SPACING/RADIUS scale and
// packages/app/src/components/ui/control-geometry.ts's button-size tiers, hand-copied
// since a plugin can't import the app's own style modules.
const FONT_SIZE = { sm: 12, base: 14 };
const SPACING = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 };
const RADIUS = { sm: 6, md: 8, lg: 12, full: 999 };
const COLUMN = { status: 88, project: 130, created: 92, active: 84, msgs: 52, size: 68 };

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  aider: "Aider",
  opencode: "OpenCode",
  custom: "Custom",
};

const AGENT_INITIALS: Record<string, string> = {
  "claude-code": "CC",
  codex: "CX",
  "gemini-cli": "GM",
  aider: "AI",
  opencode: "OC",
  custom: "?",
};

// A plugin can't import SVG/icon libraries or fetch external logo assets (the client bundle's
// module whitelist only allows react, react-native, @getpaseo/plugin, @tanstack/react-query, zod
// — see packages/app/src/plugins/evaluate.ts's runtimeRequire), so a literal provider logo isn't
// achievable. This approximates each provider's brand color for a recognizable icon tile instead
// of a flat gray-outlined initials badge — the same fallback pattern most multi-provider tools use
// when they don't have real logo assets to render.
const AGENT_COLORS: Record<string, string> = {
  "claude-code": "#D97757",
  codex: "#10A37F",
  "gemini-cli": "#4C8DF6",
  aider: "#F0B429",
  opencode: "#6366F1",
};

// Real vector marks, ported from Paseo's own packages/app/src/components/icons/*.tsx and
// packages/app/src/assets/acp-provider-icons.ts, rasterized to PNG and embedded as base64 —
// react-native-svg isn't in the plugin sandbox's module whitelist, and core RN <Image> has
// never reliably supported SVG sources (that's why react-native-svg exists as a separate
// rendering pipeline in the first place). Paseo's own desktop code embeds icons the same way
// (data:image/png;base64,...), e.g. packages/desktop/src/main.ts's editor-icon handling.
const CLAUDE_ICON_URI = "data:image/png;base64,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";
const CODEX_ICON_URI = "data:image/png;base64,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";
const GEMINI_ICON_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAABmJLR0QA/wD/AP+gvaeTAAADQ0lEQVR4nOWby29MYRyG36+0CzGoSkms3LogqA0Lt43aYuG2EBIrQomVf4CdhaQhVsQltfAXiISIPRuiRiIRC6EuVeLW6WNx5ui0ptO5nHPe6jzJpNP2TOd5f/3ON+e7HMkI0Aa0OR1mO99cUk7SqKRfLoEW1xsXyUma6xRwF2CRpA6ngLsAXZJWOQXcfUCXjOe/5C/AapkLYAMIwFvgtdvFArCOMVa4PJyd4M6S5ztsFi6AJyUt4IHbJ1OADYxnFFjmcHGdAkcnfB8kHXaIZA7QCXzjXz4Auax9HC3gjKQ5ZX6+UNKxjF2yBVgCfCnz3495D7S7PVMDuFEhfMxlt2cqANuKvf1UFICNbt9EAXLAQBXhY/LAPLd3YgC3aggfc9vtnQjA6TrCx5x0+zcEsJ/onK6XArDPnaMugB7gRwPhY34APe48NQHsAb4nED7mJ3DAnasqgFM01uwnowD0uvNNCtFHXT29fa3cAea7844D2ERtn/ONMgBscucW0A5cBEYyDB8zClwHFjmC54CzwKAh+ETeE7nUNZQONQZfJumIpBOKhq/TiY+S+iRdCyG8qvZFUxYA6FI0aXlQ0uZqXmMGSY8k9Uu6F0LIVzo4AK2KFigXSGpXtFS1UtGixXZJS1PVTZ83kh5KeiYpX3x8Lj6+TpwRovh1lqRW+VeOkiDO0aKx1hvnrNycgSBpjaI5/EOSutNxTJzHkm5IuhtCeJrYXwW6gT7KT2q6+Ubktj6xwBUK0QmcB4askSOGgHNAZ+rByxSiA7hCdVNdSRNfCC3OPHiZQmwFXmYYPg9sceceB9kOhha4804K0Es6w+ER4IQ7X1UAu0l+QuT/mhqjmafEYoBdNDZULgB73TkagqhPqJfjbv9EAG7WEb7f7Z0YwFzgeQ3hX2DYK5AqRBdLzbk4GkN06ToVM3N5XPq7QaLSACrzDRKZbpEJIbyVdKnCIRdCCJ+y8rFAs2+SCiG8k3S1zK/6QgjDWftYYBptlLQBPC4pwH2Xh3Oz9M2S5zPnqq9agLUlLWC52ydzmCY3TNgWPkIIAA/V5PcMPVOTF2BA0m+ngLsAeUkjTgF3AQYlFZwC7gIMK7p52sZ0KABTHpUifwCusn8Y98dyMQAAAABJRU5ErkJggg==";
const OPENCODE_ICON_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAABmJLR0QA/wD/AP+gvaeTAAAA3ElEQVR4nO3bsQkCQRgF4XdiLqKZYGAZxtZgbRZiSfbx28DhwcLugDtfKrsMDy86TSRpYsuvD6vqleQ0qAWxNcAnyWVQC2JHB9AcgA6gOQAdQHMAOoDmAHQArdcAz2WgJPfWUL8BdADNAegAmgPQATQHoANo0w+w73Tvoapune5ec2492GuAa5JHp7vXHFsPTv8IOAAdQHMAOoDmAHQAzQHoAJoD0AE0B6ADaA5AB9AcgA6gOQAdQJt+AH8pSgfQHIAOoDkAHUBzADqA5gB0AG3r9fg7f/6nKUma2heNkhGIZD4+uAAAAABJRU5ErkJggg==";

const AGENT_ICON_URI: Record<string, string> = {
  "claude-code": CLAUDE_ICON_URI,
  codex: CODEX_ICON_URI,
  "gemini-cli": GEMINI_ICON_URI,
  opencode: OPENCODE_ICON_URI,
};

function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

function agentInitials(agent: string): string {
  return AGENT_INITIALS[agent] ?? agent.slice(0, 2).toUpperCase();
}

function formatRelative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function recommendTone(category: NonNullable<SessionDto["classification"]>["category"]): Tone {
  return category === "JUNK" ? "danger" : category === "KEEP" ? "accent" : "neutral";
}

interface SessionPreviewModalProps {
  session: SessionDto;
  relationships: readonly RelationshipDto[];
  theme: PluginSurfaceProps["theme"];
  onClose: () => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
}

function SessionPreviewModal({ session, relationships, theme, onClose, onArchive, onRestore }: SessionPreviewModalProps) {
  const styles = useMemo(
    () => ({
      backdrop: {
        flex: 1,
        backgroundColor: "rgba(0,0,0,0.5)",
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: SPACING[4],
      },
      // Fixed size for every session — content that doesn't fit scrolls inside the body instead
      // of the dialog growing/shrinking per session.
      card: {
        width: 640,
        height: 560,
        maxWidth: "100%" as const,
        maxHeight: "100%" as const,
        backgroundColor: theme.colors.surface0,
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        overflow: "hidden" as const,
        // Pressable purely to swallow backdrop-close clicks; without an explicit cursor,
        // react-native-web renders it (and everything inside it) with a pointer cursor.
        cursor: "auto" as const,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        justifyContent: "space-between" as const,
        gap: SPACING[3],
        padding: SPACING[4],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.foregroundMuted,
      },
      title: { flex: 1, color: theme.colors.foreground, fontSize: FONT_SIZE.base + 2, fontWeight: "700" as const },
      close: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.base },
      body: { flex: 1, padding: SPACING[4] },
      infoRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: SPACING[2],
        marginBottom: SPACING[3],
      },
      infoRowLeft: { flexDirection: "row" as const, alignItems: "center" as const, gap: SPACING[2], flexShrink: 1 },
      agentBadge: (agent: string) => ({
        width: 22,
        height: 22,
        borderRadius: RADIUS.sm,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: AGENT_ICON_URI[agent] ? "transparent" : (AGENT_COLORS[agent] ?? theme.colors.foregroundMuted),
      }),
      agentBadgeText: { color: theme.colors.accentForeground, fontSize: 9, fontWeight: "700" as const },
      agentBadgeIcon: { width: 19, height: 19 },
      metaText: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.sm },
      badge: (tone: Tone) => ({
        alignSelf: "flex-start" as const,
        paddingHorizontal: SPACING[2],
        paddingVertical: 2,
        borderRadius: RADIUS.full,
        borderWidth: 1,
        borderColor: tone === "danger" ? theme.colors.statusDanger : tone === "accent" ? theme.colors.accent : theme.colors.foregroundMuted,
      }),
      badgeText: (tone: Tone) => ({
        fontSize: FONT_SIZE.sm,
        color: tone === "danger" ? theme.colors.statusDanger : tone === "accent" ? theme.colors.accent : theme.colors.foregroundMuted,
      }),
      label: {
        color: theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.sm - 1,
        fontWeight: "700" as const,
        textTransform: "uppercase" as const,
        letterSpacing: 0.5,
        marginTop: SPACING[3],
        marginBottom: SPACING[1],
      },
      value: { color: theme.colors.foreground, fontSize: FONT_SIZE.base, marginBottom: 2 },
      footer: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        gap: SPACING[2],
        padding: SPACING[3],
        borderTopWidth: 1,
        borderTopColor: theme.colors.foregroundMuted,
      },
      chip: {
        paddingHorizontal: SPACING[3],
        height: 28,
        justifyContent: "center" as const,
        borderRadius: RADIUS.full,
        borderColor: theme.colors.foregroundMuted,
        borderWidth: 1,
      },
      chipText: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.sm },
      actionButton: (tone: Tone) => ({
        paddingHorizontal: SPACING[4],
        height: 32,
        justifyContent: "center" as const,
        borderRadius: RADIUS.md,
        backgroundColor: tone === "danger" ? theme.colors.statusDanger : theme.colors.accent,
      }),
      actionButtonText: { color: theme.colors.accentForeground, fontSize: FONT_SIZE.base, fontWeight: "500" as const },
    }),
    [theme],
  );

  const tone = session.classification ? recommendTone(session.classification.category) : "neutral";

  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={2}>
            {session.title ?? session.firstUserMessage ?? "(untitled session)"}
          </Text>
          <Pressable onPress={onClose}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.body}>
          <View style={styles.infoRow}>
            <View style={styles.infoRowLeft}>
              <View style={styles.agentBadge(session.agent)}>
                {AGENT_ICON_URI[session.agent] ? (
                  <Image source={{ uri: AGENT_ICON_URI[session.agent] }} style={styles.agentBadgeIcon} resizeMode="contain" />
                ) : (
                  <Text style={styles.agentBadgeText}>{agentInitials(session.agent)}</Text>
                )}
              </View>
              <Text style={styles.metaText}>
                {agentLabel(session.agent)} · {session.status} · {session.lifecycle}
              </Text>
            </View>
            {session.classification ? (
              <View style={styles.badge(tone)}>
                <Text style={styles.badgeText(tone)}>{session.classification.category}</Text>
              </View>
            ) : null}
          </View>

          {session.summary ? (
            <>
              <Text style={styles.label}>Summary</Text>
              <Text style={styles.value}>{session.summary}</Text>
            </>
          ) : null}

          <Text style={styles.label}>Project</Text>
          <Text style={styles.value}>{session.project}</Text>
          <Text style={styles.value} numberOfLines={1}>
            {session.workspace}
          </Text>
          {session.branch ? <Text style={styles.value}>branch: {session.branch}</Text> : null}

          <Text style={styles.label}>Timing</Text>
          <Text style={styles.value}>Created {formatDateTime(session.createdAt)}</Text>
          <Text style={styles.value}>Last active {formatDateTime(session.lastActivityAt)}</Text>

          <Text style={styles.label}>Activity</Text>
          <Text style={styles.value}>
            {session.messageCount} messages ({session.userMessageCount} user, {session.assistantMessageCount} assistant)
          </Text>
          <Text style={styles.value}>{formatBytes(session.sizeBytes)} on disk</Text>

          {session.firstUserMessage ? (
            <>
              <Text style={styles.label}>First message</Text>
              <Text style={styles.value}>{session.firstUserMessage}</Text>
            </>
          ) : null}

          {session.classification ? (
            <>
              <Text style={styles.label}>Recommendation ({Math.round(session.classification.confidence * 100)}% confidence)</Text>
              <Text style={styles.value}>{session.classification.reason}</Text>
              {session.classification.evidence.map((line, i) => (
                <Text key={i} style={styles.value}>
                  • {line}
                </Text>
              ))}
            </>
          ) : null}

          {relationships.length > 0 ? (
            <>
              <Text style={styles.label}>Related sessions</Text>
              {relationships.map((rel) => {
                const otherId = rel.sessionId === session.id ? rel.relatedSessionId : rel.sessionId;
                const direction =
                  rel.kind === "SUPERSEDED"
                    ? rel.sessionId === session.id
                      ? "Superseded by"
                      : "Supersedes"
                    : "Possible duplicate of";
                return (
                  <View key={`${rel.sessionId}:${rel.relatedSessionId}`} style={{ marginBottom: SPACING[1] }}>
                    <Text style={styles.value}>
                      {direction} {otherId} ({Math.round(rel.confidence * 100)}% confidence)
                    </Text>
                    <Text style={styles.metaText}>{rel.reason}</Text>
                  </View>
                );
              })}
            </>
          ) : null}

          <Text style={styles.label}>Storage</Text>
          <Text style={styles.value} numberOfLines={2}>
            {session.storagePath}
          </Text>
        </ScrollView>
        <View style={styles.footer}>
          <Pressable style={styles.chip} onPress={onClose}>
            <Text style={styles.chipText}>Close</Text>
          </Pressable>
          {session.lifecycle === "ARCHIVED" || session.lifecycle === "JUNK" ? (
            <Pressable style={styles.actionButton("accent")} onPress={() => onRestore(session.id)}>
              <Text style={styles.actionButtonText}>Restore</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.actionButton("danger")} onPress={() => onArchive(session.id)}>
              <Text style={styles.actionButtonText}>Archive</Text>
            </Pressable>
          )}
        </View>
      </Pressable>
    </Pressable>
  );
}

interface ConfirmDialogProps {
  theme: PluginSurfaceProps["theme"];
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Blocking yes/no gate for destructive-feeling actions (bulk archive, cleanup apply). */
function ConfirmDialog({ theme, title, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const styles = useMemo(
    () => ({
      backdrop: {
        flex: 1,
        backgroundColor: "rgba(0,0,0,0.5)",
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: SPACING[4],
      },
      card: {
        width: 420,
        maxWidth: "100%" as const,
        backgroundColor: theme.colors.surface0,
        borderRadius: RADIUS.lg,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        padding: SPACING[4],
        cursor: "auto" as const,
      },
      title: { color: theme.colors.foreground, fontSize: FONT_SIZE.base + 2, fontWeight: "700" as const, marginBottom: SPACING[2] },
      message: { color: theme.colors.foreground, fontSize: FONT_SIZE.base, marginBottom: SPACING[4] },
      actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: SPACING[2] },
      cancel: {
        paddingHorizontal: SPACING[3],
        height: 32,
        justifyContent: "center" as const,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
      },
      cancelText: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.base },
      confirm: {
        paddingHorizontal: SPACING[3],
        height: 32,
        justifyContent: "center" as const,
        borderRadius: RADIUS.md,
        backgroundColor: theme.colors.statusDanger,
      },
      confirmText: { color: theme.colors.accentForeground, fontSize: FONT_SIZE.base, fontWeight: "500" as const },
    }),
    [theme],
  );

  return (
    <Pressable style={styles.backdrop} onPress={onCancel}>
      <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>
        <View style={styles.actions}>
          <Pressable style={styles.cancel} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.confirm} onPress={onConfirm}>
            <Text style={styles.confirmText}>{confirmLabel}</Text>
          </Pressable>
        </View>
      </Pressable>
    </Pressable>
  );
}

export function SessionsSurface({ theme, layout }: PluginSurfaceProps) {
  const listSessions = useRpc(listSessionsRpc);
  const cleanupSessions = useRpc(cleanupSessionsRpc);
  const archiveSession = useRpc(archiveSessionRpc);
  const restoreSession = useRpc(restoreSessionRpc);
  const deleteSessionsRpcCall = useRpc(deleteSessionsRpc);
  const discoverSessions = useRpc(discoverSessionsRpc);
  const showSession = useRpc(showSessionRpc);

  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [relationships, setRelationships] = useState<RelationshipDto[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("ALL");
  const [agentTab, setAgentTab] = useState<string>(AGENT_TAB_ALL);
  const [viewMode, setViewMode] = useState<"list" | "timeline">("list");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [cleanupCandidates, setCleanupCandidates] = useState<SessionDto[] | null>(null);
  const [applyingCleanup, setApplyingCleanup] = useState(false);
  const [bulkArchiving, setBulkArchiving] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [previewSession, setPreviewSession] = useState<SessionDto | null>(null);
  const [previewRelationships, setPreviewRelationships] = useState<RelationshipDto[]>([]);
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; confirmLabel: string; run: () => void } | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  // Pressable's synthetic event doesn't reliably carry the browser's shiftKey in this react-native-web
  // host (the same class of gesture-responder unreliability that forced raw window mouse listeners for
  // the preview dialog's resize handle) — tracking it via raw keydown/keyup is the reliable alternative.
  const shiftPressedRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftPressedRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftPressedRef.current = false;
    };
    const onBlur = () => {
      shiftPressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Relationships aren't in the list payload (kept minimal), so fetch them separately whenever the
  // preview opens on a different session. Keyed on the id, not the object reference, so a refresh that
  // replaces `sessions` with new object identities doesn't trigger a redundant re-fetch.
  const previewSessionId = previewSession?.id ?? null;
  useEffect(() => {
    if (!previewSessionId) {
      setPreviewRelationships([]);
      return;
    }
    let cancelled = false;
    showSession({ id: previewSessionId }).then((result) => {
      if (!cancelled) setPreviewRelationships(result.relationships);
    });
    return () => {
      cancelled = true;
    };
  }, [previewSessionId, showSession]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listSessions(
        category === "ALL" ? { query: query || undefined } : { query: query || undefined, category },
      );
      setSessions(result.sessions);
      setRelationships(result.relationships);
    } finally {
      setLoading(false);
    }
  }, [listSessions, query, category]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rescan = useCallback(async () => {
    setRescanning(true);
    try {
      await discoverSessions({});
      await refresh();
    } finally {
      setRescanning(false);
    }
  }, [discoverSessions, refresh]);

  const previewCleanup = useCallback(async () => {
    const result = await cleanupSessions({ dryRun: true });
    setCleanupCandidates(result.candidates);
  }, [cleanupSessions]);

  const applyCleanup = useCallback(async () => {
    setApplyingCleanup(true);
    try {
      await cleanupSessions({ dryRun: false });
      setCleanupCandidates(null);
      await refresh();
    } finally {
      setApplyingCleanup(false);
    }
  }, [cleanupSessions, refresh]);

  const requestApplyCleanup = useCallback(() => {
    if (!cleanupCandidates || cleanupCandidates.length === 0) return;
    setConfirmAction({
      title: "Move sessions to trash?",
      message: `${cleanupCandidates.length} session(s) will be marked JUNK. Nothing is deleted from disk — only SessionForge's own record of them changes — and you can restore any of them anytime from the JUNK filter.`,
      confirmLabel: "Move to trash",
      run: applyCleanup,
    });
  }, [cleanupCandidates, applyCleanup]);

  const dismissCleanupPreview = useCallback(() => setCleanupCandidates(null), []);

  const sessionLabel = useCallback(
    (id: string) => sessions.find((s) => s.id === id)?.title ?? sessions.find((s) => s.id === id)?.firstUserMessage ?? id,
    [sessions],
  );

  const onArchive = useCallback(
    async (id: string) => {
      setActionError(null);
      try {
        await archiveSession({ id });
        await refresh();
      } catch (error) {
        setActionError(`Could not archive "${sessionLabel(id)}": ${errorMessage(error)}`);
      }
    },
    [archiveSession, refresh, sessionLabel],
  );

  const onRestore = useCallback(
    async (id: string) => {
      setActionError(null);
      try {
        await restoreSession({ id });
        await refresh();
      } catch (error) {
        setActionError(`Could not restore "${sessionLabel(id)}": ${errorMessage(error)}`);
      }
    },
    [restoreSession, refresh, sessionLabel],
  );

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setLastSelectedIndex(null);
  }, []);

  const archiveSelected = useCallback(async () => {
    setActionError(null);
    setBulkArchiving(true);
    try {
      const failures: string[] = [];
      for (const id of selected) {
        try {
          await archiveSession({ id });
        } catch (error) {
          failures.push(`"${sessionLabel(id)}" — ${errorMessage(error)}`);
        }
      }
      clearSelection();
      await refresh();
      if (failures.length > 0) {
        setActionError(`Currently impossible to archive ${failures.length} session(s): ${failures.join("; ")}`);
      }
    } finally {
      setBulkArchiving(false);
    }
  }, [selected, archiveSession, clearSelection, refresh, sessionLabel]);

  const requestArchiveSelected = useCallback(() => {
    if (selected.size === 0) return;
    setConfirmAction({
      title: "Archive selected sessions?",
      message: `${selected.size} session(s) will be archived. Nothing is deleted from disk — only SessionForge's own record of them changes — and you can restore any of them anytime from the ARCHIVE filter.`,
      confirmLabel: "Archive",
      run: archiveSelected,
    });
  }, [selected, archiveSelected]);

  const deleteSelected = useCallback(async () => {
    setActionError(null);
    setBulkDeleting(true);
    try {
      const result = await deleteSessionsRpcCall({ ids: Array.from(selected) });
      clearSelection();
      await refresh();
      if (result.failed.length > 0) {
        const failures = result.failed.map((f) => `"${sessionLabel(f.id)}" — ${f.error}`);
        setActionError(`Currently impossible to delete ${failures.length} session(s): ${failures.join("; ")}`);
      }
    } finally {
      setBulkDeleting(false);
    }
  }, [selected, deleteSessionsRpcCall, clearSelection, refresh, sessionLabel]);

  const requestDeleteSelected = useCallback(() => {
    if (selected.size === 0) return;
    setConfirmAction({
      title: "Delete selected sessions?",
      message: `${selected.size} session(s) will be removed from SessionForge and their files moved to your system's Trash. SessionForge cannot restore them from here — recovery, if any, depends on your OS trash.`,
      confirmLabel: "Delete",
      run: deleteSelected,
    });
  }, [selected, deleteSelected]);

  const agentTabs = useMemo(() => {
    const counts = new Map<string, number>();
    const sizes = new Map<string, number>();
    let totalSize = 0;
    for (const session of sessions) {
      counts.set(session.agent, (counts.get(session.agent) ?? 0) + 1);
      sizes.set(session.agent, (sizes.get(session.agent) ?? 0) + session.sizeBytes);
      totalSize += session.sizeBytes;
    }
    return [
      { key: AGENT_TAB_ALL, label: `All (${sessions.length} · ${formatBytes(totalSize)})` },
      ...Array.from(counts.entries())
        .sort(([a], [b]) => agentLabel(a).localeCompare(agentLabel(b)))
        .map(([agent, count]) => ({
          key: agent,
          label: `${agentLabel(agent)} (${count} · ${formatBytes(sizes.get(agent) ?? 0)})`,
        })),
    ];
  }, [sessions]);

  const visibleSessions = useMemo(
    () => (agentTab === AGENT_TAB_ALL ? sessions : sessions.filter((s) => s.agent === agentTab)),
    [sessions, agentTab],
  );

  /**
   * Cross-agent timeline (GOAL.md §14): groups the same visibleSessions by the day each one was created,
   * days newest-first, sessions within a day oldest-first (reads top-to-bottom as the day's story) — so
   * work from every agent on the same day shows up together instead of siloed by agent tab.
   */
  const timelineSections = useMemo(() => {
    const byDay = new Map<string, SessionDto[]>();
    for (const session of visibleSessions) {
      const day = session.createdAt.slice(0, 10);
      const bucket = byDay.get(day);
      if (bucket) bucket.push(session);
      else byDay.set(day, [session]);
    }
    return Array.from(byDay.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([day, daySessions]) => ({
        title: day,
        data: [...daySessions].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
      }));
  }, [visibleSessions]);

  /** Every relationship touching a given session, from either side — powers the timeline's duplicate/superseded badges. */
  const relationshipsBySessionId = useMemo(() => {
    const map = new Map<string, RelationshipDto[]>();
    const add = (id: string, rel: RelationshipDto) => {
      const bucket = map.get(id);
      if (bucket) bucket.push(rel);
      else map.set(id, [rel]);
    };
    for (const rel of relationships) {
      add(rel.sessionId, rel);
      add(rel.relatedSessionId, rel);
    }
    return map;
  }, [relationships]);

  /**
   * Plain click toggles one row and becomes the new anchor. Shift-click extends the selection to every
   * row between the anchor and this row — the anchor itself stays put across repeated shift-clicks (same
   * convention as file explorers/Gmail), so shift-clicking a nearer row shrinks the range back down instead
   * of extending it further from wherever the previous shift-click landed.
   */
  const toggleSelected = useCallback(
    (id: string, index: number, extendRange: boolean) => {
      if (extendRange && lastSelectedIndex !== null) {
        const start = Math.min(lastSelectedIndex, index);
        const end = Math.max(lastSelectedIndex, index);
        const rangeIds = visibleSessions.slice(start, end + 1).map((session) => session.id);
        setSelected((prev) => new Set([...prev, ...rangeIds]));
        return;
      }

      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastSelectedIndex(index);
    },
    [lastSelectedIndex, visibleSessions],
  );

  const showTable = !layout.compact;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      toolbar: { gap: SPACING[2], padding: layout.compact ? SPACING[3] : SPACING[4] },
      toolbarRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: SPACING[2], flexWrap: "wrap" as const },
      input: {
        flexGrow: 1,
        minWidth: 160,
        height: 32,
        color: theme.colors.foreground,
        fontSize: FONT_SIZE.base,
        borderColor: theme.colors.foregroundMuted,
        borderWidth: 1,
        borderRadius: RADIUS.md,
        paddingHorizontal: SPACING[3],
      },
      tab: (active: boolean) => ({
        paddingHorizontal: SPACING[3],
        height: 28,
        justifyContent: "center" as const,
        borderRadius: RADIUS.lg,
        backgroundColor: active ? theme.colors.accent : "transparent",
      }),
      tabText: (active: boolean) => ({
        color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.base,
        fontWeight: active ? ("500" as const) : ("normal" as const),
      }),
      chip: (active: boolean) => ({
        paddingHorizontal: SPACING[3],
        height: 28,
        justifyContent: "center" as const,
        borderRadius: RADIUS.full,
        backgroundColor: active ? theme.colors.accent : "transparent",
        borderColor: active ? theme.colors.accent : theme.colors.foregroundMuted,
        borderWidth: 1,
      }),
      chipText: (active: boolean) => ({
        color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
        fontSize: FONT_SIZE.sm,
      }),
      // Primary/standalone actions: solid accent, sm control geometry.
      buttonPrimary: {
        paddingHorizontal: SPACING[3],
        height: 32,
        justifyContent: "center" as const,
        borderRadius: RADIUS.md,
        backgroundColor: theme.colors.accent,
      },
      buttonPrimaryText: { color: theme.colors.accentForeground, fontSize: FONT_SIZE.base, fontWeight: "500" as const },
      // Per-row actions: small ghost/outline, lower visual weight than toolbar buttons.
      rowAction: (tone: Tone) => ({
        paddingHorizontal: SPACING[2],
        height: 26,
        justifyContent: "center" as const,
        borderRadius: RADIUS.sm,
        borderWidth: 1,
        borderColor: tone === "danger" ? theme.colors.statusDanger : theme.colors.accent,
      }),
      rowActionText: (tone: Tone) => ({
        fontSize: FONT_SIZE.sm,
        color: tone === "danger" ? theme.colors.statusDanger : theme.colors.accent,
      }),
      actionErrorBanner: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACING[2],
        padding: layout.compact ? SPACING[2] : SPACING[3],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.statusDanger,
      },
      actionErrorText: { flex: 1, color: theme.colors.statusDanger, fontSize: FONT_SIZE.sm },
      actionErrorDismiss: { paddingHorizontal: SPACING[2], paddingVertical: SPACING[1] },
      actionErrorDismissText: { color: theme.colors.statusDanger, fontSize: FONT_SIZE.sm, fontWeight: "500" as const },
      cleanupBanner: {
        padding: layout.compact ? SPACING[3] : SPACING[4],
        gap: SPACING[1],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.statusDanger,
      },
      cleanupBannerTitle: { color: theme.colors.foreground, fontSize: FONT_SIZE.base, marginBottom: SPACING[1] },
      cleanupBannerActions: { flexDirection: "row" as const, gap: SPACING[2], marginTop: SPACING[2] },
      // Floats over the list instead of being inserted inline, so selecting a row never reflows the list.
      bulkBar: {
        position: "absolute" as const,
        left: layout.compact ? SPACING[3] : SPACING[4],
        right: layout.compact ? SPACING[3] : SPACING[4],
        bottom: layout.compact ? SPACING[3] : SPACING[4],
        zIndex: 20,
        elevation: 8,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACING[2],
        paddingHorizontal: SPACING[4],
        paddingVertical: SPACING[3],
        borderRadius: RADIUS.lg,
        backgroundColor: theme.colors.accent,
        shadowColor: "#000",
        shadowOpacity: 0.3,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 4 },
      },
      bulkBarText: { color: theme.colors.accentForeground, fontSize: FONT_SIZE.sm, fontWeight: "500" as const, flex: 1 },
      // On-accent buttons: accentForeground is the token designed to contrast against the accent
      // background, unlike statusDanger/foregroundMuted which assume a surface0 background.
      bulkBarButton: (filled: boolean) => ({
        paddingHorizontal: SPACING[3],
        height: 28,
        justifyContent: "center" as const,
        borderRadius: RADIUS.sm,
        borderWidth: 1,
        borderColor: theme.colors.accentForeground,
        backgroundColor: filled ? theme.colors.accentForeground : "transparent",
      }),
      bulkBarButtonDanger: {
        paddingHorizontal: SPACING[3],
        height: 28,
        justifyContent: "center" as const,
        borderRadius: RADIUS.sm,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        backgroundColor: theme.colors.statusDanger,
      },
      bulkBarButtonDangerText: { fontSize: FONT_SIZE.sm, fontWeight: "500" as const, color: theme.colors.accentForeground },
      bulkBarButtonText: (filled: boolean) => ({
        fontSize: FONT_SIZE.sm,
        fontWeight: "500" as const,
        color: filled ? theme.colors.accent : theme.colors.accentForeground,
      }),
      // Extra bottom padding keeps the last rows from being covered by the floating bulk-select bar.
      listContent: { padding: layout.compact ? SPACING[2] : SPACING[3], paddingBottom: SPACING[6] * 2, gap: SPACING[1] },
      // Rendered as the FlatList's own ListHeaderComponent (see below), so it's a child of the same
      // padded scroll container as every row — no paddingHorizontal of its own, or it'd double up with
      // listContent's padding the same way each row must not add one either. backgroundColor is required
      // because stickyHeaderIndices renders this pinned on top of rows scrolling underneath it.
      headerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACING[3],
        paddingTop: SPACING[1],
        paddingBottom: SPACING[3],
        marginBottom: SPACING[1],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.foregroundMuted,
        backgroundColor: theme.colors.surface0,
      },
      headerText: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.sm, fontWeight: "500" as const },
      // Full-row tint instead of a left accent bar — theme only exposes flat colors, no alpha variants,
      // so the accent's own hex gets an alpha suffix here for a subtle wash rather than a solid fill.
      // userSelect: none stops the browser from treating shift-click as "extend text selection" (its
      // native meaning whenever the click lands near selectable text) — without it, a shift-click's first
      // hit gets consumed by the browser as a text-selection drag instead of reaching the checkbox's press
      // handler, so range-select only took effect on a second click.
      row: (isSelected: boolean) => ({
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: SPACING[3],
        paddingVertical: SPACING[2],
        borderRadius: RADIUS.lg,
        backgroundColor: isSelected ? `${theme.colors.accent}1a` : "transparent",
        userSelect: "none" as const,
      }),
      checkbox: (checked: boolean) => ({
        width: 18,
        height: 18,
        borderRadius: RADIUS.sm,
        borderWidth: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted,
        backgroundColor: checked ? theme.colors.accent : "transparent",
      }),
      checkmark: { color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700" as const },
      // Transparent when a real rasterized logo is available (every currently-supported agent) so the
      // logo sits directly on the row. Falls back to a colored "icon tile" with initials — see
      // AGENT_COLORS above — only for an agent with no logo asset (e.g. a future/custom adapter).
      agentBadge: (agent: string) => ({
        width: 26,
        height: 26,
        borderRadius: RADIUS.md,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: AGENT_ICON_URI[agent] ? "transparent" : (AGENT_COLORS[agent] ?? theme.colors.foregroundMuted),
      }),
      agentBadgeText: { color: theme.colors.accentForeground, fontSize: 10, fontWeight: "700" as const },
      agentBadgeIcon: { width: 22, height: 22 },
      title: { color: theme.colors.foreground, fontSize: FONT_SIZE.base, opacity: 0.86 },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.sm, marginTop: 2 },
      metaRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: SPACING[2], marginTop: 2, flexWrap: "wrap" as const },
      metaText: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.sm },
      col: (width: number) => ({ width, color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.sm }),
      colPrimary: (width: number) => ({ width, color: theme.colors.foreground, fontSize: FONT_SIZE.sm }),
      badge: (tone: Tone) => ({
        alignSelf: "flex-start" as const,
        paddingHorizontal: SPACING[2],
        paddingVertical: 2,
        borderRadius: RADIUS.full,
        borderWidth: 1,
        borderColor: tone === "danger" ? theme.colors.statusDanger : tone === "accent" ? theme.colors.accent : theme.colors.foregroundMuted,
      }),
      badgeText: (tone: Tone) => ({
        fontSize: FONT_SIZE.sm,
        color: tone === "danger" ? theme.colors.statusDanger : tone === "accent" ? theme.colors.accent : theme.colors.foregroundMuted,
      }),
      empty: { color: theme.colors.foregroundMuted, padding: SPACING[6], textAlign: "center" as const, fontSize: FONT_SIZE.base },
      timelineDayHeader: {
        paddingHorizontal: SPACING[3],
        paddingVertical: SPACING[2],
        backgroundColor: theme.colors.surface0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.foregroundMuted,
      },
      timelineDayHeaderText: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.sm, fontWeight: "700" as const },
      timelineEntry: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: SPACING[3],
        paddingVertical: SPACING[2],
        paddingHorizontal: SPACING[3],
        borderRadius: RADIUS.lg,
      },
      timelineEntryMeta: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.sm },
      timelineEntryNote: { color: theme.colors.foreground, fontSize: FONT_SIZE.base, opacity: 0.86, marginTop: 2 },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarRow}>
          <TextInput
            style={styles.input}
            placeholder="Search sessions..."
            placeholderTextColor={theme.colors.foregroundMuted}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={refresh}
          />
          {CATEGORY_FILTERS.map((filter) => (
            <Pressable key={filter} style={styles.chip(category === filter)} onPress={() => setCategory(filter)}>
              <Text style={styles.chipText(category === filter)}>{filter}</Text>
            </Pressable>
          ))}
          <Pressable style={styles.buttonPrimary} onPress={rescan} disabled={rescanning}>
            <Text style={styles.buttonPrimaryText}>{rescanning ? "Scanning..." : "Rescan"}</Text>
          </Pressable>
          <Pressable style={styles.buttonPrimary} onPress={previewCleanup}>
            <Text style={styles.buttonPrimaryText}>Preview cleanup</Text>
          </Pressable>
        </View>
        <View style={styles.toolbarRow}>
          {agentTabs.map((tab) => (
            <Pressable key={tab.key} style={styles.tab(agentTab === tab.key)} onPress={() => setAgentTab(tab.key)}>
              <Text style={styles.tabText(agentTab === tab.key)}>{tab.label}</Text>
            </Pressable>
          ))}
          <View style={{ flex: 1 }} />
          <Pressable style={styles.chip(viewMode === "list")} onPress={() => setViewMode("list")}>
            <Text style={styles.chipText(viewMode === "list")}>List</Text>
          </Pressable>
          <Pressable style={styles.chip(viewMode === "timeline")} onPress={() => setViewMode("timeline")}>
            <Text style={styles.chipText(viewMode === "timeline")}>Timeline</Text>
          </Pressable>
        </View>
      </View>

      {actionError ? (
        <View style={styles.actionErrorBanner}>
          <Text style={styles.actionErrorText}>{actionError}</Text>
          <Pressable style={styles.actionErrorDismiss} onPress={() => setActionError(null)}>
            <Text style={styles.actionErrorDismissText}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}

      {cleanupCandidates ? (
        <View style={styles.cleanupBanner}>
          {cleanupCandidates.length === 0 ? (
            <Text style={styles.metaText}>No junk candidates found.</Text>
          ) : (
            <>
              <Text style={styles.cleanupBannerTitle}>
                {cleanupCandidates.length} session{cleanupCandidates.length === 1 ? "" : "s"} recommended for cleanup — nothing changed yet.
              </Text>
              {cleanupCandidates.slice(0, 5).map((candidate) => (
                <Text key={candidate.id} style={styles.metaText} numberOfLines={1}>
                  • {candidate.title ?? candidate.firstUserMessage ?? "(untitled)"} — {candidate.classification?.reason}
                </Text>
              ))}
              {cleanupCandidates.length > 5 ? <Text style={styles.metaText}>...and {cleanupCandidates.length - 5} more</Text> : null}
            </>
          )}
          <View style={styles.cleanupBannerActions}>
            {cleanupCandidates.length > 0 ? (
              <Pressable style={styles.rowAction("danger")} onPress={requestApplyCleanup} disabled={applyingCleanup}>
                <Text style={styles.rowActionText("danger")}>{applyingCleanup ? "Applying..." : "Move to trash"}</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.chip(false)} onPress={dismissCleanupPreview}>
              <Text style={styles.chipText(false)}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {selected.size > 0 ? (
        <View style={styles.bulkBar}>
          <Text style={styles.bulkBarText}>{selected.size} selected</Text>
          <Pressable style={styles.bulkBarButton(false)} onPress={clearSelection}>
            <Text style={styles.bulkBarButtonText(false)}>Deselect</Text>
          </Pressable>
          <Pressable style={styles.bulkBarButton(true)} onPress={requestArchiveSelected} disabled={bulkArchiving}>
            <Text style={styles.bulkBarButtonText(true)}>{bulkArchiving ? "Archiving..." : "Archive selected"}</Text>
          </Pressable>
          <Pressable style={styles.bulkBarButtonDanger} onPress={requestDeleteSelected} disabled={bulkDeleting}>
            <Text style={styles.bulkBarButtonDangerText}>{bulkDeleting ? "Deleting..." : "Delete selected"}</Text>
          </Pressable>
        </View>
      ) : null}

      {!loading && visibleSessions.length === 0 ? (
        <Text style={styles.empty}>No sessions found. Try Rescan.</Text>
      ) : viewMode === "timeline" ? (
        <SectionList
          sections={timelineSections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderSectionHeader={({ section }) => (
            <View style={styles.timelineDayHeader}>
              <Text style={styles.timelineDayHeaderText}>{formatDate(`${section.title}T00:00:00`)}</Text>
            </View>
          )}
          renderItem={({ item }) => {
            const itemRelationships = relationshipsBySessionId.get(item.id);
            const relationshipLabel = !itemRelationships
              ? null
              : itemRelationships.length === 1
                ? itemRelationships[0].kind
                : `${itemRelationships.length} related`;

            return (
              <Pressable style={styles.timelineEntry} onPress={() => setPreviewSession(item)}>
                <View style={styles.agentBadge(item.agent)}>
                  {AGENT_ICON_URI[item.agent] ? (
                    <Image source={{ uri: AGENT_ICON_URI[item.agent] }} style={styles.agentBadgeIcon} resizeMode="contain" />
                  ) : (
                    <Text style={styles.agentBadgeText}>{agentInitials(item.agent)}</Text>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2] }}>
                    <Text style={styles.timelineEntryMeta}>
                      {agentLabel(item.agent)} · {item.project} · {formatRelative(item.createdAt)}
                    </Text>
                    {relationshipLabel ? (
                      <View style={styles.badge("neutral")}>
                        <Text style={styles.badgeText("neutral")}>{relationshipLabel}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.timelineEntryNote} numberOfLines={2}>
                    {item.summary ?? item.title ?? item.firstUserMessage ?? "(untitled session)"}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      ) : (
        <FlatList
          data={visibleSessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          // The header used to be a sibling View next to FlatList, sized to match it by hand — but a
          // separately-positioned element can never be guaranteed to line up with a scrollable one: once
          // there are enough rows to need a scrollbar, the scrollbar eats a few px from the row area's
          // width while the standalone header keeps its full width, so columns drift out of sync starting
          // wherever the accumulated offset becomes visible. Rendering it as the FlatList's own sticky
          // header instead means it's a child of the exact same scroll container as every row, so the two
          // can never desync regardless of scrollbar width, font metrics, or padding.
          stickyHeaderIndices={showTable ? [0] : undefined}
          ListHeaderComponent={
            showTable ? (
              <View style={styles.headerRow}>
                <View style={{ width: 18 }} />
                {agentTab === AGENT_TAB_ALL ? <View style={{ width: 26 }} /> : null}
                <Text style={[styles.headerText, { flex: 1 }]}>SESSION</Text>
                <Text style={[styles.headerText, styles.col(COLUMN.status)]}>STATUS</Text>
                <Text style={[styles.headerText, styles.col(COLUMN.project)]}>PROJECT</Text>
                <Text style={[styles.headerText, styles.col(COLUMN.created)]}>CREATED</Text>
                <Text style={[styles.headerText, styles.col(COLUMN.active)]}>ACTIVE</Text>
                <Text style={[styles.headerText, styles.col(COLUMN.msgs)]}>MSG</Text>
                <Text style={[styles.headerText, styles.col(COLUMN.size), { textAlign: "right" }]}>SIZE</Text>
                {/* No label needed here — this reserves the same width as each row's Archive/Restore button. */}
                <View style={{ width: 76 }} />
              </View>
            ) : null
          }
          renderItem={({ item, index }) => {
            const isSelected = selected.has(item.id);
            const actionButton =
              item.lifecycle === "ARCHIVED" || item.lifecycle === "JUNK" ? (
                <Pressable style={styles.rowAction("accent")} onPress={() => onRestore(item.id)}>
                  <Text style={styles.rowActionText("accent")}>Restore</Text>
                </Pressable>
              ) : (
                <Pressable style={styles.rowAction("danger")} onPress={() => onArchive(item.id)}>
                  <Text style={styles.rowActionText("danger")}>Archive</Text>
                </Pressable>
              );

            return (
              <View style={styles.row(isSelected)}>
                <Pressable style={styles.checkbox(isSelected)} onPress={() => toggleSelected(item.id, index, shiftPressedRef.current)}>
                  {isSelected ? <Text style={styles.checkmark}>✓</Text> : null}
                </Pressable>
                {agentTab === AGENT_TAB_ALL ? (
                  <View style={styles.agentBadge(item.agent)}>
                    {AGENT_ICON_URI[item.agent] ? (
                      <Image source={{ uri: AGENT_ICON_URI[item.agent] }} style={styles.agentBadgeIcon} resizeMode="contain" />
                    ) : (
                      <Text style={styles.agentBadgeText}>{agentInitials(item.agent)}</Text>
                    )}
                  </View>
                ) : null}

                {showTable ? (
                  <>
                    <Pressable style={{ flex: 1 }} onPress={() => setPreviewSession(item)}>
                      <Text style={styles.title} numberOfLines={1}>
                        {item.title ?? item.firstUserMessage ?? "(untitled session)"}
                      </Text>
                    </Pressable>
                    <View style={[styles.col(COLUMN.status), { gap: 4 }]}>
                      {item.classification ? (
                        <View style={styles.badge(recommendTone(item.classification.category))}>
                          <Text style={styles.badgeText(recommendTone(item.classification.category))}>{item.classification.category}</Text>
                        </View>
                      ) : null}
                      <Text style={styles.metaText} numberOfLines={1}>
                        {item.status}
                      </Text>
                    </View>
                    <Text style={styles.colPrimary(COLUMN.project)} numberOfLines={1}>
                      {item.project}
                    </Text>
                    <Text style={styles.col(COLUMN.created)} numberOfLines={1}>
                      {formatDate(item.createdAt)}
                    </Text>
                    <Text style={styles.col(COLUMN.active)} numberOfLines={1}>
                      {formatRelative(item.lastActivityAt)}
                    </Text>
                    <Text style={[styles.col(COLUMN.msgs), { textAlign: "right" }]}>{item.messageCount}</Text>
                    <Text style={[styles.col(COLUMN.size), { textAlign: "right" }]}>{formatBytes(item.sizeBytes)}</Text>
                    <View style={{ width: 76, alignItems: "flex-end" }}>{actionButton}</View>
                  </>
                ) : (
                  <View style={{ flex: 1 }}>
                    <Pressable onPress={() => setPreviewSession(item)}>
                      <Text style={styles.title} numberOfLines={1}>
                        {item.title ?? item.firstUserMessage ?? "(untitled session)"}
                      </Text>
                      <View style={styles.metaRow}>
                        <Text style={styles.metaText}>{item.status}</Text>
                        {item.classification ? (
                          <View style={styles.badge(recommendTone(item.classification.category))}>
                            <Text style={styles.badgeText(recommendTone(item.classification.category))}>{item.classification.category}</Text>
                          </View>
                        ) : null}
                        <Text style={styles.metaText}>{item.project}</Text>
                        <Text style={styles.metaText}>·</Text>
                        <Text style={styles.metaText}>Created {formatDate(item.createdAt)}</Text>
                        <Text style={styles.metaText}>·</Text>
                        <Text style={styles.metaText}>Active {formatRelative(item.lastActivityAt)}</Text>
                        <Text style={styles.metaText}>·</Text>
                        <Text style={styles.metaText}>{item.messageCount} msgs</Text>
                        <Text style={styles.metaText}>·</Text>
                        <Text style={styles.metaText}>{formatBytes(item.sizeBytes)}</Text>
                      </View>
                    </Pressable>
                    <View style={{ marginTop: SPACING[1], alignSelf: "flex-start" }}>{actionButton}</View>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      <Modal visible={previewSession !== null} transparent animationType="fade" onRequestClose={() => setPreviewSession(null)}>
        {previewSession ? (
          <SessionPreviewModal
            session={previewSession}
            relationships={previewRelationships}
            theme={theme}
            onClose={() => setPreviewSession(null)}
            onArchive={(id) => {
              onArchive(id);
              setPreviewSession(null);
            }}
            onRestore={(id) => {
              onRestore(id);
              setPreviewSession(null);
            }}
          />
        ) : null}
      </Modal>

      <Modal visible={confirmAction !== null} transparent animationType="fade" onRequestClose={() => setConfirmAction(null)}>
        {confirmAction ? (
          <ConfirmDialog
            theme={theme}
            title={confirmAction.title}
            message={confirmAction.message}
            confirmLabel={confirmAction.confirmLabel}
            onCancel={() => setConfirmAction(null)}
            onConfirm={() => {
              const run = confirmAction.run;
              setConfirmAction(null);
              run();
            }}
          />
        ) : null}
      </Modal>
    </View>
  );
}
