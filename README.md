# YAAIOP — Yet Another AI Obsidian Plugin

Chat with an AI model inside Obsidian, grounded in your own notes. Works the same
on desktop and phone, talks only to an HTTPS API, and uses Smart Connections for
semantic search when you have it.

**Read-only for now.** It can search and read your notes; it cannot create, edit,
or delete anything.

## Network use

This plugin makes external network requests. Nothing happens in the background:
a request is only ever made when you take an action.

**Where requests go.** Only to the API of the provider you configured. With the
default Anthropic provider that is `https://api.anthropic.com/v1/messages`, and
nothing else. There is no server operated by this plugin, no analytics, no
telemetry, and no crash reporting. No third party sits between you and the
provider.

**When requests happen.**

| Trigger | Request |
| --- | --- |
| You send a chat message | One streaming request per turn, plus one more per round of tool calls |
| You press **Test connection** in settings | A single 16-token request to check the key and model |

**What is sent.** Your message, the conversation so far, and a system prompt
containing your vault's name, its folder names and file counts, today's date,
your **Extra instructions**, and your `CLAUDE.md` if that option is on. Then —
this is the important part — **whatever the model chooses to read**: the contents
of notes it opens, search snippets, and any images or PDFs it inspects.

That is the deal a vault-aware assistant makes. It can only answer from your
notes because your notes are sent to the model. If a folder should never leave
your machine, do not point the plugin at a vault that contains it; there is no
per-folder exclusion yet (it is on the roadmap as part of write support). Your
provider's data-retention and training policy governs what happens to that
content once it arrives — check it before pointing this at a sensitive vault.

**What is never sent.** Nothing is transmitted anywhere else. Smart Connections,
when you use it, runs entirely locally — its embeddings live in your vault and
this plugin only asks it for rankings in-process.

## Why another one?

There are already good AI plugins for Obsidian. This one exists because of a
specific combination of constraints that existing options each break in at least
one place:

### 1. API calls only — no MCP, no terminal, no local runtime

Many AI integrations assume a machine underneath them: an MCP server to launch, a
shell to call, a Node process, a local model runtime, a companion desktop app.
That is a reasonable assumption on a laptop and a wrong one on a phone.

YAAIOP does exactly one kind of outbound work: HTTPS requests to a provider's API.
No subprocesses, no local server, no daemon to keep running, nothing to install
outside Obsidian. If a device can reach the internet and run Obsidian, the plugin
works — which is what makes a phone a first-class target rather than a degraded
one.

The cost of that choice is that the API key lives on the device (see
[How API keys are handled](#how-api-keys-are-handled)) and every request is billed
to you directly. The benefit is that there is no backend to run, trust, or pay
for, and nothing sitting between your vault and the provider.

### 2. Mobile-friendly in architecture *and* interface

Mobile support is usually claimed at the manifest level (`isDesktopOnly: false`)
and then broken by a dependency that only exists on desktop. Both layers are
treated as requirements here:

**Architecture.** The bundle is built for the browser, not Node — Obsidian on iOS
and Android is a webview with no filesystem, no `require`, and no `process`. The
build resolves browser entrypoints, and the shipped bundle is checked for Node
built-ins and unguarded `process` access. Provider SDKs are configured for direct
browser calls, so no proxy is required.

**Interface.** The panel opens as a sidebar on desktop and a full-screen sheet on
mobile. Enter sends on desktop but inserts a newline on a phone, where there is no
modifier key to hold — sending is the button's job there. The composer is 16px so
iOS does not zoom the viewport on focus, respects the safe-area inset above the
home indicator, and grows to a capped height. Wide content (tables, code) scrolls
inside its own message rather than stretching the panel. Streaming writes plain
text and renders Markdown once at the end, because re-rendering a whole message
per token is not viable on a phone.

### 3. Smart Connections compatibility, not replacement

If you already run [Smart Connections](https://smartconnections.app), your vault
is already embedded. Building a second, competing index would mean re-embedding
everything, storing another copy, and keeping it fresh.

Instead YAAIOP asks Smart Connections for rankings when it is present, and reads
actual note content through Obsidian's own vault API. The integration is
feature-detected at call time and fails soft: if the plugin is missing, disabled,
still loading, or its API changes, search falls back to built-in keyword matching.
Semantic search is an upgrade, never a hard dependency — and the model is told
which one answered, so it can adjust how it queries.

## What it does

- A chat panel: right sidebar on desktop, full-screen sheet on mobile.
- The model decides when to search your vault and which notes to open, then
  answers citing `[[wikilinks]]` you can tap through.
- **Not just markdown.** Images and PDFs are searchable and readable — the model
  can actually look at them, not just see a filename.
- Reasoning models are supported: an effort dial, reasoning streamed into a
  collapsible block, and reasoning preserved across turns.
- Picks up a **CLAUDE.md** in your vault, if you have one and want it used.
- **Saved prompts** — reusable openers for starting a chat.
- **Chat history** — past conversations are saved so you can reopen them, and can
  be switched off.

### Tools available to the model

All read-only:

| Tool | Purpose |
| --- | --- |
| `search_vault` | Semantic search via Smart Connections, else keyword search — covers notes and attachments |
| `read_file` | Full contents of one file: text, or an image/PDF attached for the model to inspect |
| `list_files` | Browse paths, filtered by folder, filename substring, or kind |
| `recent_files` | Most recently modified files, newest first |
| `file_links` | Links, backlinks, and the text surrounding each reference |

### Beyond markdown

Obsidian vaults are not just notes, so neither is this. Files are classified and
handled by what they actually are:

| Kind | Handling |
| --- | --- |
| Notes (`.md`) | Read as text |
| Text-like (`.txt`, `.csv`, `.json`, `.canvas`, `.svg`, source files, …) | Read as text |
| Images (`.png`, `.jpg`, `.gif`, `.webp`) | Attached to the conversation for the model to look at |
| PDFs | Attached as native documents, so layout and figures survive |
| Everything else | Metadata and context only |

Two details make this useful rather than merely possible:

**Context, not just content.** An attachment's filename is usually meaningless —
`IMG-20260730-WA0071.jpg` says nothing. What explains it is the sentence next to
the embed. So attachments are matched on the text of notes that embed them, and
every attachment read comes back with the surrounding prose. `file_links` on an
image tells you which notes reference it and what they say around the reference.

**Cost and limits are handled up front.** Vault photos are routinely several
thousand pixels wide; sending them untouched is slow on mobile data and expensive,
since image cost scales with resolution. Images are downscaled to a configurable
long edge (default 1568px) before being sent, with a hard per-image ceiling as a
backstop if downscaling fails. Files above **Max attachment size** are described
rather than sent, and if the selected model can't accept images or PDFs, the
attachment is skipped and its context returned instead — the model is told why,
so it can fall back to reading the embedding note.

### Project instructions (CLAUDE.md)

If a `CLAUDE.md` exists at the configured path (default: vault root), its contents
are appended to the system prompt on every message. Turn this off with
**Use CLAUDE.md**, or point it elsewhere with **Instructions file path** — a blank
path disables it too. The setting tells you whether a file was actually found.

The file is passed with a caveat: a CLAUDE.md written for a coding agent usually
references tools this plugin does not have (MCP servers, shells, file writes), so
the model is told to follow the conventions and context it describes but ignore
instructions to use tools that aren't in its tool list. It cannot override the
read-only limit.

### Saved prompts

Add them under **Settings → Saved prompts** (name + body, reorderable). They
appear as one-tap buttons on the blank chat screen — clicking one starts the chat
immediately — and via the **Start chat from saved prompt** command, which opens a
fuzzy picker matching both names and bodies.

### Chat history

On by default. Conversations are written to `sessions.json` in this plugin's
folder after every turn, including turns you stop or that error. Reopen one with
the clock icon in the panel header or the **Open a saved chat** command; the
transcript is rebuilt including tool calls and reasoning.

Because it lives in the plugin folder inside the vault, history travels with
whatever sync the vault already uses — unlike the API key, which is deliberately
device-local. Turn it off with **Save chats**; existing chats stay until you use
**Delete all saved chats**. Old chats are pruned past the configured count, and
also past a 5 MB file budget so one tool-heavy conversation cannot bloat the vault.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/yaaiop/`, then enable the plugin under
**Settings → Community plugins → Installed plugins**. Open **Settings → YAAIOP**
and paste your provider API key.

Open the chat with the message-circle ribbon icon or the **YAAIOP: Open chat**
command.

For mobile, sync that plugin folder using whatever sync method the vault already
uses, then enable the plugin and enter the key again on the device.

## How API keys are handled

**Keys are never written into your vault.** They go to Obsidian's per-device
local storage (`app.saveLocalStorage`), namespaced per provider so switching
backends doesn't lose the other's key.

### Why not the normal place

Obsidian plugins conventionally store settings in
`.obsidian/plugins/<id>/data.json`. That file is *inside the vault*, which means
every sync mechanism treats it as vault content:

- **Obsidian Sync / remotely-save / any cloud folder** would copy the key to a
  third-party server.
- **git-based sync** would commit it — and a secret in git history survives
  deleting the file, so the practical fix is rotating the key and rewriting
  history.

A leaked API key is not just a privacy problem: it is billable. Someone else
spends your money until you notice and revoke it.

### Why device-local is the safest option available here

Given the plugin's constraints, the alternatives are worse:

| Option | Why not |
| --- | --- |
| `data.json` in the vault | Syncs and commits the key, as above |
| A backend that holds the key | Contradicts the API-only design and just moves the trust to a server you'd have to run and secure |
| OS keychain | Obsidian exposes no keychain API to plugins, and there is no equivalent on mobile |

Device-local storage is the only option that keeps the key out of every sync
path while requiring no infrastructure. It is a deliberate trade of a little
convenience for a meaningfully smaller blast radius.

### The cost, stated plainly

**You must re-enter the key on every device.** Desktop and phone each need it
once. This is the direct consequence of the key not syncing — the same property
that keeps it out of your git history is what stops it travelling to your phone
for you. Everything else (provider, model, effort, saved prompts, limits) does
live in `data.json` and syncs normally, so only the secret is manual.

### What this does not protect against

Local storage is **not encrypted**. Any process with access to your Obsidian
profile directory can read it, and this plugin cannot change that. Treat it as
"not shared over the network", not "safe from local attackers". Use a key scoped
to this purpose and set a spend limit in your provider's console, so a
compromise is bounded and revocable.

## Roadmap

- [ ] **More providers.** The core is already provider-neutral (see
      [Architecture](#architecture)); what remains is writing adapters — OpenAI,
      Google, OpenRouter, and local runtimes such as Ollama or LM Studio for
      people who would rather not send notes to a hosted API at all.
- [ ] **Per-prompt model choice.** Let a saved prompt pin its own provider and
      model, so a cheap model handles routine lookups and an expensive one handles
      analysis.
- [ ] **Write support**, gated behind an explicit confirmation step: append to a
      daily note, create a note from a conversation, update frontmatter. The tool
      loop and UI already accommodate it; the interesting design work is the
      approval flow, not the tools.
- [ ] **Note and selection context.** Send the active note or the current
      selection as context without making the model search for it.
- [ ] **More formats.** Audio and video are currently metadata-only; transcription
      (or a provider that accepts them natively) would make voice memos and
      screen recordings first-class. Office documents likewise need extraction.
- [ ] **Better long-conversation handling.** Summarise or drop old tool results as
      a chat grows, instead of leaning on the provider's context window.
- [ ] **Cost visibility.** Per-turn token usage and a running session total.

## Architecture

Provider-neutral by construction. The chat engine, UI, and persistence layer speak
one set of vendor-free types (`ChatMessage`, `ChatPart`, `ToolDefinition`); each
provider adapter translates those to and from its own wire format. Only
`src/providers/<vendor>.ts` may import a vendor SDK — that boundary is what makes
the roadmap's multi-provider item a matter of adding a file rather than a rewrite.

One detail worth knowing if you write an adapter: some providers require reasoning
blocks to be echoed back byte-identical (signature included) for a conversation to
continue, so `ThinkingPart` carries the provider's original block in an opaque
`raw` field, and adapters replay it untouched rather than reconstructing it from
text.

**Adding a provider:** implement `ChatProvider` in `src/providers/<name>.ts` and
register it in `src/providers/index.ts`. Settings, the model picker, and
per-provider key storage all read from that registry.

| File | Role |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, provider wiring, commands, view registration |
| `src/providers/types.ts` | Vendor-free types and the `ChatProvider` contract |
| `src/providers/anthropic.ts` | Anthropic adapter (the only file importing its SDK) |
| `src/providers/index.ts` | Provider registry |
| `src/agent.ts` | System prompt and the streaming tool-use loop |
| `src/vault-tools.ts` | Tool schemas, read-only implementations, instructions loading |
| `src/files.ts` | File-type classification, binary loading, image downscaling |
| `src/search.ts` | Smart Connections adapter + keyword fallback |
| `src/view.ts` | Chat UI, transcript rendering, autosave |
| `src/store.ts` | Saved-chat persistence and pruning |
| `src/modals.ts` | Saved-prompt picker and chat-history browser |
| `src/settings.ts` | Settings, provider/model selection, API-key storage |

## Development

```bash
npm install
npm run dev     # watch mode, writes main.js in place
npm run build   # typecheck + minified production build
```

To have the watch build land straight in a vault:

```bash
VAULT_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/yaaiop" npm run dev
```

Reload Obsidian (or toggle the plugin off/on) to pick up a new build.
