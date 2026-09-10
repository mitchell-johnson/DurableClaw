# DurableClaw

An AI assistant that keeps your conversations, works with your files, and helps you follow through on research and everyday tasks.

Run your own private workspace, choose how the assistant responds, and decide which tools it can use. Saved conversations let you return to earlier work without starting from scratch.

## What you can do

- **Work with your files.** Find documents, ask questions about their contents, and review proposed changes before they are saved.
- **Research several questions at once.** Ask the assistant to investigate different parts of a topic in the background and bring the findings back into your conversation.
- **Browse the web.** Read websites and ask the assistant to interact with them. You review and approve actions such as filling forms or clicking buttons.
- **Calculate and transform data.** Let the assistant write and run small scripts to check calculations, clean up data, or turn a list into a useful summary. Results come back into the conversation.
- **Remember what matters.** With memory enabled, keep useful preferences and context for future conversations. You can review saved memories or ask the assistant to forget them.
- **Stay on top of follow-ups.** Schedule inbox items and opt into periodic checks for relevant updates from connected application events.
- **Make it your own.** Adjust the assistant's personality, choose quick or more thorough responses, and control which tools are available.

## Things to try

Once your installation is ready, try asking:

- “Find the notes about this project and summarize the decisions we've made.”
- “Research these three questions separately and bring back the findings.”
- “Open this website and explain what it says.”
- “Use a script to group these expenses by category and calculate the totals.”
- “Draft an update to my project notes and show me the changes before saving.”
- “Remember that I prefer short answers.”

File requests use your workspace. Memory and optional integrations need to be enabled before the assistant can use them.

## You're in control

The assistant asks for approval before changing workspace files, interacting with websites, or running tools from connected services. You can restrict its tools, decline a proposed action, or stop work in progress. Stopping cannot undo an action a website has already received.

Periodic checks and memory consolidation are off by default. Enable them when you want them, with limits on background activity.

Your workspace is private to your installation's authenticated users, but requests to AI models and connected services are processed by those providers. Self-hosting does not mean everything runs locally.

## Get started

DurableClaw is a self-hosted project, not a hosted sign-up service. You'll need a Cloudflare account, an OpenRouter API key, and some command-line setup. Hosting and model usage may incur charges.

1. Follow the [installation guide](docs/setup.md) to run it locally or deploy your own copy.
2. Open your installation and sign in with the access token you configured.
3. Start a conversation, adjust your preferences, and enable the optional features you want.

The default installation is for one owner. Supporting multiple users requires additional authentication setup. Refreshing the page currently requires signing in again.

## Technical details

DurableClaw runs on Cloudflare Workers with a React interface. Durable Objects and SQLite keep conversation and task state, R2 stores workspace files, and optional Vectorize indexes support memory and document search. AI models are configured through OpenRouter.

Web browsing uses Cloudflare Browser Run. Kitesurf is preferred for new tasks; Chromium is available for persistent login sessions, recovery, and sites that need fuller browser compatibility. Browser sessions are separate for each conversation.

Code execution uses Cloudflare Dynamic Workers and requires Workers Paid, with a fresh isolated JavaScript environment for each script. Scripts cannot access the network, workspace storage, or credentials; reading and saving files still use the existing tools.

For setup, integration work, or contributions:

- [Installation and development](docs/setup.md) — prerequisites, configuration, deployment, optional search, and checks.
- [Browser setup and behavior](docs/browsing.md) — engine selection, approvals, session limits, and live testing.
- [Code execution](docs/code-execution.md) — script format, isolation, limits, and setup.
- [Architecture](ARCHITECTURE.md) — components and how they fit together.
- [API and integrations](docs/api.md) — authentication, application connections, and MCP tools.
- [Runtime guarantees](docs/runtime.md) — recovery, cancellation, deadlines, and failure behavior.
- [Upgrade guide](docs/upgrading.md) — updating an existing installation safely.
