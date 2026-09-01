import type { Session, SessionRelationship } from "./types.server.js";

const SIMILARITY_THRESHOLD = 0.35;
// Below this many significant words, a topic is too vague to compare — short generic titles like "goal"
// or "start goal" produce wildly unstable Jaccard scores from a single coincidental shared word.
const MIN_SIGNIFICANT_WORDS = 3;
// Require this many words in common on top of the ratio threshold, so two long-but-mostly-different
// topics that happen to share exactly one word (already unlikely to clear SIMILARITY_THRESHOLD, but a
// second guard is cheap) can't slip through.
const MIN_SHARED_WORDS = 2;
// Closer together than this, treat the pair as overlapping/parallel effort rather than a clean handoff.
const SEQUENTIAL_GAP_MS = 2 * 60 * 60 * 1000;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "to",
  "of",
  "and",
  "or",
  "in",
  "on",
  "for",
  "with",
  "this",
  "that",
  "i",
  "you",
  "please",
  "can",
  "help",
  "me",
  "my",
  "it",
  "be",
  "at",
  "as",
  "by",
  "from",
  "now",
  "ok",
]);

/**
 * `\p{L}`/`\p{N}` (Unicode letter/number, requires the `u` flag) rather than `[a-z0-9]` — an ASCII-only
 * split silently drops every non-Latin-script character as a "delimiter", which doesn't just mangle
 * non-English text, it actively produces false positives: two Korean-titled sessions about completely
 * different tasks reduced to the *same* single-word set (just the ASCII project name that survived) and
 * scored a false near-perfect match in testing against real bilingual data before this fix.
 */
function tokenize(text: string): string[] {
  // Reject only single-character fragments — a length>2 cutoff (fine for filtering short English filler
  // words, which STOPWORDS already handles explicitly) incorrectly drops meaningful 2-character content:
  // valid Korean words (e.g. "백업" = "backup") and short tech terms ("PR", "UI", "DB") alike.
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * Words from the session's own project name are dropped before comparing two topics — every session in
 * the same workspace shares them by construction (that's the grouping key itself), so counting them as
 * "topic similarity" would mean two totally unrelated sessions in the same repo always look partially
 * related just because they're in that repo.
 */
function significantWords(text: string, projectWords: ReadonlySet<string>): Set<string> {
  return new Set(tokenize(text).filter((word) => !projectWords.has(word)));
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): { similarity: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { similarity: 0, shared: 0 };
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  const union = a.size + b.size - intersection;
  return { similarity: union === 0 ? 0 : intersection / union, shared: intersection };
}

function topic(session: Session): string | null {
  return session.title ?? session.firstUserMessage;
}

function timeWindow(session: Session): [number, number] {
  const start = Date.parse(session.createdAt);
  const end = Date.parse(session.lastActivityAt);
  return [start, Number.isNaN(end) ? start : end];
}

/**
 * Local, heuristic cross-session relationship detection (GOAL.md §7/§8). Groups sessions by `workspace`
 * — the strongest cross-agent correlation key available: different agent tools run from the same project
 * directory report the same workspace path, unlike `project`, which is just that path's basename and can
 * collide across unrelated directories that happen to share a folder name. Within each workspace group,
 * flags pairs whose topic (title, falling back to first user message) overlaps significantly by word,
 * excluding words from the project's own name and requiring both a minimum topic length and a minimum
 * absolute shared-word count (see the constants above — both came from tuning against real, messy,
 * bilingual session data, not guessed):
 *
 * - overlapping/close-together time windows -> DUPLICATE (parallel work on the same thing)
 * - a clean sequential gap (the older session had already gone idle before the newer one started) -> SUPERSEDED
 *
 * No LLM, no network call — matches GOAL.md §20's "prefer local processing". Purely informational: this
 * never mutates a Session's own lifecycle: it's the caller's decision what to do with the result.
 */
export function detectRelationships(sessions: readonly Session[]): SessionRelationship[] {
  const detectedAt = new Date().toISOString();
  const byWorkspace = new Map<string, Session[]>();
  for (const session of sessions) {
    const bucket = byWorkspace.get(session.workspace);
    if (bucket) bucket.push(session);
    else byWorkspace.set(session.workspace, [session]);
  }

  const relationships: SessionRelationship[] = [];

  for (const group of byWorkspace.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const projectWords = new Set(tokenize(sorted[0].project));

    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i];
      const aTopicText = topic(a);
      if (!aTopicText) continue;
      const aWords = significantWords(aTopicText, projectWords);
      if (aWords.size < MIN_SIGNIFICANT_WORDS) continue;
      const [, aEnd] = timeWindow(a);

      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j];
        const bTopicText = topic(b);
        if (!bTopicText) continue;
        const bWords = significantWords(bTopicText, projectWords);
        if (bWords.size < MIN_SIGNIFICANT_WORDS) continue;

        const { similarity, shared } = jaccardSimilarity(aWords, bWords);
        if (similarity < SIMILARITY_THRESHOLD || shared < MIN_SHARED_WORDS) continue;

        const [bStart] = timeWindow(b);
        const confidence = Math.min(0.95, similarity);
        const overlapPct = Math.round(similarity * 100);

        if (bStart - aEnd > SEQUENTIAL_GAP_MS) {
          relationships.push({
            sessionId: a.id,
            relatedSessionId: b.id,
            kind: "SUPERSEDED",
            confidence,
            reason: `Same workspace, similar topic to a later session (${overlapPct}% word overlap) — this one had already gone idle before the newer one started`,
            detectedAt,
          });
        } else {
          relationships.push({
            sessionId: a.id,
            relatedSessionId: b.id,
            kind: "DUPLICATE",
            confidence,
            reason: `Same workspace, similar topic (${overlapPct}% word overlap), and active around the same time`,
            detectedAt,
          });
        }
      }
    }
  }

  return relationships;
}
