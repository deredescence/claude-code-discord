# Project Rules

## DO NOT
- Run the Discord bot in background mode (`run_in_background: true`)
- Spawn background processes without immediately killing them when done
- Leave orphaned node processes running

## Testing the bot
- Tell the user to run `npm start` themselves
- Or run with a short foreground timeout and let it fail naturally
- NEVER spawn long-running background tasks

## Architecture
- Discord bot is a 2-way relay to Claude Code
- Uses `claude -p --input-format stream-json --output-format stream-json` for streaming
- Session continuity via `--resume <session_id>`
