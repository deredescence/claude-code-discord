/**
 * Claude Code Discord Bot
 * Entry point
 */

import 'dotenv/config';
import { DiscordBot } from './bot.js';
import { getAllSessions } from './claude-manager.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCK_FILE = join(__dirname, '..', '.bot.lock');

/**
 * Singleton enforcement - kill any older instance before starting
 */
function enforceSingleton() {
    const myPid = process.pid;
    const myStartTime = Date.now();

    // Check if lock file exists
    if (existsSync(LOCK_FILE)) {
        try {
            const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
            const oldPid = lockData.pid;

            // Check if old process is still running
            if (oldPid && oldPid !== myPid) {
                try {
                    // On Windows, check if process exists
                    if (process.platform === 'win32') {
                        try {
                            execSync(`tasklist /FI "PID eq ${oldPid}" | findstr ${oldPid}`, { stdio: 'pipe' });
                            // Process exists, kill it
                            console.log(`Killing older bot instance (PID: ${oldPid})...`);
                            execSync(`taskkill /PID ${oldPid} /F /T`, { stdio: 'pipe' });
                            console.log(`Killed old instance.`);
                        } catch (e) {
                            // Process doesn't exist, that's fine
                        }
                    } else {
                        // Unix - check if process exists with kill -0
                        try {
                            process.kill(oldPid, 0);
                            // Process exists, kill it
                            console.log(`Killing older bot instance (PID: ${oldPid})...`);
                            process.kill(oldPid, 'SIGTERM');
                            console.log(`Killed old instance.`);
                        } catch (e) {
                            // Process doesn't exist
                        }
                    }
                } catch (killError) {
                    console.warn(`Could not kill old process ${oldPid}:`, killError.message);
                }
            }
        } catch (parseError) {
            console.warn('Could not read lock file, ignoring:', parseError.message);
        }
    }

    // Write our own lock file
    const lockData = {
        pid: myPid,
        startTime: myStartTime,
        startedAt: new Date().toISOString()
    };
    writeFileSync(LOCK_FILE, JSON.stringify(lockData, null, 2));
    console.log(`Bot instance started (PID: ${myPid})`);
}

/**
 * Remove lock file on exit
 */
function removeLockFile() {
    try {
        if (existsSync(LOCK_FILE)) {
            const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
            // Only remove if it's our lock file
            if (lockData.pid === process.pid) {
                unlinkSync(LOCK_FILE);
                console.log('Lock file removed.');
            }
        }
    } catch (e) {
        // Ignore errors during cleanup
    }
}

// Enforce singleton BEFORE anything else
enforceSingleton();

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

/**
 * Kill all active Claude processes
 */
function cleanupAllProcesses() {
    const sessions = getAllSessions();
    let killed = 0;
    for (const [key, session] of sessions) {
        try {
            session.kill();
            killed++;
        } catch (e) {
            console.error(`Failed to kill session for ${key}:`, e);
        }
    }
    if (killed > 0) {
        console.log(`Cleaned up ${killed} Claude session(s)`);
    }
}

/**
 * Full cleanup: kill Claude sessions and remove lock file
 */
function fullCleanup() {
    cleanupAllProcesses();
    removeLockFile();
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    fullCleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    fullCleanup();
    process.exit(0);
});

// Handle uncaught exceptions - cleanup before crashing
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    fullCleanup();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    // Don't exit, just log - but cleanup if it's severe
});

// Cleanup on Windows close (Ctrl+C in terminal)
if (process.platform === 'win32') {
    process.on('SIGHUP', () => {
        fullCleanup();
        process.exit(0);
    });
}

// Also handle 'exit' event as a last resort
process.on('exit', () => {
    removeLockFile();
});
