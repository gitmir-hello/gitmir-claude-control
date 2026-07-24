# Security & privacy

**Short version:** GITMIR Claude Control runs entirely on your machine and makes
**no network calls to our servers**. No account, no telemetry, nothing uploaded.
You can verify every claim on this page yourself in a few minutes — it's one file
with zero dependencies.

This matters most for teams under an NDA: your source code and your product's
business logic never sit on someone else's server, because they never leave your
computer.

## What touches the network

Exactly two things, and neither is us:

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

No `gitmir.com` endpoint — or any other third-party host — is ever contacted.

## What this tool never does

- **No telemetry, analytics, or phone-home.** There is no usage tracking of any
  kind.
- **No account, no sign-in, no cloud.** You never log in anywhere.
- **Never uploads your data.** Your code, your `.gitmir/` model, your tasks, your
  project names and paths — none of it is sent anywhere. It all stays in files on
  your disk.
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

## Future team features

If we later add optional team sharing, it will follow the same rule and be
**opt-in**: the server will act as a **relay** that routes a model or a task
between your team's own machines and **stores no business logic**. Your code and
your logic stay on your machines either way — the server's job is connectivity,
never storage.

## Reporting an issue

Found something that contradicts the above, or a vulnerability? Please email
**security@gitmir.com** (or open a private advisory on the repository). We take it
seriously — the whole point of this tool is that you can trust it because you can
check it.
