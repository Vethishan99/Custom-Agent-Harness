# agent-harness

A terminal coding agent that works in any codebase, with the AI provider of your choice: Anthropic (Claude), OpenAI, OpenRouter, Google Gemini, Groq, DeepSeek, Mistral, local models through Ollama, or any OpenAI-compatible endpoint.

It reads, searches and edits the files in your project and can run commands such as tests and builds. **Every file change and every command needs your approval.**

![agent-harness finding and fixing a failing test, with the user approving the edit and the test run](https://raw.githubusercontent.com/Vethishan99/Custom-Agent-Harness/main/docs/demo.gif)

## Install

You need Node.js 20 or newer.

```sh
npx agent-harness-tui            # run once without installing
npm install -g agent-harness-tui # or install the `agent-harness` command
```

## Set up a provider

Run `login` once. It asks for a provider, your API key and a model, then sends one tiny test request. If the key or model is wrong, it tells you which one and lets you fix it before anything is saved. Settings go to `~/.config/agent-harness/config.json`, which only you can read.

```sh
agent-harness login
```

To change the model later without re-entering your key:

```sh
agent-harness model                  # list the models your key can use, then pick one
agent-harness model gpt-5-mini       # or switch straight to one
```

Run `login` again to change the provider or key. When you run it again, pressing Enter at the key prompt keeps the saved key.

Or set an environment variable instead. The agent uses the first key it finds:

| Provider | `--provider` | Key variable | Get a key |
|---|---|---|---|
| Anthropic (Claude) | `anthropic` | `ANTHROPIC_API_KEY` | https://platform.claude.com/settings/keys |
| OpenAI | `openai` | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| OpenRouter (some free models) | `openrouter` | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| Groq | `groq` | `GROQ_API_KEY` | https://console.groq.com/keys |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | https://platform.deepseek.com/api_keys |
| Mistral | `mistral` | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys |
| Ollama (local, free) | `ollama` | none | https://ollama.com |
| Any OpenAI-compatible API | `custom` + `--base-url` | `AGENT_HARNESS_API_KEY` | |

**Pick a model that supports tool calling.** The test request checks this for you. Run `agent-harness models` to see each provider's default, or `agent-harness models --provider openai` to list the models your key can use.

An environment variable beats the saved settings: if `OPENAI_API_KEY` is set, a saved OpenAI key is ignored. `login` and `model` warn you when this happens.

## Use

Open a terminal in your project and run:

```sh
cd ~/code/my-app
agent-harness
```

The project is the git repository you're in, or the current folder if it isn't a repository. Then just ask, for example:

- "Where is the login form validated? Add a check for empty passwords."
- "Run the tests and fix whatever fails."
- "Explain how requests flow from `server.ts` to the database."

### Options

```
--provider <id>         Choose the provider for this run
--model <id>            Choose the model for this run
--base-url <url>        Use a different API URL (proxies, custom endpoints)
--workspace <dir>       Use this folder as the project root
--no-shell              Disable shell commands entirely
--command-timeout <s>   Seconds before a command is killed (default 120)
```

If your repository has an `AGENTS.md` or `CLAUDE.md` file, the agent reads it as project instructions.

## Tools

| Tool | What it does | Approval |
|---|---|---|
| `read_file` | Reads a file, whole or a line range | no |
| `list_files` | Lists one folder | no |
| `find_files` | Finds files by glob (`src/**/*.ts`) | no |
| `search_directory` | Searches file contents (text or regex) | no |
| `write_file` | Creates or replaces a file | **yes** |
| `edit_file` | Replaces one exact piece of text | **yes** |
| `delete_file` | Deletes a file | **yes** |
| `run_command` | Runs a shell command in the project root | **yes** |

The search tools skip git-ignored files, plus `node_modules`, build output, and binary or very large files.

## Safety

- **Files:** file tools can only reach files inside the project. Paths that lead outside it, including through symbolic links, are refused.
- **Commands are not sandboxed.** `run_command` runs as you, with your permissions, so an approved command can do anything you can do. **Read every command before typing `y`.** Use `--no-shell` if you don't want the agent running commands at all.
- **Secrets:** commands don't receive your environment's API keys. They get a minimal environment (`PATH`, `HOME`, locale and similar).
- **Unsafe roots:** the agent won't start with your home folder or `/` as the project unless you pass `--workspace` explicitly.
- **Privacy:** your code is sent to the AI provider you chose, under that provider's terms. Use a local model through Ollama if it must not leave your machine.

## Development

```sh
git clone https://github.com/Vethishan99/Custom-Agent-Harness.git
cd Custom-Agent-Harness
npm install
cp .env.example .env   # add a key
npm run dev            # runs from source against the current folder
npm test               # unit tests
npm run build          # bundles dist/cli.js
```

To re-record the demo GIF: `brew install vhs`, then `npm run build && OPENROUTER_API_KEY=... vhs docs/demo.tape`.

To publish a release, bump the version in `package.json`, then push a `v*` tag. The release workflow publishes to npm, using the `NPM_TOKEN` repository secret.

## License

ISC
