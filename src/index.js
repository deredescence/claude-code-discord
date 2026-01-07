/**
 * Claude Code Discord Bot
 * Entry point
 */

import 'dotenv/config';
import { DiscordBot } from './bot.js';

// Validate required environment variables
const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
    console.error('Missing required environment variables:');
    missing.forEach(key => console.error(`  - ${key}`));
    console.error('\nCopy .env.example to .env and fill in the values.');
    process.exit(1);
}

// Start the bot
const bot = new DiscordBot();

bot.start().catch(error => {
    console.error('Failed to start bot:', error);
    process.exit(1);
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    process.exit(0);
});
