# Claude Code Discord Bot

A Discord bot that wraps Claude Code CLI with full feature parity. Chat with Claude Code through Discord - no terminal flickering, works great on mobile.

## Features

- **Full Claude Code CLI integration** - Not just a workflow trigger, actual Claude Code
- **Session persistence** - Resume conversations with `--resume` automatically handled
- **Multi-user support** - Each user gets their own session per channel
- **File attachments** - Upload files for Claude to analyze
- **Streaming output** - See Claude's responses as they come in
- **Slash commands** - Clean Discord-native interface

## Commands

| Command | Description |
|---------|-------------|
| `/claude <prompt>` | Send a message to Claude Code |
| `/claude-new` | Start a fresh session (clears context) |
| `/claude-resume [session_id]` | Resume a previous session |
| `/claude-stop` | Stop the current Claude process |
| `/claude-sessions` | List your recent sessions |
| `/claude-status` | Check current session status |

## Setup

### 1. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and name it
3. Go to "Bot" tab, click "Add Bot"
4. Enable these Privileged Gateway Intents:
   - Message Content Intent
5. Copy the Bot Token

### 2. Get Client ID

1. In Developer Portal, go to "OAuth2" tab
2. Copy the "Client ID"

### 3. Invite Bot to Server

Generate invite URL with these permissions:
- Send Messages
- Use Slash Commands
- Embed Links
- Attach Files
- Read Message History

Or use this template:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=277025770560&scope=bot%20applications.commands
```

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_GUILD_ID=your_server_id  # Optional, for faster command registration
CLAUDE_WORKDIR=/path/to/default/workdir  # Optional
```

### 5. Install & Run

```bash
npm install
npm start
```

## How It Works

```
Discord User
     │
     ▼
┌─────────────────┐
│  Discord Bot    │
│  (discord.js)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Claude Manager  │──▶ Spawns claude CLI processes
│                 │──▶ Handles stdin/stdout
└────────┬────────┘──▶ Manages sessions
         │
         ▼
┌─────────────────┐
│ Session Store   │──▶ SQLite database
│                 │──▶ Maps channel+user → session
└─────────────────┘──▶ Stores resume IDs
```

When you send `/claude hello`:

1. Bot receives slash command
2. Looks up your active session (if any)
3. Spawns `claude -p "hello" --resume <session_id>`
4. Streams output back to Discord
5. Saves session ID for next message

## Architecture

```
claude-code-discord/
├── src/
│   ├── index.js           # Entry point
│   ├── bot.js             # Discord bot & slash commands
│   ├── claude-manager.js  # Claude CLI process management
│   └── utils/
│       ├── session-store.js  # SQLite persistence
│       └── formatter.js      # Terminal → Discord formatting
├── .env.example
├── package.json
└── README.md
```

## Requirements

- Node.js 18+
- Claude Code CLI installed and authenticated
- Discord Bot Token

## Differences from Terminal

| Feature | Terminal | Discord Bot |
|---------|----------|-------------|
| Flickering | Yes | No |
| Mobile friendly | No | Yes |
| Session resume | Manual `--resume` | Automatic |
| File viewing | Inline | Attachment links |
| Multi-user | No | Yes |
| Interactive mode | Yes | Coming soon |

## Limitations

- No true interactive mode (yet) - each message is a separate `claude -p` call
- No `/plugin` management through Discord (use terminal for that)
- No real-time thinking display (streams final output only)

## Contributing

PRs welcome! Key areas for improvement:

- [ ] True interactive mode (persistent process with PTY)
- [ ] Plugin management commands
- [ ] Thread-based conversations
- [ ] Web dashboard for session viewing
- [ ] Multiple working directory support

## License

MIT
