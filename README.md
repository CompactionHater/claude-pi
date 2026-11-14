# claude-pi

Claude Code with the lean harness of [pi](https://github.com/earendil-works/pi), as a mod you install with two slash commands. No launcher script, no patched binary: the plugin rewrites Claude Code's own system prompt, tool descriptions and tool list through the mods API.

## Install

In a Claude Code session:

```
/plugin marketplace add CompactionHater/claude-pi
/plugin install pi@claude-pi
```

Then run `/reload-plugins`, or start a new session. Needs Claude Code 2.1.323 or later; tested on 2.1.325.

## What it changes

| | Claude Code | With claude-pi |
|---|---|---|
| System prompt | Claude Code's full prompt | pi's prompt: one role line, a tool list, a few rules, the working directory |
| Tools sent with every request | 14 tools, about 79,000 characters of schemas | Read, Bash, Edit, Write and ToolSearch, about 6,400 characters |
| Other tools | Listed in full | Behind ToolSearch: Claude loads one when it needs it |
| Context in the first message | CLAUDE.md, your email, today's date | CLAUDE.md only |
| Tool descriptions | Claude Code's | pi's, adapted to Claude Code's parameters |

Measured on Claude Code 2.1.325 with Opus 5.5: about 88,600 characters of prompt and tool schemas per request become about 10,900.

Kept as they are:

- Every tool still works. Agent, AskUserQuestion, WebSearch, Skill, MCP tools and the rest are one ToolSearch away.
- Subagents keep their own prompts.
- Auto memory and a chosen output style keep their instructions.
- Permissions, hooks, skills, slash commands and CLAUDE.md are unchanged.

Claude Code still adds a few lines the mods API doesn't reach, such as notes for the Artifact and WebSearch tools and the commit attribution reminder.

## Code Mode

claude-pi works with Claude Code's [Code Mode](https://code.claude.com/docs/en/code-mode), where Claude writes JavaScript that calls its tools. In Code Mode the model gets two tools, REPL and Poll. claude-pi lists those two in pi's style and adds pi's codemode rule: batch independent calls, chain them, and filter large output inside one script. Tools behind ToolSearch show by name only in REPL's declarations, which cuts REPL's description from about 33,500 to 22,600 characters.

Code Mode is Claude Code's own feature, and claude-pi doesn't turn it on. To try it, add this to `~/.claude/settings.json` and start a new session:

```json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "1" } }
```

Code Mode has requirements of its own. It needs Claude Code to fetch feature flags from Anthropic, so it doesn't start while `DISABLE_TELEMETRY`, `DO_NOT_TRACK` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. With flags on, Claude Code also sends its usage analytics. It needs Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.2, and it refuses to start while any enabled mod hooks tool calls. claude-pi hooks none, so it never blocks Code Mode; another mod can, and the warning at startup says so.

## Turn it off

```
/plugin disable pi@claude-pi
```

## How it works

`hooks/register.ts` registers three hooks:

- `prompt.compose` replaces the system prompt's sections with pi's. It keeps Claude Code's `memory` and `output_style` sections.
- `tool.describe` gives Read, Bash, Edit and Write pi's descriptions, and puts every tool outside the short list behind ToolSearch.
- `prompt.context` keeps CLAUDE.md and drops the other context blocks.

The plugin sends nothing anywhere and reads only the session's working directory. Run `claude plugin validate` on a clone to see this for yourself.

## Credits

The system prompt and tool descriptions are adapted from [pi](https://github.com/earendil-works/pi) by Mario Zechner (MIT).

## License

MIT, see [LICENSE](LICENSE).
