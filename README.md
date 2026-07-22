<div align="center">

# GITMIR Claude Control

**A local, single-file dashboard to run [Claude Code](https://www.anthropic.com/claude-code) across all your projects — with a per-project task log and a live business-logic model of each product.**

Launch Claude in any project with one click · copy reusable skills into your session · visualize your product's data, flows, processes and entity lifecycles — all in an offline, dependency-free HUD.

Built on the **GITMIR multidimensional model** — the living source-of-truth model behind **[gitmir.com](https://gitmir.com)**.

</div>

---

## What it is

You keep dozens of projects in different folders and launch `claude` from each. **GITMIR Claude Control** is a local web dashboard that holds them all:

- **Left:** your project list (add any folder on any disk).
- **Right, per project:**
  - **Settings** — name, path, description, and one-click **▶ Run Claude** (opens a terminal in that folder and starts `claude`). Cross-platform: macOS Terminal, Windows `cmd`, Linux terminals.
  - **Tasks** — a live log of what Claude did in the project (`.claude/tasks.json`), driven by the `task-log` skill.
  - **Model** — a visualization of the project's **`.gitmir/model/`**: overview, ER (data), data flow, processes, and a **Business logic** view that traces an entity's lifecycle (how/when its status changes, with triggers and side effects) — laid out with [ELK](https://github.com/kieler/elkjs) and rendered as SVG in a holographic "HUD" style.

It's **one Node file, no npm dependencies**. Everything it needs (ELK, fonts) is vendored locally, so it runs fully offline.

## The multidimensional model — from the GITMIR lab

The `.gitmir/model/` is not just documentation. It is a **multidimensional
object-information model** of your product — a living blueprint of what the software
*is*, not the code itself. Ten linked dimensions, each a different lens on the same
product:

`modules` · `entities` · `serverUnits` · `serverFunctions` · `apiRoutes` ·
`frontendUnits` · `events` · `processes` · `statusFlows` · `reactions`

Every reference is a **stable id**, so the collections form one connected graph
rather than ten disconnected lists — a human and an AI can both read it at a glance
and act on it without re-reading the whole repository. The **Business logic** view
walks a single entity through its lifecycle: how and when its status changes, which
processes drive it, and what side effects fire.

This model — and the idea of a single, living **source of truth** for a codebase —
comes out of the **GITMIR lab**. It is the same information model that powers
[GitMir](https://gitmir.com), the control room for AI software development. This
repository is the open-source companion that builds that model locally (via the
`gitmir-model` skill) and renders it.

## Requirements

- [Node.js](https://nodejs.org) 18+
- The Claude Code CLI (`claude`) installed and on your `PATH`
- macOS, Windows, or Linux

## Run

```bash
git clone https://github.com/gitmir-hello/gitmir-claude-control.git
cd gitmir-claude-control
node server.js
```

It starts on **http://localhost:4599** and opens your browser. On macOS you can also just double-click **`start.command`**.

Stop with `Ctrl+C`.

## Skills

Skills are reusable instructions you copy from the dashboard (**Settings → 📋 skill**) and paste into your Claude session (`⌘V`/`Ctrl+V` + Enter). They live in [`skills.json`](skills.json); add your own by pointing an entry at a `.md` file.

- **`task-log`** — Claude keeps a human-readable log of completed tasks in the project's `.claude/tasks.json`; the **Tasks** tab shows it live.
- **`gitmir-model`** — Claude builds/updates the project's **multidimensional object model** in `.gitmir/model/` (entities, server units & functions, API routes, frontend units, events, business processes, status flows, reactions — all cross-linked by stable id) from the real code. It also installs a standing rule into the project's `CLAUDE.md` so the model stays the product's living source of truth: consult it before working, update it after code changes. The **Model** tab visualizes it.

Run `gitmir-model` once per project (then re-run after changes — it's idempotent) and the **Model** tab lights up with data (ER), data-flow, process and entity-lifecycle diagrams.

## Design

The UI follows the **GITMIR "holo / HUD"** design language — deep-navy `#04060a`, electric cyan `#2fd8ff`, sharp technical plates with glowing corner brackets, `Onest` + `JetBrains Mono` typography.

## About GITMIR

**[GitMir](https://gitmir.com) is the control plane for AI development:** describe
what to build in plain language, run it on your own Claude Code over MCP, and see
exactly what changed — in code, business logic and data flows. Its landing is a
sci-fi *information model lab* — because the model is the point: one living
source of truth for your product instead of code you have to re-read every time.

- 🌐 Website — **[gitmir.com](https://gitmir.com)**
- 🚀 App — **[ide.gitmir.com](https://ide.gitmir.com)**
- ✉️ **hello@gitmir.com**

**GITMIR Claude Control** is a small open-source tool from the same lab — bringing
the GITMIR model and one-click Claude runs to your local machine.

## Third-party & credits

Bundled libraries and fonts are included under their own licenses — see [THIRD_PARTY.md](THIRD_PARTY.md). The GITMIR logo is a trademark of GITMIR.

## License

[GPL-3.0](LICENSE) © GITMIR
