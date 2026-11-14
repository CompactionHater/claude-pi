# claude-pi

Claude Code with the lean harness of [pi](https://github.com/earendil-works/pi), plus any Anthropic-compatible model beside Claude. Two mods, installed with slash commands: no launcher, no patched binary.

## What pi saves

The first request of a session, in characters (about four to a token), measured on Claude Code 2.1.325 in an empty folder:

| | Claude Code | With pi | Saved |
|---|---|---|---|
| Opus 5.5 | 52,200 | 16,600 | 68% |
| Sonnet 4.6 | 89,700 | 26,900 | 70% |

Where it comes from, on Opus 5.5:

| Part | Claude Code | With pi |
|---|---|---|
| Tool schemas | 34,700 | 6,500: Read, Bash, Edit, Write and ToolSearch |
| Bash's description alone | 1,900 | 160, pi's |
| First message | 11,300, mostly the skill and agent listings | 4,600: bundled skills hidden from the model |
| System prompt | 6,200 | 5,500 |

A project's CLAUDE.md and your own skills add the same to both. MCP servers add less with pi, which puts their tools behind ToolSearch.

## Install

In a Claude Code session:

```
/plugin marketplace add CompactionHater/claude-pi
/plugin install pi@claude-pi
/plugin install pi-models@claude-pi
```

Install one or both, then run `/reload-plugins` or start a new session. Needs Claude Code 2.1.325 or later.

## pi

- **Tools:** Read, Bash, Edit and Write go out in full with pi's short descriptions, plus ToolSearch. Every other tool (Agent, WebSearch, MCP tools and the rest) is one ToolSearch away, and still works.
- **System prompt:** where Claude Code sends its lean prompt (Opus 4.8 and later, the 5.5 models, Fable, models it doesn't know, and always in Code Mode), pi keeps it but drops the sections on pronouns and on recreating existing games, and the lines about Claude Code's apps and fast mode. It adds pi's rules: Bash for `ls`, `rg` and `find`; Read instead of `cat` or `sed`; Edit for targeted changes; Write only for new files or rewrites; be concise; show file paths. On older models it replaces Claude Code's long prompt (27,500 characters) with pi's short one, keeping auto memory, output style, the compaction note, the "act, don't re-derive" line and the token countdown.
- **Skills:** Claude Code's bundled skills (dataviz, claude-api, code-review, simplify, loop, run, init and others) are hidden from the model and stay typable as `/name`. To list one for the model again, set it to `"on"` under `skillOverrides` in `~/.claude/settings.json`, for example `{ "skillOverrides": { "dataviz": "on" } }`. Your own and your plugins' skills are listed as before.
- **First message:** CLAUDE.md only, without your email and the other context blocks.
- **Auto mode:** its note to read and edit files through Bash is left out, since pi's rules say Read and Edit.

Permissions, hooks, slash commands, subagents and other mods' prompt sections are unchanged. The lean prompt is kept because it is short and about coding: ZCode, the top harness on [FrontierHarness](https://frontierharness.org) v1.1, sends almost the same text. Claude Code still adds a few lines mods can't reach, such as the commit attribution reminder.

To save more, `"autoMemoryEnabled": false` in your settings turns off auto memory and its instructions: 2,300 characters on Opus 5.5, 12,800 on Sonnet 4.6.

## pi-models

pi-models sends every model step whose model id starts with `local/` to your server and leaves every other step to Claude. The text after `local/` is the model name your server is asked for. The server needs Anthropic's Messages API at `/v1/messages` with streaming and tool calls (in vLLM, `--enable-auto-tool-choice` and the model's `--tool-call-parser`), and at least 100,000 tokens of context. Tested with vLLM; llama.cpp, Ollama, LM Studio and LiteLLM offer the same endpoint but are untested.

**1. Point it at your server:** run `/plugin configure pi-models@claude-pi` and enter:

- **Messages endpoint:** the full URL, for example `http://127.0.0.1:8000/v1/messages`.
- **API key:** if your server asks for one; leave it empty if not. Claude Code keeps it in its secure storage. Over `http://` it crosses the network in clear text, so use `https://` or a network you trust.
- **Max output tokens:** per step, default 32000.

Run the same command to change them later.

**2. Add the model to `/model`** in `~/.claude/settings.json`. If the file already has an `env` block, add the key to it rather than a second block:

```json
{
  "modelPicker": {
    "options": [
      { "model": "local/Qwen/Qwen3-Coder-30B-A3B-Instruct", "label": "Qwen3 Coder (local)", "behavesAs": "claude-sonnet-5-5" }
    ]
  },
  "env": { "CLAUDE_CODE_AUTO_MODE_SERVER": "0" }
}
```

`model` is `local/` plus the name your server's `/v1/models` lists. `behavesAs` picks the Claude model whose handling Claude Code applies (prompt style, effort levels, Code Mode); nothing sent changes. Use a 5.5 model: a row that behaves as an older one, such as Sonnet 4.6, gets the long-prompt path and its longer memory instructions, about 9,000 more characters per request. Start a new session, then pick the row with `/model`.

**3. Set its context window:** with the row picked, run `/autocompact 128k`, using the length your server serves (vLLM's `--max-model-len`). Without it, the row gets the window of the model in `behavesAs`: 1M for Sonnet 5.5. Claude Code accepts 100k to 1M and saves it for that row only.

**4. Agents on your model (optional):** an agent file runs on your model, its body as the agent's instructions, for example `~/.claude/agents/local.md`:

```markdown
---
name: local
description: The local model. Good for well-specified coding, scouting and mechanical work.
model: local/Qwen/Qwen3-Coder-30B-A3B-Instruct
effort: high
---

You are a worker agent. Do exactly the task in the prompt, verify it, and report the result.
```

Name Claude agents' models by full id (`claude-sonnet-5-5`), not alias: under a row that behaves as Sonnet, `sonnet` resolves to that row.

**Effort:** `/effort`, an agent's `effort` and the Agent tool's `effort` reach your server as `output_config.effort`. A level the server refuses is resent without one and left out for the rest of the session. Compaction requests carry none.

**Auto mode:** Claude Code 2.1.325 returns auto mode's safety verdict inside Claude's own response, so your model's tool calls would all be refused. `CLAUDE_CODE_AUTO_MODE_SERVER=0` (step 2) runs the check as a separate Claude request per checked call, for Claude sessions too. Other permission modes need no setting. If a later Claude Code drops its own check, use another permission mode for your model.

**What still goes to Anthropic:** your model's steps go only to your endpoint, but Claude Code still needs a Claude login or API key and makes its own requests: auto mode's checks, WebSearch, background requests. It doesn't run Claude Code offline.

**Limits:**

- Outside Code Mode your model gets Claude Code's own tools, not MCP or plugin tools; in Code Mode it reaches them through REPL.
- Until one Claude request has gone out with pi-models on, a session that starts on your model sees the first 300 characters of each tool's description.
- Local agents are read from `.claude/agents` and `~/.claude/agents`, not from plugins.
- Needs `curl` on your PATH, and `sh` for requests over 2,000,000 characters. The key goes to curl on its standard input, never on a command line; for a request over 2,000,000 characters it also passes through that `sh` process's environment, which only your own user can read.
- No overall time limit on a request; press Esc if your server stalls. Your model writes its own compaction summaries.

`PI_MODELS_DUMP=/tmp/pi-models-dump claude` writes each request body to that folder, without the key.

## Token countdown

Claude Code can tell the model how many tokens of its task budget are left (`<total_tokens>15000000 tokens left</total_tokens>`), counting down after each tool result. The 15,000,000 is a task budget, not the context window. Claude Code sends it only to some Claude models; ZCode sends it to every model. To do the same, add `"CLAUDE_CODE_TOTAL_TOKENS_REMINDER": "padded-countdown"` to the `env` block of your settings. pi keeps it, and pi-models passes it to your model. Claude Code marks the setting internal, so it may change. Its other mode, `countdown`, counts down the context window instead, but on a `local/` row that is the `behavesAs` model's window, not your server's.

## Code Mode

Both mods work in Claude Code's [Code Mode](https://code.claude.com/docs/en/code-mode), where the model writes JavaScript that calls its tools through REPL. pi adds a rule for REPL (batch, chain and filter inside one script); pi-models gives your model the same tools. Neither turns Code Mode on: set `"CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "1"` in your `env` block. It needs Claude Code to fetch feature flags, so it won't start while `DISABLE_TELEMETRY`, `DO_NOT_TRACK` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, and it then sends usage analytics. It needs Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2 or a row that behaves as one of them, and refuses to start while an enabled mod hooks tool calls or agents; these two don't.

## Turn them off

```
/plugin disable pi@claude-pi
/plugin disable pi-models@claude-pi
```

Before turning pi-models off, switch to a Claude model and remove your `local/` rows and agent files: without it, a `local/` step goes to Anthropic, which rejects the unknown model.

pi sends nothing anywhere; pi-models sends requests only to your endpoint. Any other mod you install can read pi-models' settings, the key included, as with every mod. The code is two files, `plugins/*/hooks/register.ts`. To check it, run `claude plugin validate` on a plugin folder; `tsc` needs the type definitions an interactive session writes when it first loads the folder (`claude --plugin-dir plugins/pi`).

## Credits

The system prompt and tool descriptions are adapted from [pi](https://github.com/earendil-works/pi) by Mario Zechner (MIT).

## License

MIT, see [LICENSE](LICENSE).
