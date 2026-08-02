# YAAIOP

Yet Another AI Obsidian Plugin. Chat with an AI model about your notes, on desktop and on your phone.

The plugin is read-only. It can search and read your vault, but it never creates, edits, or deletes files.

## Why it exists

There are already several AI plugins for Obsidian. This one was built around three constraints:

- **It has to work on a phone.** The plugin only makes HTTPS calls to a provider API. There is no MCP server to launch, no terminal, no local runtime, and no companion app, so a phone behaves the same as a laptop.
- **It should reuse Smart Connections, not compete with it.** If you already have that plugin, your vault is already embedded. YAAIOP asks it for search rankings, and falls back to keyword search when it isn't installed.
- **A vault is more than markdown.** Images and PDFs are searchable, and the model can open them.

## Features

- Chat panel in the sidebar on desktop, full screen on mobile.
- The model searches your vault and opens notes on its own, then answers with `[[wikilinks]]` you can tap.
- Reads images and PDFs, and finds them through the text of the notes that embed them.
- Saved prompts for conversations you start often.
- Chat history, so you can reopen past conversations. Can be turned off.
- Picks up a `CLAUDE.md` from your vault if you have one.
- Model picker with a reasoning effort dial.

## Installation

Not yet in the community plugin list. Until then:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/nicolasassi/yaaiop/releases).
2. Put them in `<vault>/.obsidian/plugins/yaaiop/`.
3. Enable **YAAIOP** in Settings → Community plugins.
4. Open Settings → YAAIOP and paste your API key. **Test connection** checks it.

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

### Settings worth knowing

- **Model** and **Reasoning effort** control cost and answer quality.
- **Search results per query** and **Max characters per note** cap how much of your vault goes into a request.
- **Max image edge** trades image detail against cost.
- **Extra instructions** is appended to the system prompt. Use it for folder conventions the model can't guess.
- **Use CLAUDE.md** reads a `CLAUDE.md` from your vault. If yours was written for a coding agent, the model is told to follow the conventions in it and ignore instructions about tools this plugin doesn't have.

## API keys

Your key is stored in Obsidian's per-device local storage, not in the plugin's `data.json`.

`data.json` lives inside the vault, so Obsidian Sync would copy your key to a server, and git-based sync would commit it, where it survives in history after you delete the file. A leaked key is billable to you until you notice.

The cost of keeping it out of the vault is that **you enter the key once per device**. Every other setting still syncs normally.

Local storage is not encrypted. Anything with access to your Obsidian profile can read it, so use a key scoped to this plugin and set a spend limit with your provider.

## Network use

The plugin sends requests to the API of the provider you configure, and to nothing else. With the default Anthropic provider that is `https://api.anthropic.com/v1/messages`. There is no analytics, no telemetry, and no server operated by this plugin.

Requests happen when you send a message, and when you press **Test connection**.

Each request includes your message, the conversation so far, your vault's folder names and file counts, your extra instructions, your `CLAUDE.md` if enabled, and the contents of any file the model opens. If a vault holds material you don't want sent to a model provider, don't point the plugin at it, and check your provider's data retention policy first.

Smart Connections runs locally, and is only asked for rankings in-process.

## Roadmap

- More providers (OpenAI, Google, OpenRouter, and local runtimes like Ollama). The core is provider-neutral, so each backend is one adapter file.
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
