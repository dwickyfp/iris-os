# Iris OS

**The open operating system for AI agents, tools, and workflows.**

Iris OS is an open-source AI workspace where models can reason, agents can
specialize, tools can act, and workflows can coordinate the work. It provides
one interface for conversations, automation, voice, code execution, content
generation, and Model Context Protocol (MCP) integrations.

[![MCP Supported](https://img.shields.io/badge/MCP-Supported-00c853)](https://modelcontextprotocol.io/introduction)
[![Local First](https://img.shields.io/badge/Local-First-blue)](https://localfirstweb.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[![Deploy with Vercel](https://vercel.com/button)](<https://vercel.com/new/clone?repository-url=https://github.com/dwickyfp/iris-os&env=BETTER_AUTH_SECRET&env=OPENAI_API_KEY&env=GOOGLE_GENERATIVE_AI_API_KEY&env=ANTHROPIC_API_KEY&envDescription=BETTER_AUTH_SECRET+is+required+(enter+any+secret+value).+At+least+one+LLM+provider+API+key+(OpenAI,+Claude,+or+Google)+is+required,+but+you+can+add+all+of+them.+See+the+link+below+for+details.&envLink=https://github.com/dwickyfp/iris-os/blob/main/.env.example&demo-title=Iris+OS&demo-description=The+open+operating+system+for+AI+agents,+tools,+and+workflows.&products=[{"type":"integration","protocol":"storage","productSlug":"neon","integrationSlug":"neon"},{"type":"integration","protocol":"storage","productSlug":"upstash-kv","integrationSlug":"upstash"},{"type":"blob"}]>)

## Why Iris OS?

In Greek mythology, **Iris** is the messenger who connects worlds. That idea is
the foundation of this project: intelligence becomes more useful when it can
connect people, models, knowledge, and software.

Iris is also associated with the rainbow: many distinct colors forming one
bridge. In Iris OS, those colors represent different models, providers, tools,
and ways of working. The goal is not to hide their differences, but to make
them interoperable through one coherent experience.

The **OS** does not mean Iris OS replaces your device operating system. It means
Iris OS acts as an operating layer for AI work:

- **Models are the intelligence.** Use the provider best suited to each task.
- **Agents are the specialists.** Give each agent a role, context, and tools.
- **Tools are the capabilities.** Connect external systems through MCP and
  built-in integrations.
- **Workflows are the coordination layer.** Turn repeatable processes into
  reusable automation.
- **Iris is the interface.** Keep human intent, control, and visibility at the
  center of every action.

### Product Principles

- **Open by design:** Self-hostable, extensible, and not tied to one model
  provider.
- **Action over answers:** AI should be able to complete work, not only produce
  text.
- **Human control:** Tool modes let users choose autonomous, approval-based, or
  tool-free operation.
- **Composable systems:** Agents, tools, presets, and workflows should work
  independently and together.
- **Local ownership:** Your deployment, configuration, credentials, and data
  remain under your control.

## Capabilities

| Layer | What Iris OS provides |
| --- | --- |
| **Iris Chat** | Multi-model conversations, attachments, temporary chats, and `@mention` invocation |
| **Iris Agents** | Specialized assistants with custom instructions, context, and tool access |
| **Iris Tools** | MCP integrations, web search, HTTP requests, code execution, and data visualization |
| **Iris Flow** | Visual workflows that can be published and invoked as reusable tools |
| **Iris Voice** | Realtime voice conversations with MCP tool access |
| **Iris Studio** | Image generation, artifacts, structured output, and rich content rendering |

Iris OS supports OpenAI, Anthropic, Google, xAI, OpenRouter, Ollama, and other
compatible providers. It is built with Next.js, the Vercel AI SDK, PostgreSQL,
and MCP.

## Quick Start

You need PostgreSQL and at least one AI provider API key. For a managed setup,
use the Vercel deployment flow. For full ownership, run Iris OS locally or with
Docker.

[Open the Vercel deployment guide](docs/tips-guides/vercel.md), or continue to
[Getting Started](#getting-started) for local installation.

## Table of Contents

- [Why Iris OS?](#why-iris-os)
  - [Product Principles](#product-principles)
- [Capabilities](#capabilities)
- [Quick Start](#quick-start)
- [How Iris OS Works](#how-iris-os-works)
  - [Browser Automation with Playwright MCP](#browser-automation-with-playwright-mcp)
  - [Visual Workflows as Custom Tools](#visual-workflows-as-custom-tools)
  - [Custom Agents](#custom-agents)
  - [Realtime Voice and MCP Tools](#realtime-voice-and-mcp-tools)
  - [Quick Tool Mentions and Presets](#quick-tool-mentions-and-presets)
  - [Tool Choice Mode](#tool-choice-mode)
  - [Default Tools](#default-tools)
- [Getting Started](#getting-started)
  - [Docker Compose](#docker-compose)
  - [Local Development](#local-development)
  - [Environment Variables](#environment-variables)
- [Guides](#guides)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Credits](#credits)

## How Iris OS Works

The following examples show how the layers of Iris OS work together.

### Browser Automation with Playwright MCP

**Example:** Control a web browser using Microsoft's [playwright-mcp](https://github.com/microsoft/playwright-mcp) tool.

- The LLM autonomously decides how to use tools from the MCP server, calling them multiple times to complete a multi-step task and return a final message.

Sample prompt:

```prompt
1. Use the @tool('web-search') to look up information about
   "Model Context Protocol."

2. Then, using : @mcp("playwright")
   - navigate to Google (https://www.google.com)
   - click the "Login" button
   - enter the email address provided in the prompt
   - click the "Next" button
   - Close the browser
```

### Visual Workflows as Custom Tools

**Example:** Create custom workflows that become callable tools in your chat conversations.

- Build visual workflows by connecting LLM nodes (for AI reasoning) and Tool nodes (for MCP tool execution)
- Publish workflows to make them available as `@workflow_name` tools in chat
- Chain complex multi-step processes into reusable, automated sequences

### Custom Agents

**Example:** Create specialized AI agents with custom instructions and tool access.

- Define custom agents with specific system prompts and available tools
- Easily invoke agents in chat using `@agent_name`
- Build task-specific assistants like a GitHub Manager agent with issue/PR tools and project context

For instance, create a GitHub Manager agent by:

- Providing GitHub tools (issue/PR creation, comments, queries)
- Adding project details to the system prompt
- Calling it with `@github_manager` to manage your repository

### Realtime Voice and MCP Tools

Iris Voice provides realtime conversations through OpenAI's Realtime API with
full MCP tool integration. Talk naturally while Iris OS executes tools and
reports progress in real time.

### Quick Tool Mentions and Presets

Quickly call tool during chat by typing `@toolname`.
No need to memorize — just type `@` and pick from the list!

**Tool Selection vs. Mentions (`@`) — When to Use What:**

- **Tool Selection**: Make frequently used tools always available to the LLM across all chats. Great for convenience and maintaining consistent context over time.
- **Mentions (`@`)**: Temporarily bind only the mentioned tools for that specific response. Since only the mentioned tools are sent to the LLM, this saves tokens and can improve speed and accuracy.

Each method has its own strengths — use them together to balance efficiency and performance.

You can also create **tool presets** by selecting only the MCP servers or tools you need.
Switch between presets instantly with a click — perfect for organizing tools by task or workflow.

### Tool Choice Mode

Control how tools are used in each chat with **Tool Choice Mode** — switch anytime with `⌘P`.

- **Auto:** The model automatically calls tools when needed.
- **Manual:** The model will ask for your permission before calling a tool.
- **None:** Tool usage is disabled completely.

This lets you flexibly choose between autonomous, guided, or tool-free interaction depending on the situation.

### Default Tools

#### Web Search

Built-in web search powered by [Exa AI](https://exa.ai). Search the web with semantic AI and extract content from URLs directly in your chats.

- **Optional:** Add `EXA_API_KEY` to `.env` to enable web search
- **Free Tier:** 1,000 requests/month at no cost, no credit card required
- **Easy Setup:** Get your API key instantly at [dashboard.exa.ai](https://dashboard.exa.ai)

#### Image Generation

Built-in image generation and editing capabilities powered by AI models. Create, edit, and modify images directly in your chats.

- **Supported Operations:** Image generation, editing, and composition
- **Current Models:** Gemini Nano Banana, OpenAI

#### JavaScript and Python Execution

Run JavaScript or Python for calculations, data transformation, prototyping,
and tool-assisted reasoning directly within a conversation.

#### Data Visualization

**Interactive Tables**: Create feature-rich data tables with advanced functionality:

- **Sorting & Filtering**: Sort by any column, filter data in real-time
- **Search & Highlighting**: Global search with automatic text highlighting
- **Export Options**: Export to CSV or Excel format with lazy-loaded libraries
- **Column Management**: Show/hide columns with visibility controls
- **Pagination**: Handle large datasets with built-in pagination
- **Data Type Support**: Proper formatting for strings, numbers, dates, and booleans

**Chart Generation**: Visualize data with various chart types (bar, line, pie charts)

> Additionally, many other tools are provided, such as an HTTP client for API requests and more.

These capabilities are designed to compose: an agent can search the web, run
code, transform the result, and pass it into a reusable workflow without
leaving Iris OS.

## Getting Started

> This project uses [pnpm](https://pnpm.io/) as the recommended package manager.

```bash
# If you don't have pnpm:
npm install -g pnpm
```

### Docker Compose

```bash
# 1. Install dependencies
pnpm i

# 2. Enter only the LLM PROVIDER API key(s) you want to use in the .env file at the project root.
# Example: The app works with just OPENAI_API_KEY filled in.
# (The .env file is automatically created when you run pnpm i.)

# 3. Build and start all services (including PostgreSQL) with Docker Compose
pnpm docker-compose:up

```

### Local Development

```bash
pnpm i

#(Optional) Start a local PostgreSQL instance
# If you already have your own PostgreSQL running, you can skip this step.
# In that case, make sure to update the PostgreSQL URL in your .env file.
pnpm docker:pg

# Enter required information in the .env file
# The .env file is created automatically. Just fill in the required values.
# For the fastest setup, provide at least one LLM provider's API key (e.g., OPENAI_API_KEY, CLAUDE_API_KEY, GEMINI_API_KEY, etc.) and the PostgreSQL URL you want to use.

pnpm build:local && pnpm start

# (Recommended for most cases. Ensures correct cookie settings.)
# For development mode with hot-reloading and debugging, you can use:
# pnpm dev
```

Alternative: Use Docker Compose for DB only (run app via pnpm)

```bash
# Start Postgres only via compose
# Ensure your .env includes: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB matching POSTGRES_URL
docker compose -f docker/compose.yml up -d postgres

# Apply migrations
pnpm db:migrate


# Run app locally
pnpm dev   # or: pnpm build && pnpm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser to get started.

### Environment Variables

The `pnpm i` command generates a `.env` file. Add your API keys there.

```dotenv
# === LLM Provider API Keys ===
# You only need to enter the keys for the providers you plan to use
GOOGLE_GENERATIVE_AI_API_KEY=****
OPENAI_API_KEY=****
XAI_API_KEY=****
ANTHROPIC_API_KEY=****
OPENROUTER_API_KEY=****
OLLAMA_BASE_URL=http://localhost:11434/api



# Secret for Better Auth (generate with: npx @better-auth/cli@latest secret)
BETTER_AUTH_SECRET=****

# (Optional)
# URL for Better Auth (the URL you access the app from)
BETTER_AUTH_URL=

# === Database ===
# If you don't have PostgreSQL running locally, start it with: pnpm docker:pg
POSTGRES_URL=postgres://your_username:your_password@localhost:5432/your_database_name

# (Optional)
# === Tools ===
# Exa AI for web search and content extraction (optional, but recommended for @web and research features)
EXA_API_KEY=your_exa_api_key_here


# Whether to use file-based MCP config (default: false)
FILE_BASED_MCP_CONFIG=false

# === File Storage ===
# Vercel Blob is the default storage driver (works in both local dev and production)
# Pull the token locally with `vercel env pull`
FILE_STORAGE_TYPE=vercel-blob
FILE_STORAGE_PREFIX=uploads
BLOB_READ_WRITE_TOKEN=

# -- S3 (coming soon) --
# FILE_STORAGE_TYPE=s3
# FILE_STORAGE_PREFIX=uploads
# FILE_STORAGE_S3_BUCKET=
# FILE_STORAGE_S3_REGION=

# (Optional)
# === OAuth Settings ===
# Fill in these values only if you want to enable Google/GitHub/Microsoft login

#GitHub
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

#Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# Set to 1 to force account selection
GOOGLE_FORCE_ACCOUNT_SELECTION=


# Microsoft
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
# Optional Tenant Id
MICROSOFT_TENANT_ID=
# Set to 1 to force account selection
MICROSOFT_FORCE_ACCOUNT_SELECTION=

# Set this to 1 to disable user sign-ups.
DISABLE_SIGN_UP=

# Set this to 1 to disallow adding MCP servers.
NOT_ALLOW_ADD_MCP_SERVERS=
```

## Guides

Step-by-step setup guides for running and configuring Iris OS.

### [MCP Server Setup and Tool Testing](./docs/tips-guides/mcp-server-setup-and-tool-testing.md)

- How to add and configure MCP servers in your environment

### [Docker Hosting Guide](./docs/tips-guides/docker.md)

- Self-host Iris OS with Docker, including environment configuration.

### [Vercel Hosting Guide](./docs/tips-guides/vercel.md)

- Deploy Iris OS to Vercel with a guided production setup.

### [File Storage Drivers](./docs/tips-guides/file-storage.md)

- Cloud-based file storage with Vercel Blob (default) for seamless uploads in both development and production. S3 support coming soon.

### [System Prompts and Workspace Customization](./docs/tips-guides/system-prompts-and-customization.md)

- Personalize Iris OS with system prompts, user preferences, and MCP tool instructions.

### [OAuth Sign-In Setup](./docs/tips-guides/oauth.md)

- Configure Google, GitHub, and Microsoft OAuth for secure user login support.

### [Adding OpenAI-Compatible Providers](docs/tips-guides/adding-openAI-like-providers.md)

- Connect providers that implement an OpenAI-compatible API.

### [End-to-End Testing Guide](./docs/tips-guides/e2e-testing-guide.md)

- Run Playwright tests for multi-user scenarios, agent visibility, and CI/CD.

### [Temporary Chat Windows](./docs/tips-guides/temporary_chat.md)

- Open lightweight popup conversations for side questions or testing without
  affecting the main thread.

## Roadmap

Planned features coming soon to Iris OS:

- [x] **File Upload & Storage** (Vercel Blob integration)
- [x] **Image Generation**
- [ ] **Collaborative Document Editing** (like OpenAI Canvas: user & assistant co-editing)
- [ ] **RAG (Retrieval-Augmented Generation)**
- [ ] **Web-based Compute** (with [WebContainers](https://webcontainers.io) integration)

Have an idea for the next Iris OS capability? Open a
[feature request](https://github.com/dwickyfp/iris-os/issues/new).

## Contributing

Bug reports, feature ideas, documentation, translations, and code contributions
are welcome. The goal is to build an open AI operating layer that remains
useful, understandable, and under its users' control.

Read the [Contributing Guide](./CONTRIBUTING.md) before opening a pull request or
proposing a major change.

For language contributions, see the
[translation guide](./messages/language.md).

## Credits

Iris OS is maintained by [Dwicky Feri](https://github.com/dwickyfp). It is based
on the open-source project originally created by
[Choi Sung Keun](https://github.com/cgoinglove) and includes work from its
contributors. The upstream history and attribution are preserved in this
repository.

Iris OS is released under the [MIT License](./LICENSE).
