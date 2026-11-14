# claude-pi

Two mods for Claude Code, installed with slash commands:

- **pi** gives Claude Code the lean harness of [pi](https://github.com/earendil-works/pi): pi's system prompt and tool descriptions, project instructions as the only context, and a short tool list.
- **pi-models** lets you use any model served by an Anthropic-compatible endpoint (vLLM, llama.cpp, Ollama, LM Studio, a gateway) beside Claude, as the main model or as an agent.

Each works on its own, and they work together. Neither needs a launcher script or a patched binary: both use Claude Code's mods API.

## Install

In a Claude Code session:

```
/plugin marketplace add CompactionHater/claude-pi
/plugin install pi@claude-pi
/plugin install pi-models@claude-pi
```

Install one or both. Then run `/reload-plugins`, or start a new session. Needs Claude Code 2.1.323 or later; tested on 2.1.325.

## pi: a lean harness

| | Claude Code | With pi |
|---|---|---|
| System prompt | Claude Code's full prompt | pi's prompt: one role line, a tool list, a few rules, the working directory |
| Tools sent with every request | 14 tools, about 79,000 characters of schemas | Read, Bash, Edit, Write and ToolSearch, about 6,400 characters |
| Other tools | Listed in full | Behind ToolSearch: the model loads one when it needs it |
| Context in the first message | CLAUDE.md, your email, today's date | CLAUDE.md only |
| Tool descriptions | Claude Code's | pi's, adapted to Claude Code's parameters |

Measured on Claude Code 2.1.325 with Opus 5.5: about 88,600 characters of prompt and tool schemas per request become about 10,900.

Kept as they are:

- Every tool still works. Agent, AskUserQuestion, WebSearch, Skill, MCP tools and the rest are one ToolSearch away.
- Subagents keep their own prompts.
- Auto memory and a chosen output style keep their instructions.
- Permissions, hooks, skills, slash commands and CLAUDE.md are unchanged.

Claude Code still adds a few lines the mods API doesn't reach, such as notes for the Artifact and WebSearch tools and the commit attribution reminder.

## pi-models: other models beside Claude

pi-models answers every model step whose model id starts with `local/` by sending it to your server, and leaves every other step to Claude. The text after `local/` is the model name your server is asked for. Your server needs Anthropic's Messages API at `/v1/messages`, with streaming and tool use. Tested with vLLM; llama.cpp's server, Ollama, LM Studio and gateways such as LiteLLM offer the same endpoint but are untested.

### 1. Point it at your server

After installing, run:

```
/plugin configure pi-models@claude-pi
```

| Setting | What to enter |
|---|---|
| Messages endpoint | Your server's full Messages URL, for example `http://127.0.0.1:8000/v1/messages` on this machine or `http://<server-ip>:8000/v1/messages` on another. `https://` works too. |
| API key | The key your server asks for, if any. Claude Code keeps it in its secure storage, not in `settings.json`. Leave it empty if the server needs none. |
| Max output tokens | The most tokens one step may write. Default 32000. |

Run the same command to change them later.

### 2. Add the model to `/model`

Add a row for each model to `modelPicker` in `~/.claude/settings.json`, and the auto mode setting explained below:

```json
{
  "modelPicker": {
    "options": [
      {
        "model": "local/Qwen/Qwen3-Coder-30B-A3B-Instruct",
        "label": "Qwen3 Coder (local)",
        "behavesAs": "claude-sonnet-5-5"
      }
    ]
  },
  "env": { "CLAUDE_CODE_AUTO_MODE_SERVER": "0" }
}
```

- `model`: `local/` followed by the exact name your server serves the model under, as its `/v1/models` lists it.
- `label`: what `/model` shows.
- `behavesAs`: the Claude model whose handling Claude Code applies to this row: prompt style, effort levels and Code Mode support. It changes nothing that is sent. `claude-sonnet-5-5` gives the row the `/effort` levels and lets Code Mode start on it.

Your Claude models stay in the list. Pick the new row with `/model`, or start with `claude --model local/Qwen/Qwen3-Coder-30B-A3B-Instruct`.

### 3. Agents on your model (optional)

Save an agent file such as `~/.claude/agents/local.md`:

```markdown
---
name: local
description: The local model. Good for well-specified coding, scouting and mechanical work.
model: local/Qwen/Qwen3-Coder-30B-A3B-Instruct
effort: high
---

You are a worker agent. Do exactly the task in the prompt, verify it, and report the result.
```

Claude, or the local model itself, can then hand work to it with the `local` agent type. The file's body becomes the agent's instructions, as it would for a Claude agent.

Agents on Claude models keep working under either main model, with one catch: name their model by its full id (`model: claude-sonnet-5-5`), not by an alias (`model: sonnet`). Under a main model whose row behaves as Sonnet, Claude Code resolves the alias `sonnet` to that row's own model, which is yours.

### Effort

`/effort`, an agent file's `effort` and the Agent tool's `effort` reach your server unchanged as `output_config.effort`. What each level means is up to the model. DeepSeek V4.1, for example, maps low to 50, high and xhigh to 75 and max to 100, on a scale of 1 to 100. If the server refuses a level (DeepSeek V4.1 has no medium), pi-models resends that step without one, so the server's default applies, and leaves that level out for the rest of the session.

### Auto mode

Since Claude Code 2.1.325, auto mode's safety check comes back inside Claude's own response. A response from your model carries no verdict, so auto mode would refuse every tool call it makes. `CLAUDE_CODE_AUTO_MODE_SERVER=0` makes Claude Code run the check itself: a separate request to a Claude model for each call that needs checking. Other permission modes need no setting.

### Limits

- Pick an agent's model by its agent type. When your model is the main model, it isn't offered the Agent tool's `model` option: Claude Code resolves `model: "sonnet"` under a row that behaves as Sonnet to that row's own model.
- Tool descriptions are taken from Claude Code's own rendering of them, which happens on Claude requests. Until Claude Code has sent one Claude request with pi-models enabled, a session that starts on your model sees the first 300 characters of each tool's description. After that, the full text is kept.
- A local agent's instructions are read from `.claude/agents` in the project and `~/.claude/agents`. Agents that ship inside plugins are not read.
- `curl` must be on your PATH. pi-models streams through it and passes the API key on curl's standard input, never on a command line.
- When a conversation on your model fills up, your model writes the compaction summary itself.

To see exactly what is sent, start Claude Code with `PI_MODELS_DUMP` set to a folder. pi-models then writes each request body there, without the key:

```
PI_MODELS_DUMP=/tmp/pi-models-dump claude
```

## Code Mode

Both mods work with Claude Code's [Code Mode](https://code.claude.com/docs/en/code-mode), where the model writes JavaScript that calls its tools. In Code Mode the model gets two tools, REPL and Poll.

- **pi** lists those two in pi's style and adds pi's codemode rule: batch independent calls, chain them, and filter large output inside one script. Tools behind ToolSearch show by name only in REPL's declarations, which cuts REPL's description from about 33,500 to 22,600 characters.
- **pi-models** gives your model the same two tools, so it drives Code Mode as Claude does.

Code Mode is Claude Code's own feature, and neither mod turns it on. To try it, add this to `~/.claude/settings.json` and start a new session:

```json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "1" } }
```

Code Mode has requirements of its own:

- **Feature flags:** it needs Claude Code to fetch feature flags from Anthropic, so it doesn't start while `DISABLE_TELEMETRY`, `DO_NOT_TRACK` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. With flags on, Claude Code also sends its usage analytics.
- **Models:** it needs Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2, or a row that behaves as one of them.
- **Mods:** it refuses to start while any enabled mod hooks tool calls. Neither of these mods does, but another mod can, and the warning at startup says so.

## Turn them off

```
/plugin disable pi@claude-pi
/plugin disable pi-models@claude-pi
```

## How they work

pi's `plugins/pi/hooks/register.ts` registers three hooks:

- `prompt.compose` replaces the system prompt's sections with pi's. It keeps Claude Code's `memory` and `output_style` sections.
- `tool.describe` gives Read, Bash, Edit and Write pi's descriptions, and puts every tool outside the short list behind ToolSearch.
- `prompt.context` keeps CLAUDE.md and drops the other context blocks.

pi-models' `plugins/pi-models/hooks/register.ts` registers four:

- `turn.step` answers each step on a `local/` model. It sends your server the conversation, the system prompt Claude Code composes (pi's, when pi is installed), the agent's instructions and the tools, then streams the answer back into Claude Code.
- `session.compact` has your model summarize its own conversation.
- `tool.describe` records each tool's description as Claude Code renders it, unchanged.
- `attribution.text` names your model in commit trailers when it is the main model.

pi sends nothing anywhere. pi-models sends requests only to the endpoint you configure. Run `claude plugin validate` on either plugin's folder in a clone to check them yourself.

## Credits

The system prompt and tool descriptions are adapted from [pi](https://github.com/earendil-works/pi) by Mario Zechner (MIT).

## License

MIT, see [LICENSE](LICENSE).
