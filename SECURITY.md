# Security & privacy

**Short version:** GITMIR Claude Control runs entirely on your machine and makes
**no network calls to our servers**. No account, no telemetry, nothing uploaded.
You can verify every claim on this page yourself in a few minutes — it's one file
with zero dependencies.

This matters most for teams under an NDA: your source code and your product's
business logic never sit on someone else's server, because they never leave your
computer.

## What touches the network

By default, exactly two things — and neither is us:

1. **The dashboard ↔ your browser — `localhost` only.** The tool serves a local
   web UI on `http://localhost:4599`. Every request the page makes (`/api/...`)
   goes to that local server on your own machine. Nothing leaves the loopback
   interface.
2. **Claude Code — talks to Anthropic under *your* account.** This tool's job is
   to *launch* `claude` in your project folder. Once running, Claude Code
   communicates with Anthropic using your own credentials/subscription — exactly
   as it does when you run `claude` yourself in a terminal. **This tool adds
   nothing to that and sees none of it.** If you trust Claude Code, nothing here
   changes your exposure; if you don't, this tool doesn't increase it.

A third connection exists **only if you turn on the Team bridge** (see below): an
outbound WebSocket from the dashboard to the GitMir relay, opened when you enter a
workspace key and click Connect. Until you do that, no `gitmir.com` endpoint — or
any other third-party host — is ever contacted.

## What this tool never does

- **No telemetry, analytics, or phone-home.** There is no usage tracking of any
  kind.
- **No account, no sign-in, no cloud.** You never log in anywhere.
- **Never uploads your data on its own.** Your code, your `.gitmir/` model, your
  tasks, your project names and paths — none of it is sent anywhere unless you
  explicitly opt into the Team bridge and *choose* to share a model or send a task
  (see below). Nothing is uploaded in the background, ever.
- **No third-party dependencies.** Zero npm packages (`node_modules` is empty).
  Everything it needs — ELK for diagram layout, the fonts — is vendored locally
  under `vendor/`. There is no transitive code you can't see running behind your
  back.

## Verify it yourself

You don't have to trust this page. Three independent ways to confirm it:

1. **Read the code.** The entire tool is a single `server.js`. Skim it — every
   route is a local file operation or an `open`/terminal launch. There is no
   outbound HTTP client in it.
2. **Run it air-gapped.** Disconnect from the network and start it. The dashboard,
   the model view, the task log — all keep working. (Only *launching Claude* needs
   the network, because Claude talks to Anthropic — see above.)
3. **Watch outbound connections.** Point Little Snitch / `lsof -i` / `tcpdump` at
   the process. You will see loopback traffic and — only if you launch Claude —
   connections from `claude` to Anthropic. Nothing to us.

## Where your data lives (all local)

- **Projects list:** `projects.json` in this folder.
- **The product model:** `.gitmir/model/*.json` inside each of *your* project
  folders.
- **Task log / queue:** `.claude/tasks.json` and `tasks/` inside your projects.
- **Skills:** `skills/*.md` in this folder — plain text you can read and edit.

## Team bridge (optional, opt-in)

The dashboard has an optional **Team bridge** that connects your machine to your
teammates' machines through the GitMir relay. It is **off until you turn it on** —
you enter a workspace key, pick a project, and click Connect. It follows the same
rule as everything else here: **the relay routes, it does not store.**

- **Only what you choose transits it.** Nothing is shared automatically. A model
  snapshot (your `.gitmir/model` JSON) leaves your machine only when you click
  **Share model**; a task (a title and some text) leaves only when you click
  **Send task**. Incoming items from teammates are written to *your* local disk —
  a shared model to `.gitmir/shared/<teammate>/`, a task to `tasks/todo/` — so you
  read and act on them in your own local instance.
- **The relay stores no business logic.** It forwards live messages between the
  online members of your team and keeps nothing at rest. Your code and your model
  live on your machines; the relay's only job is connectivity. This is what makes
  the bridge usable by teams under an NDA.
- **The key is a local credential.** Your workspace key is entered in the UI and
  kept **locally in your browser only** — it is never written into the repo, never
  committed, and is sent to nowhere except the relay, as the connection credential.
- **Still zero-dependency.** The bridge uses Node's built-in WebSocket — no added
  npm packages, nothing new to audit beyond the code in `relay.js`.
- **Gated by your plan, not by us watching you.** Access to the relay requires a
  paid Team plan; a free key is refused at connect time. The gate is a plan check,
  not surveillance — no usage is tracked.

If you never open the Team panel, none of this runs and the tool behaves exactly as
the sections above describe: your machine, and nothing outbound but Claude.

## Reporting an issue

Found something that contradicts the above, or a vulnerability? Please email
**security@gitmir.com** (or open a private advisory on the repository). We take it
seriously — the whole point of this tool is that you can trust it because you can
check it.
