# Connect your agent through the local CLI

Use this path when the agent runs on an enrolled machine. A coding assistant runs a local executable. Deep Agents, LangChain, Agno and the OpenAI Agents SDK call native Python tools. Rasa calls a custom action. Node applications can import a TypeScript client. All use the same grant checks, credential refresh, approvals and usage ledger as the interactive CLI. MCP registration is optional.

## Prepare one adapter per agent

On Linux or macOS install the verified OpenPassword CLI with Node 24 on the machine where the harness actually executes. Enroll and start its host bridge once. For each agent, run the following as that agent's OS user, replacing the origin, socket, profile and target. The broker may be remote. The executable, signing socket and token store must be available on the execution host, including inside an SSH session, container or cloud workstation.

```sh
export OPENPASSWORD_BROKER=https://vault.example.com
export OPENPASSWORD_HOST_SOCKET=/run/openpassword-host/bridge.sock
export OPENPASSWORD_AGENT=codex-project-a
openpassword host status
openpassword pair
# Approve the request ID in Access grants; select a connection and allowed operations.
export ADAPTER_DIR="$HOME/.local/share/openpassword/adapters/$OPENPASSWORD_AGENT"
openpassword harness prepare codex "$ADAPTER_DIR"
export OPENPASSWORD_ADAPTER="$ADAPTER_DIR/openpassword-agent"
"$OPENPASSWORD_ADAPTER" whoami
"$OPENPASSWORD_ADAPTER" capabilities
```

Choose `github.user.get` on a GitHub connection for the examples below. Replace the target and use a new profile and destination for each agent. Use an existing profile's launcher directly on subsequent runs. `openpassword harness list` lists the supported target names. The generator creates a new directory and prints the executable path. It leaves existing harness settings under your control. The launcher pins the installed CLI path, Node, OS user, broker, profile and signing socket. Keep it at its generated path when installing skills. Different profiles under one OS user share an OS trust boundary. Use separate OS accounts for mutually untrusted agents.

Older standalone workspaces can explicitly select `harness prepare TARGET DIRECTORY --standalone` after standalone enrollment, with OPENPASSWORD_HOST_SOCKET unset. A broken signing socket fails the call. The broker continues to enforce its workspace policy.

## Make a native call

```sh
export OPENPASSWORD_REQUEST_KEY="$(node -p 'crypto.randomUUID()')"
printf '%s' '{}' | "$OPENPASSWORD_ADAPTER" operation github.user.get "$OPENPASSWORD_REQUEST_KEY"
```

The command fetches capabilities, checks the requested operation, and passes the connection identity and revision to the broker. A confirmed result contains a receipt. For an exact binding obtained earlier, pipe an object with `connection_id`, `operation_id`, `arguments`, `idempotency_key` and `expect` into `invoke-json`. Arguments and prompts travel on stdin. Preserve the request key when retrying the same logical action, including after human approval. Inspect the returned status before treating an action as completed.

For a model grant, use `models` and `printf '%s' 'Summarize this text.' | "$OPENPASSWORD_ADAPTER" chat MODEL_ID 128 "$OPENPASSWORD_REQUEST_KEY"`. This routes that explicit call through the gateway. Each harness's own planning model retains its configured provider and billing.

## Coding assistants

Generate the target in the first column. For project skills, copy the generated skill directory under the matching path in your trusted workspace. The skill invokes the prepared executable by its absolute path. Ask the assistant to use OpenPassword to read the connected GitHub login. Compare the resulting operation and agent ID in OpenPassword activity. Shell execution and any vendor login must be enabled in the harness.

| Target | Native installation and example | Reference |
| --- | --- | --- |
| `claude-code` | Copy `.claude/skills/openpassword/`. In Claude Code run `/openpassword` and request the GitHub login. | [Claude Code skills](https://code.claude.com/docs/en/skills) |
| `codex` | Copy `.agents/skills/openpassword/`. In Codex select the openpassword skill and request the login. | [Codex skills](https://developers.openai.com/codex/skills/) |
| `cursor` | Copy `.cursor/skills/openpassword/`. In Cursor Agent ask it to run the skill's local lookup. | [Cursor skills](https://cursor.com/help/customization/skills) |
| `agi` | AGI CLI by Phoenix. Use the generated skill in a workspace for the specific child harness (e.g. Codex's `.agents/skills/openpassword/`). Start `agents run codex "Use the openpassword skill to read my GitHub login"`. On each remote worker prepare its own launcher. Keep differently authorized child harnesses in separate agent environments. | [AGI CLI run](https://agi-cli.sh/docs/agents/run) |
| `grokbot` | xAI Grok Bot. On its cloud computer prepare the adapter, run the native lookup once, then ask the bot to save the instructions from `grokbot-skill.md` as a private skill. Use a bot environment where you can provision Node, the CLI, a signing bridge and a suitable OS identity. A shared cloud OS account cannot isolate mutually untrusted bots. | [Grok Bot skills](https://docs.x.ai/grok-bot/skills-routines-and-automations) |
| `grok-build` | For the xAI terminal coding agent, copy `.grok/skills/openpassword/`. Invoke `/openpassword` in Grok Build. | [Grok Build skills](https://docs.x.ai/build/features/skills-plugins-marketplaces) |
| `antigravity` | Copy `.agents/skills/openpassword/`. Ask Antigravity to use the skill on its execution host. | [Antigravity skills](https://antigravity.google/docs/commands/learn) |
| `gemini-cli` | Copy `.gemini/skills/openpassword/`. Open Gemini CLI in that workspace and request the lookup. | [Gemini CLI skills](https://geminicli.com/docs/cli/tutorials/skills-getting-started/) |
| `github-copilot` | Copy `.github/skills/openpassword/`. In VS Code Copilot agent mode ask for the scoped login. Prepare inside the remote workspace when using Remote SSH or a dev container. | [VS Code agent skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) |
| `opencode` | Copy `.opencode/skills/openpassword/`. Ask OpenCode to load the skill and run the operation. | [OpenCode agent skills](https://opencode.ai/docs/skills/) |

For example, after preparing a Codex adapter and opening the target project:

```sh
mkdir -p .agents/skills
cp -R "$ADAPTER_DIR/.agents/skills/openpassword" .agents/skills/
codex 'Use the openpassword skill to read my connected GitHub login.'
```

## Frameworks and embedded clients

Set OPENPASSWORD_ADAPTER to the executable prepared for this agent. From the repository root, install the standard-library Python client in the framework's virtual environment with `python -m pip install ./examples/harnesses/python`. Install the dependencies for the framework you use. For the LLM-driven examples set HARNESS_MODEL to an available model and configure the framework's usual model authentication. For Deep Agents and LangChain use a provider-qualified model such as `openai:MODEL_ID`; for the OpenAI provider examples in Agno and the Agents SDK use the plain model ID. Set a fresh OPENPASSWORD_REQUEST_KEY per intended lookup.

| Target | Dependencies | Native example |
| --- | --- | --- |
| `deepagents` | `deepagents langchain-openai` | `python examples/harnesses/python/deepagents_example.py` registers LangChain tools with create_deep_agent. Add `--check` for a grant check without a model call. |
| `langchain` | `langchain langchain-openai` | `python examples/harnesses/python/langchain_example.py` registers the same tools with create_agent. They can also be supplied to a LangGraph tool node. |
| `agno` | `agno openai` | `python examples/harnesses/python/agno_example.py` attaches async functions to an Agno Agent. |
| `openai-agents` | `openai-agents` | `python examples/harnesses/python/openai_agents_example.py` registers function tools with an Agent and runs it through Runner. |
| `rasa` | `rasa-sdk` on the action server, Rasa on the dialogue server | Merge the supplied `domain.yml` action names, `flows.yml` CALM flows and `endpoints.yml` action endpoint into your assistant. Run `python -m rasa_sdk --actions actions` from `examples/harnesses/rasa`. Ask “Which GitHub account is connected?” The service uses its own grant; use the read action only in a conversation authorized to see that service account's login. |
| `typescript` | Built workspace package `@openpassword/client`, Node 24 | `node examples/harnesses/typescript/example.ts` calls the local client. JavaScript can use the same ESM import, `import { LocalAgent } from '@openpassword/client/local'`. |

The Python and TypeScript clients expose whoami, capabilities, models, chat, operation and invoke. The Python client also includes a GitHub read helper. Both launch the executable directly with an argument vector and send structured payloads on stdin. Neither reads the profile database or requires an MCP process.

## Optional MCP registration

Use the same per-agent executable with its single `mcp` argument. For Codex or Grok Build merge the generated TOML table into that harness's config. For Cursor, Claude Code, Antigravity or Gemini merge the generated `mcpServers.openpassword` entry into the harness MCP settings. VS Code uses `servers.openpassword`; OpenCode uses `mcp.openpassword`. In AGI CLI, register only for the intended child, e.g. `agents mcp add openpassword "$OPENPASSWORD_ADAPTER" mcp --agents codex`, then sync that target using your installed AGI CLI version. The local CLI route works independently of these settings.

## Troubleshooting

- **Pair this device first:** run pair under the same OS account, broker origin and profile used when preparing the adapter.
- **Missing socket or host refused:** check the signing service on the execution host and its group permissions. Confirm the host is still approved.
- **Unavailable operation:** inspect capabilities and ask the connection owner for the specific grant.
- **Native lookup succeeds but the assistant cannot run it:** verify the skill's absolute path in the assistant's actual sandbox. Remote or SaaS workers need their own reachable broker and approved host.
- **Python cannot import openpassword_local:** install the local Python package into the interpreter running the action server or framework.
