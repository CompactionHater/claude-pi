import type { EngineInterface, Register, ToolInfo } from 'claude-code'

// ---- Any Anthropic-compatible Messages endpoint as a Claude Code model ---------------------------
//
// A model id that starts with `local/` is answered by the server the user configured: the text after
// the prefix is the model name sent to it, so `local/Qwen/Qwen3-Coder` asks for `Qwen/Qwen3-Coder`.
// Every model step on such an id, in the main loop or in an agent, is answered by the `turn.step` hook
// below, so the loop stays a real Claude Code loop (its tools, permissions, transcript) and never
// reaches Anthropic. Every other step passes through to the engine untouched.
//
// Users add `local/...` rows to Claude Code's `modelPicker` setting, and may name a `local/...` id in
// an agent file. Requests go to the server's Messages endpoint (`/v1/messages`): the engine's
// conversation is already in that form, so it is sent nearly as it is and the answer streams back into
// the engine. The effort the loop runs at goes out as `output_config.effort` (see refusedEfforts).

const PREFIX = 'local/'
const servedName = (id: string): string => id.slice(PREFIX.length)
const isLocal = (id: string): boolean => id.startsWith(PREFIX)

// The settings the plugin was configured with (plugin.json's userConfig).
type Endpoint = { url: string; apiKey: string; maxTokens: number }

// Room for the thinking before a summary.
const SUMMARY_MAX_TOKENS = 16384
// curl holds 10 MiB in one config line; a body past this goes to curl through a pipe instead (see
// localStream), so nothing touches disk.
const INLINE_BODY_LIMIT = 2_000_000
// Thinking kept per tool call or answer; the oldest goes first.
const REASONING_LIMIT = 2000
// Every local model is sent one system prompt, the one Claude Code composes for Sonnet 5.5 (its lean
// prompt, with pi's edits when pi is on), whatever Claude model its row behaves as: composed for the row
// itself, a row behaving as an older model gets the long prompt, with 12,800 characters of memory
// instructions. asModel then names the model that really answers.
const PROMPT_MODEL = 'claude-sonnet-5-5'
// Sections Claude Code adds for the row's own Claude model or effort, such as Opus 5's
// delivering_work_max, overcorrection and opus5_reduced_delegation: left out, so every row is sent what a
// Sonnet 5.5 row is. shortcut: ids as of Claude Code 2.1.325; one a later version ties to a model shows
// on that model's rows until it is added here.
const ROW_SECTIONS = new Set(['delivering_work_max', 'overcorrection', 'opus5_reduced_delegation', 'original_games', 'heron_brook', 'brook_heron', 'finishing_work'])
const DEFAULT_SYSTEM =
  'You are a coding assistant inside Claude Code. Use the tools to inspect files, run commands and change code.'
const poweredBy = (served: string): string =>
  `\n\nYou are powered by the model named ${served}, served by a model server the user configured.`

type Schema = Record<string, unknown>
const str = (description: string) => ({ type: 'string', description })
// Hand-written schemas, used only when the live tool set cannot be read (see localTools).
const LOCAL_TOOL_SCHEMAS = [
  {
    name: 'Read',
    parameters: {
      type: 'object',
      properties: {
        file_path: str('Absolute path to the file to read'),
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Bash',
    parameters: {
      type: 'object',
      properties: {
        command: str('Shell command to execute'),
        timeout: { type: 'number', description: 'Timeout in milliseconds (optional)' },
        run_in_background: { type: 'boolean', description: 'Run the command in the background' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Edit',
    parameters: {
      type: 'object',
      properties: {
        file_path: str('Absolute path to the file to edit'),
        old_string: str('Exact text to replace; must be unique in the file unless replace_all is set'),
        new_string: str('Replacement text'),
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Write',
    parameters: {
      type: 'object',
      properties: {
        file_path: str('Absolute path to the file to write'),
        content: str('Content to write to the file'),
      },
      required: ['file_path', 'content'],
    },
  },
  // The rest are Claude Code's own tools, which only the main loop has. Parameter names follow the
  // engine's real schemas; the engine validates every call, so a wrong name fails loudly.
  {
    name: 'Agent',
    parameters: {
      type: 'object',
      properties: {
        description: str('A short (3-5 word) description of the task'),
        prompt: str('The task for the agent to perform'),
        subagent_type: str('The agent type to use, from the agent listing'),
        model: { type: 'string', enum: ['sonnet', 'opus', 'haiku', 'fable'], description: 'Model for a Claude agent' },
        run_in_background: { type: 'boolean', description: 'false waits for the result; true (default) runs in the background' },
        isolation: { type: 'string', enum: ['worktree'], description: 'worktree: work in a temporary git worktree' },
      },
      required: ['description', 'prompt'],
    },
  },
  {
    name: 'ListAgents',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'SendMessage',
    parameters: {
      type: 'object',
      properties: {
        to: str('Recipient: a name from ListAgents, "main", or an agentId'),
        summary: str('A 5-10 word label for your own transcript'),
        message: str('Plain text message; make the first line a self-contained sentence'),
        notify_when_idle: { type: 'boolean', description: 'Be told once when a local session goes idle' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'TaskStop',
    parameters: { type: 'object', properties: { task_id: str('The id (or name) of the background task or agent to stop') } },
  },
  {
    name: 'TaskCreate',
    parameters: {
      type: 'object',
      properties: {
        subject: str('A brief title for the task'),
        description: str('What needs to be done'),
        activeForm: str('Present continuous form shown while in progress'),
        metadata: { type: 'object', description: 'Arbitrary metadata' },
      },
      required: ['subject', 'description'],
    },
  },
  {
    name: 'TaskUpdate',
    parameters: {
      type: 'object',
      properties: {
        taskId: str('The id of the task to update'),
        subject: str('New subject'),
        description: str('New description'),
        activeForm: str('Present continuous form shown while in progress'),
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'], description: 'New status' },
        addBlocks: { type: 'array', items: { type: 'string' }, description: 'Task ids this task blocks' },
        addBlockedBy: { type: 'array', items: { type: 'string' }, description: 'Task ids that block this task' },
        owner: str('New owner'),
        metadata: { type: 'object', description: 'Metadata keys to merge; null deletes a key' },
      },
      required: ['taskId'],
    },
  },
  { name: 'TaskList', parameters: { type: 'object', properties: {} } },
  {
    name: 'TaskGet',
    parameters: { type: 'object', properties: { taskId: str('The id of the task') }, required: ['taskId'] },
  },
  {
    name: 'AskUserQuestion',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to ask the user (1-4)',
          items: {
            type: 'object',
            properties: {
              question: str('The complete question, ending with a question mark'),
              header: str('Very short label (max 12 chars)'),
              options: {
                type: 'array',
                description: '2-4 distinct options; no "Other" (it is added)',
                items: {
                  type: 'object',
                  properties: {
                    label: str('Concise choice text (1-5 words)'),
                    description: str('What the option means'),
                    preview: str('Optional markdown preview, single-select only'),
                  },
                  required: ['label', 'description'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow several answers' },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'LSP',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls'],
          description: 'The LSP operation',
        },
        filePath: str('Path to the file'),
        line: { type: 'number', description: 'Line number (1-based)' },
        character: { type: 'number', description: 'Character offset (1-based)' },
        query: str('Symbol name to search for (workspaceSymbol only)'),
      },
      required: ['operation', 'filePath', 'line', 'character'],
    },
  },
  {
    name: 'WebSearch',
    parameters: {
      type: 'object',
      properties: {
        query: str('The search query'),
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never include results from these domains' },
      },
      required: ['query'],
    },
  },
  {
    name: 'WebFetch',
    parameters: {
      type: 'object',
      properties: { url: str('The URL to fetch'), prompt: str('The prompt to run on the fetched content') },
      required: ['url', 'prompt'],
    },
  },
]

// Code Mode's two tools: in Code Mode they are all a model is given; everything else runs in its scripts.
const CODE_MODE_TOOLS = new Set(['REPL', 'Poll'])
// Tools the generated type file does not carry, with their schemas as the API request carries them.
// An agent must end with SubagentHandback; without it the engine asked a routed agent for its report
// forever.
const ENGINE_ONLY_SCHEMAS: [string, Schema][] = [
  ['SubagentHandback', { type: 'object', properties: { message: str('Your full report for your caller') }, required: ['message'] }],
  [
    'REPL',
    {
      type: 'object',
      properties: {
        code: str('JavaScript code to execute. Supports top-level await. State persists across calls.'),
        description: str('Clear, concise description of what this script does in active voice (5-10 words)'),
        timeout: { type: 'number', description: "Optional limit on the script's own running time in milliseconds (default 30000, max 600000)" },
      },
      required: ['code'],
    },
  ],
  ['Poll', { type: 'object', properties: {} }],
]
// The tool descriptions as the engine rendered them for a Claude request: `$.tool.list()` cuts them
// short, and REPL's is its whole API reference, so the whole text is taken where the engine renders it
// (`tool.describe`) and kept in the store for a session whose Claude steps have not rendered it yet.
const fullDescriptions = new Map<string, string>()
let storedDescriptions: Record<string, string> | undefined
// The names the local model was last offered: an MCP tool outside this set has no use for its
// description here.
let offeredTools = new Set<string>()
// A routed orchestrator picks an agent's model by type only: the engine resolves a `model` alias of the
// parent's own family to the parent's model, so an alias under the local model's picker row would run
// on the local model. The Agent schema and REPL's declaration lose it.
const AGENT_MODEL_OVERRIDE = /\n[ \t]*\/\*\* Optional model override[^\n]*\n[ \t]*model\?:[^\n]*/

type FunctionTool = { type: 'function'; function: { name: string; description: string; parameters: unknown } }

const descriptionOf = (name: string, fallback: string): string =>
  (fullDescriptions.get(name) ?? storedDescriptions?.[name] ?? fallback).replace(AGENT_MODEL_OVERRIDE, '')

const asFunctions = (tools: typeof LOCAL_TOOL_SCHEMAS, fallbackOf: (name: string) => string): FunctionTool[] =>
  tools.map(t => ({ type: 'function', function: { name: t.name, description: descriptionOf(t.name, fallbackOf(t.name)), parameters: t.parameters } }))

// An agent on a local model has what a Claude agent has: every tool but Agent (Claude Code agents do
// not spawn agents) and AskUserQuestion (an agent cannot interrupt the user). That includes
// SendMessage, so an agent can report to "main" or to its siblings, and the task list.
const NOT_FOR_AGENTS = new Set(['Agent', 'AskUserQuestion'])

// ---- The local model gets the tool set Claude models get ---------------------------------------
//
// The engine lists its tools (`$.tool.list()`: names and descriptions, no schemas) and writes every
// built-in tool's input type to `.claude-plugin/types/claude-code-tools/index.d.ts` each time this
// plugin loads. The hand-written schemas above are only the fallback: each step the hook builds the
// local model's tool list from the live tool set, parsing the schemas out of that file, so a Claude
// Code update changes the local model's tools with it and nothing here needs re-copying.

// Tools the local model is never given: ToolSearch has nothing to load here.
const NOT_FOR_LOCAL = new Set(['ToolSearch'])
// Parameters the engine's real schema has that the generated type file lacks.
const EXTRA_PROPS: Record<string, Record<string, Schema>> = {
  Agent: {
    run_in_background: { type: 'boolean', description: 'false waits for the result; true (default) runs in the background' },
  },
}

type Tok = { t: 'doc' | 'str' | 'id' | 'p'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++
    } else if (src.startsWith('/**', i)) {
      const j = src.indexOf('*/', i + 3)
      const body = src
        .slice(i + 3, j)
        .split('\n')
        .map(l => l.replace(/^\s*\*? ?/, ''))
        .join(' ')
        .trim()
      out.push({ t: 'doc', v: body })
      i = j + 2
    } else if (src.startsWith('/*', i)) {
      i = src.indexOf('*/', i + 2) + 2
    } else if (src.startsWith('//', i)) {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
    } else if (c === '"' || c === "'") {
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++
        v += src[j] ?? ''
        j++
      }
      out.push({ t: 'str', v })
      i = j + 1
    } else if (/[A-Za-z0-9_$.-]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_$.-]/.test(src[j] ?? '')) j++
      out.push({ t: 'id', v: src.slice(i, j) })
      i = j
    } else {
      out.push({ t: 'p', v: c })
      i++
    }
  }
  return out
}

const withoutMarks = (s: Schema): Schema => {
  if (s['literal'] !== undefined) return { type: 'string', enum: [s['literal']] }
  const { ignore, ...rest } = s
  return rest
}

// Recursive-descent reader for the small TypeScript subset the generated file uses: primitives,
// string-literal unions, Array<T>, T[], inline object types and optional fields with /** docs */.
class TypeReader {
  pos = 0
  toks: Tok[]
  constructor(toks: Tok[]) {
    this.toks = toks
  }
  peek(offset = 0): Tok | undefined {
    return this.toks[this.pos + offset]
  }
  isP(v: string, offset = 0): boolean {
    const t = this.peek(offset)
    return t?.t === 'p' && t.v === v
  }
  next(): Tok {
    const t = this.toks[this.pos++]
    if (!t) throw new Error('unexpected end of type text')
    return t
  }
  expectP(v: string): void {
    const t = this.next()
    if (t.t !== 'p' || t.v !== v) throw new Error(`expected "${v}", got "${t.v}"`)
  }

  union(): Schema {
    const terms = [this.term()]
    while (this.isP('|')) {
      this.next()
      terms.push(this.term())
    }
    const live = terms.filter(s => s['ignore'] !== true)
    if (live.length === 0) return {}
    if (live.length === 1) return live[0]!
    if (live.every(s => s['literal'] !== undefined)) return { type: 'string', enum: live.map(s => s['literal']) }
    return { anyOf: live.map(withoutMarks) }
  }

  term(): Schema {
    let s = this.primary()
    while (this.isP('[') && this.isP(']', 1)) {
      this.next()
      this.next()
      s = { type: 'array', items: withoutMarks(s) }
    }
    if (this.isP('&')) {
      this.next()
      this.term()
      return {}
    }
    return s
  }

  primary(): Schema {
    const t = this.next()
    if (t.t === 'str') return { literal: t.v }
    if (t.t === 'id') {
      switch (t.v) {
        case 'string':
        case 'number':
        case 'boolean':
          return { type: t.v }
        case 'null':
        case 'undefined':
          return { ignore: true }
        case 'Array':
        case 'ReadonlyArray': {
          this.expectP('<')
          const items = this.union()
          this.expectP('>')
          return { type: 'array', items: withoutMarks(items) }
        }
        case 'Record': {
          this.expectP('<')
          this.union()
          this.expectP(',')
          this.union()
          this.expectP('>')
          return { type: 'object' }
        }
        default:
          return {}
      }
    }
    if (t.v === '{') return this.objectBody()
    if (t.v === '(') {
      const s = this.union()
      this.expectP(')')
      return s
    }
    if (t.v === '[') {
      while (!this.isP(']')) this.next()
      this.next()
      return { type: 'array' }
    }
    throw new Error(`unexpected "${t.v}" in a type`)
  }

  // After "{": fields up to the matching "}". Deprecated and unavailable parameters are left out.
  objectBody(): Schema {
    const properties: Record<string, Schema> = {}
    const required: string[] = []
    let doc: string | undefined
    while (!this.isP('}')) {
      if (this.peek()?.t === 'doc') {
        doc = this.next().v
        continue
      }
      if (this.isP(';') || this.isP(',')) {
        this.next()
        continue
      }
      if (this.isP('[')) {
        // index signature: [key: string]: T
        while (!this.isP(']')) this.next()
        this.next()
        this.expectP(':')
        this.union()
        doc = undefined
        continue
      }
      const key = this.next()
      const optional = this.isP('?')
      if (optional) this.next()
      this.expectP(':')
      const schema = withoutMarks(this.union())
      if (!(doc !== undefined && /^(Deprecated|Not available in this build)/i.test(doc))) {
        properties[key.v] = doc ? { ...schema, description: doc } : schema
        if (!optional) required.push(key.v)
      }
      doc = undefined
    }
    this.next()
    return { type: 'object', properties, ...(required.length ? { required } : {}) }
  }
}

/** JSON schemas, by tool name, for every tool in the generated `interface BuiltinToolInputs`. */
function parseToolInputs(dts: string): Record<string, Schema> {
  const at = dts.indexOf('interface BuiltinToolInputs')
  if (at < 0) throw new Error('BuiltinToolInputs not found')
  const reader = new TypeReader(tokenize(dts.slice(dts.indexOf('{', at))))
  reader.expectP('{')
  const tools: Record<string, Schema> = {}
  while (!reader.isP('}')) {
    if (reader.peek()?.t === 'doc') {
      reader.next()
      continue
    }
    const name = reader.next()
    reader.expectP(':')
    reader.expectP('{')
    tools[name.v] = reader.objectBody()
  }
  return tools
}

let parsedTools: Record<string, Schema> | null | undefined
let parsedAt = 0
// A failed read is retried later: the type file is written as the plugin loads, so a read can lose
// the race with it, and it may appear on a later call.
const TYPE_RETRY_MS = 60_000

async function liveToolSchemas($: EngineInterface): Promise<Record<string, Schema> | null> {
  if (parsedTools === undefined || (parsedTools === null && Date.now() - parsedAt >= TYPE_RETRY_MS)) {
    try {
      parsedTools = parseToolInputs(await $.fs.read(`${$.plugin.root}/.claude-plugin/types/claude-code-tools/index.d.ts`))
    } catch {
      parsedTools = null
      parsedAt = Date.now()
    }
  }
  return parsedTools
}

/** The descriptions the engine rendered in an earlier session, kept in the store. */
async function storedToolDescriptions($: EngineInterface): Promise<Record<string, string>> {
  if (storedDescriptions === undefined) {
    try {
      storedDescriptions = ((await $.store.get('toolDescriptions')) as Record<string, string> | undefined) ?? {}
    } catch {
      storedDescriptions = {}
    }
  }
  return storedDescriptions
}

/** The local model's function list for this step: the live tool set, or the schemas above if the
 *  tool list or the type file cannot be read. */
async function localTools($: EngineInterface, isMain: boolean): Promise<FunctionTool[]> {
  storedDescriptions = await storedToolDescriptions($)
  try {
    const parsed = await liveToolSchemas($)
    const listed = parsed ? await $.tool.list() : []
    const hand = new Map([...LOCAL_TOOL_SCHEMAS.map(t => [t.name, t.parameters as Schema] as const), ...ENGINE_ONLY_SCHEMAS])
    const codeMode = listed.some(t => t.name === 'REPL')
    // The engine adds SubagentHandback to an agent's own tools, not to the session's list; an agent it
    // is not active for is told so by the engine and reports as plain text.
    const handback: ToolInfo[] = isMain || codeMode
      ? []
      : [{ name: 'SubagentHandback', description: 'Deliver your full report to your caller. The call ends your run, so make it your last.', mcp: false }]
    const fns = [...listed, ...handback]
      .filter(t => {
        if (codeMode) return CODE_MODE_TOOLS.has(t.name)
        if (NOT_FOR_LOCAL.has(t.name)) return false
        // An MCP server's tool is not offered: `ToolInfo.inputSchema` is never on a tool the session
        // lists, so there is no schema to send. Other tools need one from the type file or the table.
        if (t.mcp) return false
        return isMain || !NOT_FOR_AGENTS.has(t.name)
      })
      .flatMap(t => {
        const base = parsed?.[t.name] ?? hand.get(t.name)
        if (!base) return []
        const extra = EXTRA_PROPS[t.name]
        const parameters = extra
          ? { ...base, properties: { ...(base['properties'] as Schema), ...extra } }
          : base
        if (t.name === 'Agent') delete (parameters['properties'] as Schema)['model'] // a copy: Agent has EXTRA_PROPS
        requiredOf.set(t.name, new Set(((parameters as Schema)['required'] as string[] | undefined) ?? []))
        return [{ type: 'function' as const, function: { name: t.name, description: descriptionOf(t.name, t.description), parameters } }]
      })
    if (fns.length > 0) {
      offeredTools = new Set(fns.map(f => f.function.name))
      return fns
    }
  } catch {
    // fall through to the schemas above
  }
  // No schemas to be had: the hand-written ones, with the descriptions the session lists (cut short).
  let short = new Map<string, string>()
  try {
    short = new Map((await $.tool.list()).map(t => [t.name, t.description] as const))
  } catch {
    // no tool list either: the descriptions the engine rendered before, or none
  }
  const fns = asFunctions(
    isMain ? LOCAL_TOOL_SCHEMAS : LOCAL_TOOL_SCHEMAS.filter(t => !NOT_FOR_AGENTS.has(t.name)),
    name => short.get(name) ?? '',
  )
  offeredTools = new Set(fns.map(f => f.function.name))
  return fns
}

type Block = { type: string; [key: string]: unknown }
type Message = { role: string; content: string | Block[] }

const blocksOf = (content: string | Block[]): Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content

const parseArgs = (json: string): unknown => {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {}
  }
}

// The engine believes the main model is the Claude model its picker row behaves as and says so in its
// reminders. The model that really answers is told what it is instead, so it does not claim to be Claude.
// Each sentence ends at a period followed by whitespace, so a name with a dot in it ("Opus 4.5") stays
// whole and the match never runs into the text after it.
const IDENTITY_SENTENCE =
  /You are (?:currently )?powered by the model(?: named)? [^\n]*?\.(?=\s|$)(?: The exact model ID is [^\n]*?\.(?=\s|$))?(?: (?:Assistant knowledge cutoff|Your innate base knowledge cutoff) is [A-Za-z]+ \d{4}\.)?/g

const asModel = (text: string, name: string): string =>
  text.replace(IDENTITY_SENTENCE, () => `You are powered by the model named ${name}.`)

/** A data: or http(s) URL for an Anthropic-form image block, or null when it has no usable source. */
const imageUrlOf = (b: unknown): string | null => {
  const s = (b as Block | undefined)?.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined
  if (!s) return null
  if (s.type === 'base64' && s.data) return `data:${s.media_type ?? 'image/png'};base64,${s.data}`
  if (s.type === 'url' && s.url) return s.url
  return null
}

// A model that is not given an image will invent what it "sees", so images are passed on: pasted ones
// ride in their user message, and a tool result's in the result itself, behind a line that says so.
const TOOL_IMAGE_NOTE = 'Attached image(s) from tool result:'

// Optional parameters a model fills with "" or null (the Read tool's `pages`, for one) are not
// meant as values; the engine rejects them. Required ones are kept.
const requiredOf = new Map<string, Set<string>>()

function cleanArgs(name: string, json: string): string {
  try {
    const args = JSON.parse(json || '{}')
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return json
    const required = requiredOf.get(name)
    if (!required) return json // unknown tool: nothing says which parameters are optional
    for (const [k, v] of Object.entries(args)) {
      if ((v === '' || v === null) && !required.has(k)) delete args[k]
    }
    return JSON.stringify(args)
  } catch {
    return json
  }
}

// The server needs the model's earlier reasoning replayed, and its chat template keeps every turn's,
// so a reply replayed without it no longer matches the cached prefix. The engine does not record
// thinking this plugin streams, so it is remembered here: by the first tool-call id of a step that
// called tools, by `text:<answer>` for one that only answered.
const reasoningKey = (blocks: Block[]): string | undefined => {
  const call = blocks.find(b => b.type === 'tool_use')
  if (call) return String(call.id)
  const text = blocks.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('')
  return text ? `text:${text}` : undefined
}

/** What the local model gets for a document block (a PDF the Read tool returned): its text, or a note. */
const documentNote = (b: Block): Block => {
  const s = b.source as { type?: string; data?: string; media_type?: string } | undefined
  if (s?.type === 'text' && typeof s.data === 'string') return { type: 'text', text: s.data }
  return {
    type: 'text',
    text: `[A ${s?.media_type ?? 'document'} attachment is left out: the local model cannot read it. Extract its text with a command (pdftotext for a PDF) instead.]`,
  }
}

/** A tool result's content as the Messages endpoint takes it: text and images (it drops anything else). */
function resultContent(content: unknown): string | Block[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const blocks = (content as Block[]).flatMap((b): Block[] => {
    if (b?.type === 'text') return [{ type: 'text', text: String(b.text ?? '') }]
    if (b?.type === 'image' && imageUrlOf(b)) return [{ type: 'image', source: b.source }]
    if (b?.type === 'document') return [documentNote(b)]
    return []
  })
  if (blocks.some(b => b.type === 'image')) blocks.unshift({ type: 'text', text: TOOL_IMAGE_NOTE })
  return blocks
}

// Claude Code's API-form messages as the Messages endpoint takes them. The server validates block
// types strictly (text, image, tool_use, tool_result, thinking, redacted_thinking and tool_reference;
// anything else is a 400), so every block is rebuilt from the fields it needs.
function toVllm(messages: Message[], reasoning: Map<string, string>, served: string): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    const blocks = blocksOf(m.content)
    const content: Block[] = []
    if (m.role === 'assistant') {
      const key = reasoningKey(blocks)
      const thought = key === undefined ? undefined : reasoning.get(key)
      if (thought && !blocks.some(b => b.type === 'thinking')) content.push({ type: 'thinking', thinking: thought })
      for (const b of blocks) {
        if (b.type === 'thinking' && typeof b.thinking === 'string') content.push({ type: 'thinking', thinking: b.thinking })
        else if (b.type === 'text' && String(b.text ?? '') !== '') content.push({ type: 'text', text: String(b.text) })
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input ?? {} })
        // redacted thinking and server-side tool blocks carry nothing the local model can use
      }
      if (content.length > 0) out.push({ role: 'assistant', content })
      continue
    }
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        content.push({
          type: 'tool_result',
          tool_use_id: String(b.tool_use_id),
          content: resultContent(b.content),
          ...(b.is_error === true ? { is_error: true } : {}),
        })
      } else if (b.type === 'text') {
        const text = String(b.text ?? '')
        if (text !== '') content.push({ type: 'text', text: asModel(text, served) })
      } else if (b.type === 'image') {
        if (imageUrlOf(b)) content.push({ type: 'image', source: b.source })
      } else if (b.type === 'document') {
        content.push(documentNote(b))
      }
    }
    if (content.length > 0) out.push({ role: 'user', content })
  }
  return out
}

// A config value cannot carry a control character: curl would read it as a line break.
const CONTROL = /[\u0000-\u001f\u007f]/

/** True for a host a proxy must not be used for: the machine's own network (loopback, private and
 *  link-local addresses), a `.local` name, or a single-label name. */
function noProxyHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::1') return true
  if (h.includes(':')) {
    const first = Number.parseInt(h.split(':')[0] ?? '', 16)
    // IPv6: fc00::/7 (unique local) and fe80::/10 (link-local).
    return Number.isFinite(first) && ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80)
  }
  if (!h.includes('.') || h.endsWith('.local')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!v4) return false
  const a = Number(v4[1])
  const b = Number(v4[2])
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

// The server is reached with curl: plugin http can be refused when nonessential traffic is disabled,
// and curl sends a key safely. The key travels in a config read from stdin, never argv (so not in
// `ps`); a target on the machine's own network is dialed with no proxy, so a proxy variable in the
// environment never sees the key. Any http: or https: URL is accepted.
function curlConfig(endpoint: Endpoint, body?: string): string {
  if (CONTROL.test(endpoint.url)) throw new Error('the url setting contains a control character')
  if (CONTROL.test(endpoint.apiKey)) throw new Error('the apiKey setting contains a control character')
  let target: URL
  try {
    target = new URL(endpoint.url)
  } catch {
    throw new Error('the url setting is not a URL')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error(`refusing ${target.protocol} url`)
  const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const lines = [`url = ${quote(target.href)}`]
  if (endpoint.apiKey) {
    lines.push(`header = ${quote(`authorization: Bearer ${endpoint.apiKey}`)}`, `header = ${quote(`x-api-key: ${endpoint.apiKey}`)}`)
  }
  lines.push(
    'header = "anthropic-version: 2023-06-01"',
    'request = "POST"',
    'header = "content-type: application/json"',
  )
  // The body is inline for a small request; a large one is piped on fd 3 and named on curl's command
  // line (`--data-binary @/dev/fd/3`), so it never enters a config line or a file.
  if (body !== undefined) lines.push(`data-raw = ${quote(body)}`)
  if (noProxyHost(target.hostname)) lines.push('noproxy = "*"')
  lines.push('no-buffer', 'silent', 'show-error', 'connect-timeout = 15', 'write-out = "\\n%{http_code}"')
  return lines.join('\n')
}

/** The user's Claude config folder: CLAUDE_CONFIG_DIR, else the home folder's .claude. */
async function configDir($: EngineInterface): Promise<string> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return `${home ?? ''}/.claude`
}

/** Text from a server for a person to read: no terminal colours or other control characters (C0 and
 *  C1), the newlines kept. */
const serverText = (text: string): string =>
  text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u0080-\u009f]/g, '')

type LocalUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
type LocalCall = { id: string; name: string; json: string; delta?: boolean }
type LocalAnswer = {
  thinking: string
  text: string
  calls: LocalCall[]
  stopReason: string | null
  usage: LocalUsage | null
  error?: string
  nextIndex: number // the next free block index, for a closing error note
}

const anthropicTools = (fns: FunctionTool[]) =>
  fns.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }))

/**
 * One streamed request to the configured Messages endpoint. Yields the engine's chunks as the events
 * arrive (thinking and text as they stream, a tool call whole at the end of its block, so empty
 * optional arguments can be dropped first) and returns what the step said.
 */
async function* localStream($: EngineInterface, endpoint: Endpoint, request: Record<string, unknown>) {
  const out: LocalAnswer = { thinking: '', text: '', calls: [], stopReason: null, usage: null, nextIndex: 0 }
  // The server's block index to the engine's, given out at a block's first chunk so it has no gaps.
  const blocks = new Map<number, { type: string; index?: number; call?: LocalCall }>()
  const indexOf = (b: { index?: number }) => (b.index ??= out.nextIndex++)
  let pending = ''
  let stderr = ''
  let code: number | null = null
  let ended = false
  // Debugging: with PI_MODELS_DUMP set to a directory, each request body (the conversation, no key) is
  // written there. Unset, nothing is written.
  const dumpDir = await $.env.get('PI_MODELS_DUMP')
  if (dumpDir) {
    const text = JSON.stringify(request, null, 1)
    const path = `${dumpDir}/request-${Date.now()}.json`
    try {
      await $.process.run(['sh', '-c', 'umask 077; cat > "$1"', 'sh', path], { stdin: text })
    } catch {
      // No sh (Windows): the same file through the engine's write. Debugging only, so a failure is not
      // the step's.
      await $.fs.write(path, text).catch(() => undefined)
    }
  }
  const body = JSON.stringify({ ...request, stream: true })
  const inline = body.length <= INLINE_BODY_LIMIT
  const config = curlConfig(endpoint, inline ? body : undefined)
  let child: ReturnType<typeof $.process.spawn>
  try {
    // A small body rides in the config line (so no shell is needed, as on Windows); a large one is
    // piped: the config, key included, comes to curl from a shell builtin, and the body on fd 3, so
    // neither is ever an argument or a file. `printf` is a builtin in sh, dash and bash. The engine's
    // stdin is a socket, which Linux can't reopen as /dev/fd/3, so `cat` turns it into a pipe first.
    child = inline
      ? $.process.spawn({ argv: ['curl', '-K', '-'], input: config })
      : $.process.spawn({
          // The shell drops the variable before starting cat and curl, so only sh's own environment holds it.
          argv: ['sh', '-c', 'c=$PI_MODELS_CURL_CONFIG; unset PI_MODELS_CURL_CONFIG; cat | { exec 3<&0; printf "%s" "$c" | curl -K - --data-binary @/dev/fd/3; }', 'sh'],
          env: { PI_MODELS_CURL_CONFIG: config },
          input: body,
        })
  } catch (err) {
    if (!inline) {
      out.error = `requests over the inline limit need sh (${String(err).slice(0, 200)})`
      return out
    }
    throw err
  }
  // SSE framing accepts CRLF and bare CR as line endings. A trailing CR waits for the next piece (it
  // may pair with an LF); at the end of the stream it is a line ending too, so the last event is read.
  async function* drain(final: boolean) {
    if (pending.endsWith('\r')) {
      pending = final ? pending.replace(/\r\n?/g, '\n') : `${pending.slice(0, -1).replace(/\r\n?/g, '\n')}\r`
    } else {
      pending = pending.replace(/\r\n?/g, '\n')
    }
    let stopped = false
    for (let cut = pending.indexOf('\n\n'); cut >= 0; cut = pending.indexOf('\n\n')) {
      const raw = pending.slice(0, cut)
      pending = pending.slice(cut + 2)
      const data = raw
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart())
        .join('')
      if (!data) continue
      let ev: any
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      if (ev.type === 'message_start') {
        // The input count is sent once, at the start; a delta carries only the output count.
        if (ev.message?.usage) out.usage = { ...ev.message.usage }
      } else if (ev.type === 'content_block_start') {
        const cb = ev.content_block ?? {}
        const b: { type: string; index?: number; call?: LocalCall } = { type: String(cb.type) }
        blocks.set(ev.index, b)
        if (cb.type === 'tool_use') {
          const input = cb.input
          const whole = input && typeof input === 'object' && Object.keys(input).length > 0
          b.call = { id: String(cb.id), name: String(cb.name), json: whole ? JSON.stringify(input) : '' }
        }
      } else if (ev.type === 'content_block_delta') {
        const b = blocks.get(ev.index)
        const d = ev.delta ?? {}
        if (!b) continue
        if (d.type === 'thinking_delta' && d.thinking) {
          out.thinking += d.thinking
          yield { kind: 'thinking' as const, index: indexOf(b), text: String(d.thinking) }
        } else if (d.type === 'text_delta' && d.text) {
          out.text += d.text
          yield { kind: 'text' as const, index: indexOf(b), text: String(d.text) }
        } else if (d.type === 'input_json_delta' && b.call) {
          // Deltas spell the input out whole, so they replace one a start block already carried. An
          // empty delta does not start that: a start block's whole input must survive it.
          const partial = String(d.partial_json ?? '')
          if (partial !== '') {
            if (!b.call.delta) {
              b.call.delta = true
              b.call.json = ''
            }
            b.call.json += partial
          }
        }
      } else if (ev.type === 'content_block_stop') {
        // A tool call goes to the engine whole, so a stream cut short never leaves half of one.
        const b = blocks.get(ev.index)
        if (b?.call) {
          b.call.json = cleanArgs(b.call.name, b.call.json || '{}')
          out.calls.push(b.call)
          yield { kind: 'tool' as const, index: indexOf(b), id: b.call.id, name: b.call.name }
          yield { kind: 'input' as const, index: indexOf(b), json: b.call.json }
        }
      } else if (ev.type === 'message_delta') {
        out.stopReason = ev.delta?.stop_reason ?? out.stopReason
        if (ev.usage) out.usage = { ...(out.usage ?? {}), ...ev.usage }
      } else if (ev.type === 'message_stop') {
        ended = true
        stopped = true
      } else if (ev.type === 'error') {
        out.error = `the server reported: ${serverText(String(ev.error?.message ?? data)).slice(0, 300)}`
        stopped = true
      }
      if (stopped) break
    }
    return stopped
  }
  let stoppedStream = false
  let started = false
  try {
    for (;;) {
      let piece: Awaited<ReturnType<typeof child.next>>
      try {
        piece = await child.next()
      } catch (err) {
        // A spawn rejects its first pull when the command cannot start: for the piped form that is a
        // missing `sh`, which the person can act on. A later rejection is an ordinary failure.
        if (!inline && !started) {
          out.error = `requests over the inline limit need sh (${String(err).slice(0, 200)})`
          break
        }
        throw err
      }
      started = true
      if (piece.done) {
        code = piece.value?.code ?? null
        break
      }
      if (piece.value.stream === 'stderr') {
        stderr += piece.value.text
        continue
      }
      pending += piece.value.text
      if (yield* drain(false)) {
        stoppedStream = true
        break
      }
    }
  } finally {
    // Leaving early (the step was interrupted, or the stream said it was done) ends curl too.
    if (code === null) await child.return(undefined as never).catch(() => undefined)
  }
  // A bare CR held at the end of the stream is a line ending; read the last event before the status.
  if (!stoppedStream) yield* drain(true)
  // After the stream comes write-out's "\n<status>"; before it, the error body when the server refused.
  if (out.error === undefined && !ended) {
    const cut = pending.lastIndexOf('\n')
    const status = Number(pending.slice(cut + 1))
    if (status !== 200 && status > 0) {
      out.error = `local model server answered ${status}: ${serverText(pending.slice(0, Math.max(0, cut))).trim().slice(0, 300)}`
    } else if (code !== 0) {
      out.error = `curl exited ${code ?? 'on a signal'}: ${serverText(stderr).trim().slice(-300) || 'no output'}`
    } else {
      out.error = 'the stream ended before the answer was complete'
    }
  }
  return out
}

// ---- Compaction by the local model itself -----------------------------------------------------
//
// The engine compacts a conversation (`/compact`, or when it judges the context full) with a model
// request of its own, under the session's model name: for a `local/...` id that request would reach
// Anthropic. For a loop whose latest step was routed, `session.compact` answers instead: the local
// model writes the summary, which becomes the conversation (a single user message). Failure skips the
// compaction; it never falls back to Anthropic.

const SUMMARY_SYSTEM = 'You write handoff summaries of coding-agent sessions so the work can continue from the summary alone.'
const SUMMARY_PROMPT =
  'Summarize the conversation above for the agent that continues it. Cover: the goal and constraints the user gave; decisions made and why; the files, commands, identifiers, numbers and results that matter, with exact paths and values; what is done, what is in progress, and the next steps. Plain sentences, under 600 words, no preamble.'

// An agent file's body is the agent's system prompt under Claude; a local agent gets it too, after the
// session's prompt. Its frontmatter's `model:` says which model the agent runs, which after a plugin
// reload is the only record of a local agent's model. Project agents win over the user's, as in Claude
// Code.
// shortcut: reads the project's and the user's agents folders, not a plugin's agents; add those if asked.
type AgentDefinition = { body: string; model: string }
const agentBodies = new Map<string, AgentDefinition>()
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
async function agentDefinition($: EngineInterface, agentId: string): Promise<AgentDefinition> {
  const known = agentBodies.get(agentId)
  if (known !== undefined) return known
  const type = (await $.agent.list()).find(a => a.id === agentId)?.type
  let def: AgentDefinition = { body: '', model: '' }
  if (type) {
    const dirs = [`${await $.session.root()}/.claude/agents`, `${await configDir($)}/agents`]
    search: for (const dir of dirs) {
      for (const f of await $.fs.list(dir).catch(() => [])) {
        if (!f.name.endsWith('.md')) continue
        const m = FRONTMATTER.exec(await $.fs.read(`${dir}/${f.name}`).catch(() => ''))
        const [, head = '', rest = ''] = m ?? []
        const name = head.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1]
        if (m && name === type) {
          def = {
            body: rest.trim(),
            model: head.match(/^model:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1] ?? '',
          }
          break search
        }
      }
    }
  }
  agentBodies.set(agentId, def)
  return def
}

/** The system prompt a routed step gets: the engine's own composition for this model and these tools,
 *  or a short fallback when it cannot be composed, then an agent's own definition, plus what model
 *  really answers. */
async function stepSystem($: EngineInterface, model: string, served: string, tools: FunctionTool[], agentId?: string): Promise<string> {
  let base: string
  try {
    const { sections } = await $.prompt.compose({ model: PROMPT_MODEL, tools: tools.map(t => t.function.name) })
    base = asModel(sections.filter(s => !ROW_SECTIONS.has(s.id)).map(s => s.text).join('\n\n'), served)
  } catch {
    base = DEFAULT_SYSTEM
  }
  const body = agentId ? (await agentDefinition($, agentId)).body : ''
  return `${base}${body ? `\n\n${body}` : ''}${poweredBy(served)}`
}

async function summarize(
  $: EngineInterface,
  agentId: string | undefined,
  model: string,
  endpoint: Endpoint,
  instructions: string | undefined,
): Promise<string> {
  const history = agentId
    ? await $.session.messages({ agentId, as: 'api' })
    : await $.session.messages({ as: 'api' })
  if (!Array.isArray(history)) throw new Error(`cannot read the conversation (${history.deny})`)
  const isMain = agentId === undefined
  const served = servedName(model)
  const ask = instructions ? `${SUMMARY_PROMPT}\n\nPay particular attention to: ${instructions}` : SUMMARY_PROMPT
  // The steps' own system prompt and tools, so the whole conversation is a cached prefix and only the
  // request at its end is new; tool_choice "none" keeps the tools in the prompt but out of the answer.
  const tools = await localTools($, isMain)
  // No output_config: the server's own default effort applies, so a template that refuses an effort
  // level cannot break compaction.
  const stream = localStream(
    $,
    endpoint,
    {
      model: served,
      system: await stepSystem($, model, served, tools, agentId),
      ...(tools.length > 0 ? { tools: anthropicTools(tools), tool_choice: { type: 'none' } } : {}),
      messages: [
        ...toVllm(history as Message[], reasoning, served),
        { role: 'user', content: [{ type: 'text', text: `${SUMMARY_SYSTEM}\n\n${ask}` }] },
      ],
      max_tokens: Math.min(endpoint.maxTokens, SUMMARY_MAX_TOKENS),
    },
  )
  let step = await stream.next()
  while (!step.done) step = await stream.next()
  const res = step.value
  if (res.error) throw new Error(res.error)
  const text = res.text.trim()
  if (!text) {
    throw new Error(res.stopReason === 'max_tokens' ? 'the local model used up its tokens before writing the summary' : 'the local model returned no summary')
  }
  return text
}

// The effort the loop runs at (/effort, or an agent's type or Agent call) arrives as `e.effort` and
// goes to the server as it is: what each name means is the server's template's business. A name the
// template refuses (HTTP 400 naming effort or output_config) is left out from then on, so the server's
// default applies.
const refusedEfforts = new Set<string>()
const refusedEffort = (res: { error?: string; text: string; thinking: string; calls: unknown[] }) =>
  res.error?.startsWith('local model server answered 400') === true &&
  /effort|output_config/i.test(res.error) &&
  !res.text && !res.thinking && res.calls.length === 0

const reasoning = new Map<string, string>()
// A conversation longer than this replays without its oldest thinking, rather than growing the map
// for the session's whole life.
function remember(key: string, thought: string): void {
  reasoning.set(key, thought)
  while (reasoning.size > REASONING_LIMIT) {
    const oldest = reasoning.keys().next()
    if (oldest.done) return
    reasoning.delete(oldest.value)
  }
}

// The model each loop's last step ran, by loop (`main` or an agent id), local or not, so a compaction
// knows whether the loop is local and answers in the model's own name.
const loopModel = new Map<string, string>()

const emptyResult = (e: { turnId: string; index: number }) => ({
  turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null,
})

async function* failChunks(reason: string) {
  yield { kind: 'text' as const, index: 0, text: reason }
  yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
}

// The store write trails the changes: one prompt renders many descriptions at once, and the hook must
// not wait for the disk. The pending time, not the timer handle, is what says a write waits: a refused
// timer leaves no handle, and a pending this old is treated as stale so the next change asks again.
const PERSIST_STALE_MS = 5000
let persistSince: number | undefined
function persistDescriptions($: EngineInterface): void {
  const now = Date.now()
  if (persistSince !== undefined && now - persistSince < PERSIST_STALE_MS) return
  persistSince = now
  try {
    $.clock.after(1000, () => {
      persistSince = undefined
      // A failed write only loses a cache of descriptions.
      void $.store.set('toolDescriptions', Object.fromEntries(fullDescriptions)).catch(() => undefined)
    })
  } catch {
    // no timer: pending-since goes stale, and a later change asks again
  }
}

export const register: Register = (on, options) => {
  const endpoint: Endpoint = {
    url: typeof options.url === 'string' && options.url.trim() !== '' ? options.url.trim() : 'http://127.0.0.1:8000/v1/messages',
    apiKey: typeof options.apiKey === 'string' ? options.apiKey.trim() : '',
    maxTokens: (() => {
      const n = Math.floor(Number(options.maxTokens))
      return Number.isFinite(n) && n > 0 ? n : 32000
    })(),
  }

  // Every tool's description as the engine renders it, kept whole for the local model's tool list. An
  // MCP tool the local model is not offered has no use here.
  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    if ((!e.tool.startsWith('mcp__') || offeredTools.has(e.tool)) && fullDescriptions.get(e.tool) !== r.description) {
      fullDescriptions.set(e.tool, r.description)
      persistDescriptions($)
    }
    return r
  })

  // Under a routed model the commit trailer names the model that really answers, not the Claude model
  // its picker row behaves as.
  on('attribution.text', async ($, e, next) => {
    const { text } = await next(e)
    const model = await $.session.model()
    if (!isLocal(model)) return { text }
    const name = `${servedName(model)} (local)`
    // A function, so a `$` in the name is text rather than a replacement pattern.
    return { text: text.replace(/(Co-Authored-By: )[^<\n]*<noreply@anthropic\.com>/gi, (_m, lead: string) => `${lead}${name} <noreply@invalid>`) }
  })

  on('session.compact', async ($, e, next) => {
    // The main loop's current model may be set without a step having run in this process (a resumed
    // session compacted at once), so ask the session; an agent is mid-run, so its last step says.
    // Nothing may throw before the Claude-loop fallthrough below: a failed hook would hand a local
    // loop's compaction to the engine, which sends it to Anthropic.
    let model: string | undefined
    try {
      if (e.agentId === undefined) {
        const sessionModel = await $.session.model()
        model = isLocal(sessionModel ?? '') ? sessionModel : undefined
      } else {
        // After /reload-plugins the loop map is empty though the agent is still mid-run: its type's file
        // says which model it runs. One that names none (or `inherit`, or a built-in type) runs on its
        // parent's model, which may be local: unknown then, so it stays unchanged until its next step.
        const known = loopModel.get(e.agentId) ?? (await agentDefinition($, e.agentId)).model
        if (isLocal(known)) model = known
        else if ((!known || known === 'inherit') && isLocal((await $.session.model()) ?? '')) {
          return { skip: 'pi-models: this agent\'s model is unknown until its next step; the conversation is unchanged' }
        }
      }
    } catch (err) {
      return { skip: `pi-models: cannot tell which model compacts (${String(err).slice(0, 200)}); the conversation is unchanged` }
    }
    if (model === undefined) return next(e) // a Claude loop: the engine compacts it as usual
    if (e.trigger === 'precompute') return { skip: 'not precomputed for the local model' }
    try {
      const summary = await summarize($, e.agentId, model, endpoint, e.instructions)
      return {
        messages: [
          {
            role: 'user' as const,
            text: `This conversation was compacted. Summary of everything before this message:\n\n${summary}`,
            toolUses: [],
          },
        ],
      }
    } catch (err) {
      return { skip: `compaction by the local model failed (${String(err).slice(0, 200)}); the conversation is unchanged` }
    }
  }).catch(async ($, e, next) => {
    // A Claude loop's own compaction failure is the engine's to report: replay it. Only a failure of
    // this plugin's local path (nothing beneath ran) becomes a skip.
    if (next.called) return next(e)
    return { skip: 'pi-models: compaction failed; the conversation is unchanged' }
  })

  on('turn.step', async function* ($, e, next) {
    // Every step whose model id starts with `local/` is answered here, in the main loop or an agent;
    // every other model's steps pass through untouched.
    const isMain = e.agentId === undefined
    const loop = e.agentId ?? 'main'
    loopModel.set(loop, e.model)
    if (!isLocal(e.model)) return yield* next(e)

    const served = servedName(e.model)
    const empty = (text: string) => ({
      turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn' as const, usage: null,
    })
    const fail = async function* (reason: string) {
      yield { kind: 'text' as const, index: 0, text: `local: ${reason}` }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    }

    const history = isMain
      ? await $.session.messages({ as: 'api' })
      : await $.session.messages({ agentId: e.agentId!, as: 'api' })
    if (!Array.isArray(history)) {
      const reason = `cannot read the agent's conversation (${history.deny})`
      yield* fail(reason)
      return empty(`local: ${reason}`)
    }
    const tools = await localTools($, isMain)
    const system = await stepSystem($, e.model, served, tools, e.agentId)
    const wanted = typeof e.effort === 'string' ? e.effort : undefined
    const refusal = `${endpoint.url} ${served} ${wanted}`
    const request = (effort: string | undefined) => ({
      model: served,
      system,
      messages: toVllm(history as Message[], reasoning, served),
      ...(tools.length > 0 ? { tools: anthropicTools(tools) } : {}),
      max_tokens: endpoint.maxTokens,
      ...(effort ? { output_config: { effort } } : {}),
    })
    let res = yield* localStream($, endpoint, request(refusedEfforts.has(refusal) ? undefined : wanted))
    if (wanted && !refusedEfforts.has(refusal) && refusedEffort(res)) {
      refusedEfforts.add(refusal)
      res = yield* localStream($, endpoint, request(undefined))
    }
    if (res.error) {
      // What streamed before the failure stays (whole tool calls run as usual); a note says why the
      // step ended there.
      const note = `${res.text ? '\n\n' : ''}local: ${res.error}`
      const stopReason = res.calls.length > 0 ? ('tool_use' as const) : ('end_turn' as const)
      yield { kind: 'text' as const, index: res.nextIndex, text: note }
      yield { kind: 'stop' as const, stopReason, usage: null }
      for (const c of res.calls) remember(c.id, res.thinking)
      return {
        turnId: e.turnId,
        index: e.index,
        answer: res.text + note,
        toolUses: res.calls.map(c => ({ name: c.name, input: parseArgs(c.json) })),
        stopReason,
        usage: null,
      }
    }

    const calls = [...res.calls]
    for (const c of calls) remember(c.id, res.thinking)
    if (calls.length === 0 && res.text) remember(`text:${res.text}`, res.thinking)

    const stopReason: 'tool_use' | 'max_tokens' | 'end_turn' =
      calls.length > 0 ? 'tool_use' : res.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn'
    const cached = res.usage?.cache_read_input_tokens ?? 0
    const fresh = res.usage?.input_tokens ?? 0
    const usage = {
      input_tokens: fresh,
      output_tokens: res.usage?.output_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      model: e.model,
    }
    yield { kind: 'stop' as const, stopReason, usage }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: res.text,
      toolUses: calls.map(c => ({ name: c.name, input: parseArgs(c.json) })),
      stopReason,
      usage,
    }
  }).catch(async function* (_$, e, next) {
    // A failed hook is skipped and core runs the step: for a routed id that is Anthropic (a 404, the
    // conversation sent there). So a routed step that throws or overruns fails here instead.
    // shortcut: the note takes block 0, assuming the hook had yielded nothing (its throws come before
    // the stream); track the next index if a mid-stream throw ever shows up.
    if (!isLocal(e.model)) return yield* next(e)
    const note = `pi-models: the step failed (${next.error.kind}${next.error.message ? `: ${next.error.message.slice(0, 200)}` : ''})`
    yield* failChunks(note)
    return { ...emptyResult(e), answer: note }
  })
}
