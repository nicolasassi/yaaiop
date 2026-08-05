# Yaaiop

Yet Another AI Obsidian Plugin. Chat with an AI model about your notes, on desktop and on your phone.

The plugin is read-only. It can search and read your vault, but it never creates, edits, or deletes files.

## Why it exists

There are already several AI plugins for Obsidian. This one was built around four constraints:

- **It has to work on a phone.** The plugin only makes HTTPS calls to a provider API. There is no MCP server to launch, no terminal, no local runtime, and no companion app, so a phone behaves the same as a laptop.
- **You shouldn't be locked to one vendor.** The chat engine speaks provider-neutral types and never touches a vendor SDK, so a backend is one adapter file and switching is a dropdown.
- **It should reuse Smart Connections, not compete with it.** If you already have that plugin, your vault is already embedded. Yaaiop asks it for search rankings, and falls back to keyword search when it isn't installed.
- **A vault is more than markdown.** Images and PDFs are searchable, and the model can open them.

## Features

- Chat panel in the sidebar on desktop, full screen on mobile.
- The model searches your vault and opens notes on its own, then answers with `[[wikilinks]]` you can tap.
- Reads images and PDFs, and finds them through the text of the notes that embed them.
- Saved prompts for conversations you start often.
- Memory: it suggests things worth carrying between chats, you tap the ones to keep. Off by default.
- Chat history, so you can reopen past conversations. Can be turned off.
- Picks up a vault instructions file if you have one — `CLAUDE.md`, `AGENTS.md`, or whatever you point it at.
- Four backends — Anthropic, OpenAI, Google, and OpenRouter — with a model picker and a reasoning effort dial.

## Installation

Requires Obsidian 1.13.0 or later.

**With [BRAT](https://github.com/TfTHacker/obsidian42-brat)**, which also keeps it updated: add `nicolasassi/yaaiop` as a beta plugin.

**Manually:**

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/nicolasassi/yaaiop/releases).
2. Put them in `<vault>/.obsidian/plugins/yaaiop/`.
3. Enable **Yaaiop** in Settings → Community plugins.

`main.js` and `styles.css` are built by GitHub Actions and carry [artifact attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds), so you can confirm a download was built from this repository:

```sh
gh attestation verify main.js -R nicolasassi/yaaiop
```

Either way, open Settings → Yaaiop, pick a provider, and paste that provider's API key. **Test connection** checks it.

For mobile, sync that folder the way you already sync your vault, then enter the key again on the device.

## Usage

Open the chat with the ribbon icon or the **Open chat** command, then ask a question. The model decides what to read.

Other commands: **New chat**, **Start chat from saved prompt**, **Open a saved chat**. The panel header has buttons for saved chats and for starting a new one.

### Supported files

| Type | What the model gets |
| --- | --- |
| Notes, `.txt`, `.csv`, `.json`, `.canvas`, source files | Full text |
| Images (png, jpg, gif, webp) | The image itself |
| PDFs | The document itself |
| Anything else | Filename, size, and the notes that reference it |

Attachments are also matched on the text around them, since a filename like `IMG-20260730-WA0071.jpg` says nothing on its own. Images are downscaled before being sent, to keep requests small.

### Memory

Off by default. Turn it on in **Settings → Yaaiop → Memory**.

After each reply, a small model checks whether anything is worth knowing next time — how a folder is organised, how you want answers written, a fact you'd otherwise repeat. Suggestions appear under the chat as **Add to memory?**; tap one to keep it, ✕ to skip, or collapse the strip to get out of the way. Nothing is kept unless you tap it.

Kept memories work like the instructions file — added to the system prompt on every message, in every chat. Edit or delete them in settings, up to 50.

**It costs tokens on every call**, which is why it ships off: memories are re-sent with every message, and each reply triggers one extra request. They live in the plugin's `data.json` with your other settings, never in your notes.

### Providers

Pick one in **Settings → Yaaiop → Provider**. All four support tool use, images, PDFs, and reasoning, so the plugin behaves the same whichever you choose.

| Provider | Models offered | Key from |
| --- | --- | --- |
| **Anthropic** | Claude Opus 5, Sonnet 5, Opus 4.8, Haiku 4.5 | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **OpenAI** | GPT-5.6 Sol, Terra, Luna | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Google** | Gemini 3.1 Pro, 3.6 Flash, 3.5 Flash-Lite | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **OpenRouter** | A cross-section: Claude, GPT, Gemini, Grok, Kimi, DeepSeek | [openrouter.ai/keys](https://openrouter.ai/keys) |

**Keys are stored per provider**, so switching back and forth never loses the other ones — but each is entered once per device, like any other key here.

**Switching provider** resets the model to that provider's default. A chat saved under one provider reopens fine under another; its stored reasoning is dropped rather than replayed, because the formats aren't interchangeable and sending one provider's reasoning to another is rejected.

Provider-specific notes:

- **OpenAI** — **Show reasoning** needs a verified organisation. Without one the plugin falls back to answering without visible reasoning instead of failing the message, and stops asking for the rest of the session.
- **Google** — the reasoning dial has five steps but Gemini has four, so `xhigh` and `max` both land on Gemini's `high`. Gemini 3.1 Pro is a preview model and may be withdrawn at short notice, which is why the stable 3.6 Flash is the default rather than the more capable Pro.
- **OpenRouter** — the model list is a cross-section, not a catalogue: OpenRouter carries hundreds of models and the picker is a dropdown. Anything not listed needs an entry adding to `src/providers/openrouter.ts`. Requests carry an `X-Title` attribution header identifying the plugin; nothing about you or your vault is in it.

### Settings worth knowing

- **Provider**, **Model**, and **Reasoning effort** control cost and answer quality.
- **Search results per query** and **Max characters per note** cap how much of your vault goes into a request.
- **Max image edge** trades image detail against cost.
- **Extra instructions** is appended to the system prompt. Use it for folder conventions the model can't guess.
- **Use a vault instructions file** reads a note of standing instructions into the system prompt. It defaults to `CLAUDE.md` because that's what most vaults already have, but the name means nothing to the plugin — point it at `AGENTS.md` or anything else, on any provider. If yours was written for a coding agent, the model is told to follow the conventions in it and ignore instructions about tools this plugin doesn't have.

## API keys

Your key is stored in Obsidian's per-device local storage, not in the plugin's `data.json`.

`data.json` lives inside the vault, so Obsidian Sync would copy your key to a server, and git-based sync would commit it, where it survives in history after you delete the file. A leaked key is billable to you until you notice.

The cost of keeping it out of the vault is that **you enter the key once per device**. Every other setting still syncs normally.

Local storage is not encrypted. Anything with access to your Obsidian profile can read it, so use a key scoped to this plugin and set a spend limit with your provider.

## Network use

The plugin sends requests to the API of the provider you configure, and to nothing else. There is no analytics, no telemetry, and no server operated by this plugin.

| Provider | Endpoint |
| --- | --- |
| Anthropic | `https://api.anthropic.com/v1/messages` |
| OpenAI | `https://api.openai.com/v1/responses` |
| Google | `https://generativelanguage.googleapis.com` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |

With OpenRouter, your request is then forwarded to whichever upstream vendor serves the model you picked, so their terms apply as well as OpenRouter's.

Requests happen when you send a message, when you press **Test connection**, and — if memory is enabled — once after each reply, to work out what to suggest remembering.

Each request includes your message, the conversation so far, your vault's folder names and file counts, your extra instructions, your instructions file if enabled, your kept memories, and the contents of any file the model opens. The memory request is narrower: it sends only the last exchange and the memories you have already kept, never the vault. If a vault holds material you don't want sent to a model provider, don't point the plugin at it, and check your provider's data retention policy first.

OpenAI requests are sent with `store: false`, so conversations are not retained on their side for later retrieval. The plugin is stateless with every provider: the full transcript is replayed from your vault on each turn, and no conversation is left parked on a server between messages.

Smart Connections runs locally, and is only asked for rankings in-process.

## Roadmap

- Local runtimes (Ollama, LM Studio) as a fifth backend.
- A free-text model field, so OpenRouter isn't limited to the models in the dropdown.
- Writing to the vault, behind a confirmation step.
- Sending the active note or selection as context.
- Per-prompt model choice.
- Audio and video via transcription.
- Token usage and cost per turn.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # typecheck + production build
```

Set `VAULT_PLUGIN_DIR` to build straight into a vault:

```bash
VAULT_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/yaaiop" npm run dev
```

To add a provider, implement `ChatProvider` in `src/providers/<name>.ts` and register it in `src/providers/index.ts`.

## License

MIT
