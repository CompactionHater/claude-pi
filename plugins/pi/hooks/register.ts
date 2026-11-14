import type { Register } from 'claude-code'

// claude-pi: Claude Code with the lean harness of pi (github.com/earendil-works/pi, MIT).
// Pi's tool descriptions and rules, project instructions as the only context, five rarely used tools
// moved behind ToolSearch, and Claude Code's bundled skills hidden from the model. Claude Code's own
// lean prompt is kept where the model has one, without its off-topic parts; the long prompt older models
// get is replaced by Pi's. Works in Code Mode too.

// Pi's tool descriptions, adapted where Claude Code's parameters differ: Edit takes
// old_string/new_string (Pi: edits[]), Bash's timeout is in milliseconds (Pi: seconds).
const DESCRIPTIONS: Record<string, string> = {
  Read: 'Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines. Use offset/limit for large files. When you need the full file, continue with offset until complete.',
  Bash: 'Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated if too long. Optionally provide a timeout in milliseconds.',
  Edit: 'Edit a single file using exact text replacement. old_string must match a unique region of the file exactly, or set replace_all to replace every occurrence. Keep old_string as small as possible while still being unique. The file must have been read first.',
  Write: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. An existing file must have been read first.",
}

// One line per tool in the prompt's tool list (Pi's promptSnippet).
const SNIPPETS: Record<string, string> = {
  Read: 'Read file contents',
  Bash: 'Execute bash commands (ls, grep, find, etc.)',
  Edit: 'Make precise file edits with exact text replacement',
  Write: 'Create or overwrite files',
  Agent: 'Run a task in a subagent, with its own model and effort',
  AskUserQuestion: 'Ask the user to choose between options',
  ToolSearch: 'Load a tool that is not listed here, by name or keyword',
}

// Pi's guidelines per tool, in the order they appear.
const GUIDELINES: Record<string, string> = {
  Bash: 'Use Bash for file operations like ls, rg, find',
  Read: 'Use Read to examine files instead of cat or sed.',
  Edit: 'Use Edit for targeted changes (old_string must match exactly and uniquely).',
  Write: 'Use Write only for new files or complete rewrites.',
  REPL: 'Use REPL to batch independent tool calls (Promise.all), chain them, or filter large output, instead of many separate calls.',
}

// Tools Claude Code sends in full that pi moves behind ToolSearch. Claude Code's deferred-tools note names
// only the tools it defers itself, so pi's rules name these; every other tool keeps Claude Code's placement
// (Agent and AskUserQuestion in front, the rest it defers named in its note). shortcut: Claude Code
// 2.1.325's list; a tool a later version sends in full stays in front until it is added here.
const PI_DEFERS = new Set(['ListAgents', 'ReportFindings', 'ScheduleWakeup', 'Skill', 'Workflow'])
// Engine sections kept under Pi's prompt: auto memory's instructions, a chosen output style, the
// note that a long conversation is summarized rather than ended, the "act, don't re-derive" line and
// the token countdown (CLAUDE_CODE_TOTAL_TOKENS_REMINDER).
const KEPT_SECTIONS = new Set(['memory', 'output_style', 'context_management', 'act_dont_rederive', 'total_tokens'])
// Another plugin's section (`<plugin>:<name>`) is kept too: pi replaces Claude Code's prompt, not
// another plugin's.
const keptSection = (id: string): boolean => KEPT_SECTIONS.has(id) || (id.includes(':') && !id.startsWith('claude-pi:'))
// Lean-prompt sections a coding agent doesn't need: the pronoun rule and the rule on recreating games.
const DROPPED_SECTIONS = new Set(['pronouns', 'original_games'])
// Lines of the lean prompt's environment section about Claude Code the product (its apps, fast mode).
const PRODUCT_LINES = /^ - (Claude Code is available as|Fast mode for Claude Code)[^\n]*\n?/gm
// Auto mode's note to read and edit files through Bash (in either wording), which pi's rules contradict.
const BASH_FOR_FILES = /^(?:You can do much of your work|Do your work) through the Bash tool[^\n]*\n?/m
// Claude Code's bundled skills, hidden from the model as pi lists none of its own; each stays typable as
// /name, and your own skillOverrides entry for one wins. shortcut: Claude Code 2.1.325's bundled list plus
// the four more it lists, so a skill a later version bundles stays listed until it is added here.
const BUNDLED_SKILLS = [
  'artifact-diagramming', 'batch', 'claude-code-docs', 'code-review', 'commit', 'dataviz', 'debug', 'explain-usage',
  'fewer-permission-prompts', 'keybindings-help', 'loop', 'memory-types', 'plugin-authoring', 'pr', 'simplify',
  'update-config', 'verify', 'workflow-authoring', 'claude-api', 'run', 'init', 'security-review',
]
const HIDDEN_SKILLS = Object.fromEntries(BUNDLED_SKILLS.map(name => [name, 'user-invocable-only']))

export const register: Register = on => {
  on('settings.read', async (_$, e, next) => {
    const r = await next(e)
    // A read of one source (a settings file as loaded) stays as written; only the merge gets the default.
    if (e.source || r.value === undefined) return r
    const own = r.value.skillOverrides
    const skillOverrides = { ...HIDDEN_SKILLS, ...(own && typeof own === 'object' && !Array.isArray(own) ? own : {}) }
    // Past 256 entries Claude Code drops the whole key, your own entries with it.
    if (Object.keys(skillOverrides).length > 256) return r
    return { value: { ...r.value, skillOverrides } }
  }).catch(async (_$, e, next) => next(e))

  on('prompt.attachment', { type: 'auto_mode' }, async (_$, e, next) => {
    const r = await next(e)
    if (e.origin.kind !== 'engine' || r.text === null || !BASH_FOR_FILES.test(r.text)) return r
    const text = r.text.replace(BASH_FOR_FILES, '').trim()
    // What is left may be only the note's heading ("While auto mode is active:").
    return { text: text === '' || /^[^\n]*:$/.test(text) ? null : text }
  })

  on('tool.describe', async (_$, e, next) => {
    const r = await next(e)
    const description = DESCRIPTIONS[e.tool] ?? r.description
    return PI_DEFERS.has(e.tool) ? { ...r, description, isDeferred: true } : { ...r, description }
  })

  // The first message carries project instructions (CLAUDE.md) only: no date, email or account context.
  on('prompt.context', async (_$, e, next) => {
    const { blocks } = await next(e)
    return { blocks: blocks.filter(b => b.name === 'claudeMd') }
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    if (e.traits.includes('bare')) return { sections }
    const deferred = e.tools.filter(t => PI_DEFERS.has(t)).sort()
    const rules = [
      ...Object.keys(GUIDELINES).filter(t => e.tools.includes(t)).map(t => GUIDELINES[t]),
      ...(deferred.length > 0 ? [`Also behind ToolSearch, loaded with "select:<name>" before use: ${deferred.join(', ')}`] : []),
      'Be concise in your responses',
      'Show file paths clearly when working with files',
    ]
    const rulesSection = { id: 'claude-pi:rules', scope: 'session' as const, text: `<rules>\n${rules.map(r => `- ${r}`).join('\n')}\n</rules>` }
    // Claude Code's lean prompt (the `lean` trait: Opus 4.8 and later, Sonnet and Haiku 5.5, Fable,
    // unknown models; Code Mode always has it) is about 6,200 characters, and ZCode (top on
    // FrontierHarness v1.1) sends every model almost the same text. It is kept, without its off-topic
    // sections, and Pi's rules follow its shared part. Only the long prompt (about 27,500) is replaced.
    // Told apart by its sections, not `e.traits`: a `$.prompt.compose` for another model (pi-models)
    // carries the session model's traits.
    if (!sections.some(s => s.id === 'doing_tasks')) {
      const kept = sections
        .filter(s => !DROPPED_SECTIONS.has(s.id))
        .map(s => (s.id.startsWith('env_info') ? { ...s, text: s.text.replace(PRODUCT_LINES, '') } : s))
      const at = kept.findIndex(s => s.scope !== 'shared')
      kept.splice(at === -1 ? kept.length : at, 0, rulesSection)
      return { sections: kept }
    }
    const shown = e.tools.filter(t => t in SNIPPETS)
    const tools = shown.map(t => `- ${t}: ${SNIPPETS[t]}`).join('\n')
    return {
      sections: [
        {
          id: 'claude-pi:intro',
          scope: 'shared' as const,
          text: 'You are a coding assistant running inside claude-pi, a coding agent harness. Help users inspect files, run commands, and modify code.',
        },
        { id: 'claude-pi:tools', scope: 'session' as const, text: `<tools>\n${tools}\n\nAdditional tools may be available.\n</tools>` },
        rulesSection,
        { id: 'claude-pi:cwd', scope: 'session' as const, text: `<cwd>\n${await $.session.cwd()}\n</cwd>` },
        // Shared sections must all come first, so a kept one placed after pi's session sections becomes
        // session-scoped. The countdown stays last, as Claude Code places it.
        ...sections.filter(s => keptSection(s.id)).map(s => ({ ...s, scope: 'session' as const })),
      ],
    }
  })
}
