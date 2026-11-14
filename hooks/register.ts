import type { Register } from 'claude-code'

// claude-pi: Claude Code with the lean harness of pi (github.com/earendil-works/pi, MIT).
// Pi's system prompt, Pi's tool descriptions, project instructions as the only context, and a short
// tool list in front; every other tool stays one ToolSearch away. Works in Code Mode too.

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
  ToolSearch: 'Load a tool that is not listed here, by name or keyword',
  REPL: 'Run JavaScript that calls other tools',
  Poll: 'Wait for script output and other events',
}

// Pi's guidelines per tool; REPL's is the one Pi gives its codemode tool.
const GUIDELINES: Record<string, string> = {
  Read: 'Use Read to examine files instead of cat or sed.',
  Edit: 'Use Edit for targeted changes (old_string must match exactly and uniquely).',
  Write: 'Use Write only for new files or complete rewrites.',
  REPL: 'Use REPL to batch independent tool calls (Promise.all), chain them, or filter large output, instead of many separate calls.',
}

// Tools whose schemas stay in the prompt: Pi's four, ToolSearch to reach the rest, Code Mode's two,
// and ExitPlanMode so plan mode can end. Every other tool waits behind ToolSearch.
const IN_FRONT = new Set(['Read', 'Bash', 'Edit', 'Write', 'ToolSearch', 'REPL', 'Poll', 'ExitPlanMode'])
// In Code Mode the model is given only these two; everything else runs inside its scripts.
const CODE_MODE_TOOLS = ['REPL', 'Poll']
// Engine sections kept under Pi's prompt: auto memory's instructions and a chosen output style.
const KEPT_SECTIONS = new Set(['memory', 'output_style'])

export const register: Register = on => {
  on('tool.describe', async (_$, e, next) => {
    const r = await next(e)
    const description = DESCRIPTIONS[e.tool] ?? r.description
    return IN_FRONT.has(e.tool) ? { ...r, description } : { ...r, description, isDeferred: true }
  })

  // Pi carries no date, email or account context: project instructions (CLAUDE.md) only.
  on('prompt.context', async (_$, e, next) => {
    const { blocks } = await next(e)
    return { blocks: blocks.filter(b => b.name === 'claudeMd') }
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    if (e.traits.includes('bare')) return { sections }
    const shown = e.tools.includes('REPL') ? CODE_MODE_TOOLS : e.tools.filter(t => IN_FRONT.has(t) && t in SNIPPETS)
    const rules = [
      ...(shown.includes('Bash') ? ['Use Bash for file operations like ls, rg, find'] : []),
      ...shown.flatMap(t => (GUIDELINES[t] ? [GUIDELINES[t]] : [])),
      'Be concise in your responses',
      'Show file paths clearly when working with files',
    ]
    const tools = shown.map(t => `- ${t}: ${SNIPPETS[t]}`).join('\n')
    return {
      sections: [
        {
          id: 'claude-pi:intro',
          scope: 'shared' as const,
          text: 'You are a coding assistant running inside claude-pi, a coding agent harness. Help users inspect files, run commands, and modify code.',
        },
        { id: 'claude-pi:tools', scope: 'session' as const, text: `<tools>\n${tools}\n\nAdditional tools may be available.\n</tools>` },
        { id: 'claude-pi:rules', scope: 'session' as const, text: `<rules>\n${rules.map(r => `- ${r}`).join('\n')}\n</rules>` },
        ...sections.filter(s => KEPT_SECTIONS.has(s.id)).map(s => ({ ...s, scope: 'session' as const })),
        { id: 'claude-pi:cwd', scope: 'session' as const, text: `<cwd>\n${await $.session.cwd()}\n</cwd>` },
      ],
    }
  })
}
