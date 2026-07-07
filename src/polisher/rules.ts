/**
 * polisher/rules.ts — deterministic prompt analysis and normalization.
 *
 * The offline layer of the polisher: pure functions, no network, no LLM.
 * `analyzePrompt` scores a draft 0–100 across five dimensions and lists its
 * weak spots; `normalizeText` applies conservative mechanical cleanup (filler
 * interjections, duplicated words, whitespace). Used by RulesPolisher and
 * LayeredPolisher (layered.ts) and by assembly layers (CLI --format json,
 * MCP analyze_prompt) to attach scores and rationale to results.
 *
 * Heuristics are intentionally thin and transparent: the strength of Dictum's
 * polishing stays in the LLM layer; this layer provides a fast, private,
 * dependency-free baseline and a stable score. Imports no project modules.
 *
 * NOTE on regexes: JS `\b` is ASCII-only and never matches inside Cyrillic
 * text, so word detection uses Unicode token scanning and letter-class
 * lookarounds instead.
 */

export type PromptDimension = "clarity" | "specificity" | "structure" | "actionability" | "context"

export type PromptAnalysis = {
  /** Total score normalized to 0–100 (sum of five 0–10 dimensions × 2). */
  score: number
  /** Per-dimension scores, each 0–10. */
  dimensions: Record<PromptDimension, number>
  /** Human-readable weak spots (dimensions scoring ≤ 6), worst first. */
  issues: string[]
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Unicode-aware word tokens (letters/digits plus path-ish glue chars). */
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_./\\-]*/gu

function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? []
}

/** Count non-overlapping matches of `re` in `text` (a fresh lastIndex each call). */
function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

// ── Dictation-noise vocabulary (ru + en) ────────────────────────────────────

/** Single-token fillers, matched against lowercased tokens. */
const FILLER_TOKENS = new Set([
  // ru
  "эм",
  "эмм",
  "ээ",
  "эээ",
  "мм",
  "ммм",
  "ну",
  "вот",
  "типа",
  "короче",
  "значит",
  // en
  "um",
  "umm",
  "uh",
  "uhh",
  "erm",
  "err",
  "hmm",
  "basically",
  "kinda",
  "sorta",
])

/** Multi-word filler phrases, counted on the lowercased text. */
const FILLER_PHRASES = /(?:как бы|в общем|это самое|то есть как его|you know|i mean|sort of)/gu

/** Self-correction / false-start markers. */
const FALSE_STARTS =
  /(?:вернее|точнее|нет,? стой|не так|отмени это|scratch that|actually,? no|wait,? no)/giu

/** Immediately repeated word (case-insensitive), e.g. "это это надо". */
const DUP_WORD = /(?<![\p{L}\p{N}])([\p{L}\p{N}]+)(?:\s+\1)+(?![\p{L}\p{N}])/giu

// ── Concreteness signals ────────────────────────────────────────────────────

const FILE_PATH = /[\w./\\-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|toml|yaml|yml|css|html|wav|sh)\b/gi
const NUMBER = /(?<![\p{L}])\d+(?:[.,]\d+)?(?![\p{L}])/gu
const CODE_IDENT = /(?:[a-z0-9]+_[a-z0-9_]+|[a-z]+[A-Z][A-Za-z]*|--[a-z][\w-]+)/g
const QUOTED = /(?:"[^"\n]{2,}"|'[^'\n]{2,}'|`[^`\n]+`|«[^»\n]{2,}»)/g
const URL = /https?:\/\/\S+/gi

const VAGUE_PHRASES =
  /(?:это самое|та штука|эта штука|эта фигня|что-то такое|как-то так|что-нибудь такое|that thing|this thing|some stuff|stuff like that|something like that)/giu

// ── Task-shape signals ──────────────────────────────────────────────────────

/** Imperative task verbs (ru stems + en), lowercased token prefixes. */
const TASK_VERB_PREFIXES = [
  // ru (stems cover imperative + infinitive forms)
  "сдела",
  "добав",
  "исправ",
  "поправ",
  "почин",
  "напиш",
  "написа",
  "созда",
  "провер",
  "обнов",
  "удал",
  "убер",
  "переимен",
  "рефактор",
  "зарефактор",
  "настро",
  "запуст",
  "реализ",
  "внедр",
  "поменя",
  "измен",
  // ru — analytical / explanatory (asking to explain or analyze is a task too)
  "разбер",
  "покаж",
  "проанализ",
  "опиш",
  "объясн",
  "расскаж",
  "оцен",
  "сравн",
  "уточн",
  "сформулир",
  "исслед",
  "изуч",
  "прораб",
  // en
  "add",
  "fix",
  "write",
  "creat",
  "implement",
  "updat",
  "remov",
  "delet",
  "renam",
  "refactor",
  "make",
  "check",
  "build",
  "run",
  "set",
  "chang",
  "test",
  // en — analytical / explanatory
  "explain",
  "describ",
  "analyz",
  "show",
  "summar",
  "compar",
  "evaluat",
  "clarif",
]

const DELIVERABLE_STEMS = [
  // ru
  "тест",
  "функци",
  "команд",
  "файл",
  "баг",
  "скрипт",
  "кнопк",
  "эндпоинт",
  "документ",
  "коммит",
  "релиз",
  "модул",
  "шаблон",
  "конфиг",
  // en
  "test",
  "function",
  "command",
  "file",
  "bug",
  "script",
  "button",
  "endpoint",
  "doc",
  "commit",
  "release",
  "module",
  "template",
  "config",
  "feature",
  "page",
  "api",
]

const OUTPUT_MARKERS =
  /(?:верни|выведи|выдай|в виде|формат|таблиц|списком|return|output|print|as a list|as json|as markdown)/giu

const CONSTRAINT_MARKERS =
  /(?:чтобы|должн|если|кроме|не лома|не трога|не меня|используй|без изменения|only|must|should|unless|except|don'?t touch|keep the|while keeping|use )/giu

const ENV_MARKERS =
  /(?:bun|node|python|typescript|javascript|react|linux|macos|windows|docker|порт|port|верси|version|v\d+)/giu

const ACCEPTANCE_MARKERS =
  /(?:критери|приемк|приёмк|провер|зелён|done when|acceptance|verify|passes|should pass|works when)/giu

// ── Scoring ─────────────────────────────────────────────────────────────────

function scoreClarity(text: string, tokens: string[]): number {
  const fillers =
    tokens.filter((t) => FILLER_TOKENS.has(t)).length +
    countMatches(text.toLowerCase(), FILLER_PHRASES)
  const falseStarts = countMatches(text, FALSE_STARTS)
  const dups = countMatches(text, DUP_WORD)
  return clamp(Math.round(10 - (fillers * 1.5 + falseStarts * 2 + dups * 2)), 0, 10)
}

function scoreSpecificity(text: string): number {
  const concrete =
    countMatches(text, FILE_PATH) +
    countMatches(text, NUMBER) +
    countMatches(text, CODE_IDENT) +
    countMatches(text, QUOTED) +
    countMatches(text, URL)
  const vague = countMatches(text, VAGUE_PHRASES)
  return clamp(4 + Math.min(6, concrete) - vague * 2, 0, 10)
}

function startsWithTaskVerb(tokens: string[]): boolean {
  return tokens.slice(0, 3).some((t) => TASK_VERB_PREFIXES.some((stem) => t.startsWith(stem)))
}

function scoreStructure(text: string, tokens: string[]): number {
  let score = 0
  if (startsWithTaskVerb(tokens)) score += 3
  if (/^\s*(?:[-*•]|\d+[.)])\s/m.test(text)) score += 2
  if (text.length > 200 && text.includes("\n")) score += 1
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => tokenize(s).length)
    .filter((n) => n > 0)
  const avg = sentences.length ? sentences.reduce((a, b) => a + b, 0) / sentences.length : 0
  if (avg > 0 && avg <= 25) score += 2
  if (sentences.some((n) => n > 60)) score -= 2
  if (tokens.length >= 3 && tokens.length <= 400) score += 2
  return clamp(score, 0, 10)
}

function scoreActionability(text: string, tokens: string[]): number {
  let score = 0
  if (tokens.some((t) => TASK_VERB_PREFIXES.some((stem) => t.startsWith(stem)))) score += 4
  if (tokens.some((t) => DELIVERABLE_STEMS.some((stem) => t.startsWith(stem)))) score += 3
  if (countMatches(text, OUTPUT_MARKERS) > 0) score += 3
  return clamp(score, 0, 10)
}

function scoreContext(text: string): number {
  let score = 0
  score += Math.min(6, countMatches(text, CONSTRAINT_MARKERS) * 2)
  if (countMatches(text, ENV_MARKERS) > 0) score += 2
  if (countMatches(text, ACCEPTANCE_MARKERS) > 0) score += 2
  return clamp(score, 0, 10)
}

const ISSUE_MESSAGES: Record<PromptDimension, string> = {
  clarity: "dictation noise survives — filler words, false starts or repeated words",
  specificity: "few concrete details (files, names, numbers) or vague references",
  structure: "no task-first structure — lead with an imperative, bullet multiple requirements",
  actionability: "the task verb or the expected deliverable is unclear",
  context: "no constraints or acceptance criteria to verify the result against",
}

/**
 * Score a prompt draft 0–100 across five equally-weighted dimensions.
 * Deterministic: the same text always produces the same analysis.
 */
export function analyzePrompt(text: string): PromptAnalysis {
  const tokens = tokenize(text)
  if (tokens.length === 0) {
    return {
      score: 0,
      dimensions: { clarity: 0, specificity: 0, structure: 0, actionability: 0, context: 0 },
      issues: ["empty prompt"],
    }
  }
  const dimensions: Record<PromptDimension, number> = {
    clarity: scoreClarity(text, tokens),
    specificity: scoreSpecificity(text),
    structure: scoreStructure(text, tokens),
    actionability: scoreActionability(text, tokens),
    context: scoreContext(text),
  }
  const issues = (Object.entries(dimensions) as [PromptDimension, number][])
    .filter(([, v]) => v <= 6)
    .sort((a, b) => a[1] - b[1])
    .map(([dim, v]) => `${ISSUE_MESSAGES[dim]} (${dim} ${v}/10)`)
  const total = Object.values(dimensions).reduce((a, b) => a + b, 0) * 2
  return { score: total, dimensions, issues }
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Unambiguous filler interjections only (эм / ммм / um / uh …) with an optional
 * trailing comma. Meaning-bearing words like «ну» or "like" are deliberately
 * left alone — removal is conservative; real rewriting is the LLM's job.
 */
const STRIP_FILLERS =
  /(?<![\p{L}\p{N}])(?:э+м+|э{2,}|м{2,}|у+м+|um+|uh+|erm|err|h+m+)(?![\p{L}\p{N}]),?\s*/giu

/**
 * Conservative mechanical cleanup of a dictated draft: strip unambiguous filler
 * interjections, collapse immediately-repeated words and runs of whitespace,
 * capitalize the first letter. Never rewrites content — deterministic and safe
 * to apply to any text.
 */
export function normalizeText(text: string): string {
  let out = text
  out = out.replace(STRIP_FILLERS, "")
  out = out.replace(DUP_WORD, "$1")
  out = out.replace(/[^\S\n]+/g, " ") // collapse spaces/tabs, keep newlines
  out = out.replace(/\n{3,}/g, "\n\n")
  out = out.replace(/ ([,.!?;:])/g, "$1") // no space before punctuation
  out = out.trim()
  if (out.length > 0) out = out[0]!.toUpperCase() + out.slice(1)
  return out
}
