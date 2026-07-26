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
- **No third-party dependencies.** Zero npm packages (`node_modules` is empty). The
  optional Team bridge needs Node 22+ for that built-in `WebSocket`; the dashboard
  itself runs on Node 18+.
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

- **While it is connected, your task queue is published to the room — automatically.**
  This is the point of the bridge: your teammates (and, on a paid plan, the client
  paying to follow along) see what you are working on and what is next. So be precise
  about what that means. While the Team panel is connected, the tool watches
  `tasks/todo`, `tasks/inprogress`, `tasks/verify` and `tasks/done` and sends the room
  an updated list whenever a file changes: each task's **title, body text, status,
  order and acceptance criteria**. It is your task notes that travel — **never your
  source code**. Disconnect and it stops immediately.
- **The model is shared when you ask, or automatically only at the `full` level.** A
  snapshot of `.gitmir/model` leaves your machine when you click **Share model**, and —
  if the project owner set mirroring to `full` — when the model changes. At any lower
  level a snapshot is not sent.
- **How much is *stored* is set by the project owner, and the tool always shows it.**
  The Team panel states the current level in plain words — *"Nothing leaves this
  machine"*, *"This project mirrors: the task queue"*, or *"…the task queue + the
  product model"* — and updates the moment the owner changes it. You cannot change the
  level from here; you can always see it, and you can always disconnect.
- **Source code is never uploaded, at any level.** Not behind a flag, not as an
  attachment. There is no code path in this tool that sends file contents from your
  repository, and no endpoint on the server that would accept them.
- Incoming items from teammates are written to *your* local disk — a shared model to
  `.gitmir/shared/<teammate>/`, a task to `tasks/todo/` — so you read and act on them
  in your own local instance.
- **The relay stores no business logic.** It forwards live messages between the
  online members of your team and keeps nothing at rest. Your code and your model
  live on your machines; the relay's only job is connectivity. This is what makes
  the bridge usable by teams under an NDA.
- **The key is a local credential.** Your workspace key is entered in the UI and
  kept **locally in your browser only** — it is never written into the repo, never
  committed, and is sent to nowhere except the relay, as the connection credential.
- **Incoming data from teammates is sandboxed.** A model snapshot arriving over the
  bridge can only create plain `*.json` files inside
  `.gitmir/shared/<teammate>/model/` — file names are reduced to a basename, the
  resolved path is checked to be inside that folder, and size/count caps apply. A
  peer cannot write outside it, cannot overwrite your own `.gitmir/model/`, and
  cannot crash the dashboard with a malformed message. An incoming task becomes a
  file in `tasks/todo/` and is labelled as a request from a teammate — nothing runs
  by itself; your local Claude only acts on it when you run the queue.
- **Local API calls are same-origin only.** The dashboard refuses `/api/*` requests
  carrying a foreign `Origin`, or a `Host` header that isn't localhost, so a web
  page you happen to visit cannot drive this tool or turn the bridge on behind your
  back (that also closes DNS-rebinding).
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
