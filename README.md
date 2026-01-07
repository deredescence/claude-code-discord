# Claude Code Discord Bot

A Discord bot that wraps Claude Code CLI with **true interactive mode**. Persistent PTY sessions, real-time streaming, full feature parity. No terminal flickering, works great on mobile.

## Features

- **True Interactive Mode** - Persistent PTY sessions, not separate process spawns
- **Real-time Streaming** - See Claude's output as it types
- **Session Persistence** - Automatic `--resume` handling across messages
- **Multi-user Support** - Each user gets their own session per channel
- **Direct Message Mode** - Just type in the channel after starting a session
- **Full Command Support** - Run any Claude Code command (`/help`, `/plugin`, `/config`)
- **Stale Session Cleanup** - Auto-kills inactive sessions after 30 min

## Commands

| Command | Description |
|---------|-------------|
| `/claude <message>` | Send a message to Claude Code |
| `/claude-start [workdir] [resume]` | Start a new session |
| `/claude-stop` | Stop your current session |
| `/claude-status` | Check session status |
| `/claude-command <cmd>` | Run Claude Code commands (e.g., `/plugin`, `/help`) |
| `/claude-sessions` | List your recent sessions |

## How It Works

```
Discord User
     │
     ├── /claude "fix the bug"
     │         │
     ▼         ▼
┌─────────────────────────────────────┐
│          Discord Bot                │
│  ┌─────────────────────────────┐   │
│  │     PTY Session Manager     │   │
│  │  ┌───────────────────────┐  │   │
│  │  │   node-pty process    │  │   │
│  │  │   (persistent claude) │  │   │
│  │  └───────────────────────┘  │   │
│  └─────────────────────────────┘   │
│              │                      │
│    Real-time streaming              │
│              ▼                      │
│  ┌─────────────────────────────┐   │
│  │    Output Buffer/Throttle    │   │
│  │    (1 Discord edit/sec)     │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

**Key difference from v1:** Instead of spawning a new `claude -p` for each message, we maintain a persistent PTY session. This means:

- Claude remembers the full conversation naturally
- Thinking/processing shows in real-time
- Commands like `/plugin` actually work
- No process spawn overhead per message

## Setup

### 1. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create new application → Bot → Add Bot
3. Enable **Message Content Intent** (required!)
4. Copy the Bot Token

### 2. Invite Bot

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=277025770560&scope=bot%20applications.commands
```

### 3. Configure

```bash
git clone https://github.com/deredescence/claude-code-discord.git
cd claude-code-discord
cp .env.example .env
```

Edit `.env`:
```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_server_id  # Optional, faster command registration
CLAUDE_WORKDIR=/default/working/directory  # Optional
```

### 4. Run

```bash
npm install
npm start
```

## Usage

### Start a Session
```
/claude-start workdir:/path/to/project
```

### Chat with Claude
```
/claude fix the type error in utils.ts
```

Or just type directly in the channel:
```
Can you also add error handling?
```

### Run Claude Commands
```
/claude-command cmd:/plugin
/claude-command cmd:/help
/claude-command cmd:/config
```

### Resume a Previous Session
```
/claude-start resume:abc123...
```

## Requirements

- Node.js 18+
- Claude Code CLI installed and authenticated
- Discord Bot Token
- Windows: Build tools for node-pty (`npm install --global windows-build-tools`)

## Architecture

```
src/
├── index.js           # Entry point
├── bot.js             # Discord bot & command handlers
├── claude-manager.js  # PTY session management (node-pty)
└── utils/
    ├── session-store.js  # SQLite for session persistence
    └── formatter.js      # Terminal → Discord output formatting
```

### Key Components

**ClaudeSession (claude-manager.js)**
- Wraps `node-pty` for true interactive mode
- Handles input/output buffering
- Detects "ready for input" state
- Manages session lifecycle

**Session Store (session-store.js)**
- SQLite database for persistence
- Maps Discord channel+user → Claude session ID
- Enables `--resume` across bot restarts

**Formatter (formatter.js)**
- Strips ANSI escape codes
- Splits long outputs for Discord's 2000 char limit
- Detects thinking indicators

## Terminal vs Discord

| Feature | Terminal | Discord Bot |
|---------|----------|-------------|
| Flickering | Yes | No |
| Mobile friendly | No | Yes |
| Session resume | Manual | Automatic |
| Interactive mode | Yes | **Yes** (PTY) |
| Real-time output | Yes | **Yes** (streaming) |
| /plugin, /config | Yes | **Yes** |
| Multi-user | No | Yes |

## Limitations

- Output updates throttled to 1/sec (Discord rate limits)
- Very long outputs get truncated
- File uploads not yet supported (coming soon)

## Contributing

PRs welcome! Areas for improvement:

- [ ] File/image attachment support
- [ ] Thread-based conversations
- [ ] Better thinking indicator display
- [ ] Web dashboard for session viewing
- [ ] Multiple concurrent sessions per user

## License

MIT
