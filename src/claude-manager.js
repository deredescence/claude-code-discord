/**
 * Claude Code Process Manager (PTY Version)
 *
 * Uses node-pty for true interactive mode - persistent sessions,
 * real-time streaming, thinking display, the works.
 */

import pty from 'node-pty';
import { EventEmitter } from 'events';
import { cleanOutput, isWaitingForInput, isThinking } from './utils/formatter.js';

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const SHELL = process.platform === 'win32' ? 'powershell.exe' : 'bash';

/**
 * Interactive Claude Code session using PTY
 */
export class ClaudeSession extends EventEmitter {
    constructor(options = {}) {
        super();
        this.pty = null;
        this.sessionId = options.sessionId || null;
        this.workingDir = options.workingDir || process.cwd();
        this.isRunning = false;
        this.isReady = false;
        this.outputBuffer = '';
        this.pendingResolve = null;
        this.lastActivity = Date.now();

        // Output buffering for Discord
        this.discordBuffer = '';
        this.bufferTimeout = null;
        this.BUFFER_DELAY = 500; // ms to wait before sending to Discord
    }

    /**
     * Start interactive Claude Code session
     */
    start() {
        const args = ['--dangerously-skip-permissions'];

        // Resume if we have a session ID
        if (this.sessionId) {
            args.push('--resume', this.sessionId);
        }

        // Spawn PTY
        this.pty = pty.spawn(CLAUDE_PATH, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 40,
            cwd: this.workingDir,
            env: {
                ...process.env,
                FORCE_COLOR: '1',
                TERM: 'xterm-256color'
            }
        });

        this.isRunning = true;
        this.setupListeners();

        return this;
    }

    /**
     * Send input to Claude
     */
    write(input) {
        if (!this.pty || !this.isRunning) {
            throw new Error('Session not running');
        }

        this.lastActivity = Date.now();
        this.isReady = false;
        this.pty.write(input + '\r');
    }

    /**
     * Send a message and wait for response
     */
    async send(message) {
        return new Promise((resolve, reject) => {
            if (!this.isReady && this.isRunning) {
                // Wait for ready state
                const readyHandler = () => {
                    this.removeListener('ready', readyHandler);
                    this.doSend(message, resolve, reject);
                };
                this.once('ready', readyHandler);

                // Timeout after 30s
                setTimeout(() => {
                    this.removeListener('ready', readyHandler);
                    reject(new Error('Timeout waiting for Claude to be ready'));
                }, 30000);
            } else {
                this.doSend(message, resolve, reject);
            }
        });
    }

    doSend(message, resolve, reject) {
        this.outputBuffer = '';
        this.pendingResolve = resolve;

        // Set up response timeout
        const timeout = setTimeout(() => {
            this.pendingResolve = null;
            reject(new Error('Response timeout'));
        }, 300000); // 5 minute timeout

        // Listen for completion
        const completeHandler = () => {
            clearTimeout(timeout);
            this.pendingResolve = null;
            this.removeListener('ready', completeHandler);
            resolve(this.outputBuffer);
        };

        this.once('ready', completeHandler);
        this.write(message);
    }

    /**
     * Execute a slash command (like /plugin)
     */
    async command(cmd) {
        return this.send(cmd);
    }

    /**
     * Resize the PTY (if Discord somehow needs it)
     */
    resize(cols, rows) {
        if (this.pty) {
            this.pty.resize(cols, rows);
        }
    }

    /**
     * Kill the session
     */
    kill() {
        if (this.pty) {
            this.pty.kill();
            this.pty = null;
        }
        this.isRunning = false;
        this.isReady = false;
        this.emit('close', 0);
    }

    /**
     * Graceful exit - send /exit command first
     */
    async exit() {
        try {
            this.write('/exit\r');
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (e) {
            // Ignore
        }
        this.kill();
    }

    setupListeners() {
        this.pty.onData((data) => {
            this.lastActivity = Date.now();
            const cleaned = cleanOutput(data);

            // Accumulate output
            this.outputBuffer += cleaned;

            // Buffer for Discord (don't spam)
            this.discordBuffer += cleaned;
            this.scheduleDiscordEmit();

            // Emit raw for debugging
            this.emit('data', data);

            // Check for session ID in output
            const sessionMatch = data.match(/Session:\s*([a-f0-9-]+)/i) ||
                                 data.match(/session[:\s]+([a-f0-9-]+)/i);
            if (sessionMatch && !this.sessionId) {
                this.sessionId = sessionMatch[1];
                this.emit('session', this.sessionId);
            }

            // Check if Claude is thinking
            if (isThinking(cleaned)) {
                this.emit('thinking', cleaned);
            }

            // Check if ready for input
            if (isWaitingForInput(data)) {
                this.isReady = true;
                this.emit('ready');

                // Flush any remaining buffer
                if (this.discordBuffer.trim()) {
                    this.emit('output', this.discordBuffer);
                    this.discordBuffer = '';
                }
            }
        });

        this.pty.onExit(({ exitCode }) => {
            this.isRunning = false;
            this.isReady = false;
            this.emit('close', exitCode);
        });
    }

    scheduleDiscordEmit() {
        // Debounce Discord output
        if (this.bufferTimeout) {
            clearTimeout(this.bufferTimeout);
        }

        this.bufferTimeout = setTimeout(() => {
            if (this.discordBuffer.trim()) {
                this.emit('output', this.discordBuffer);
                this.discordBuffer = '';
            }
        }, this.BUFFER_DELAY);
    }
}

// Active sessions: channelId_userId -> ClaudeSession
const activeSessions = new Map();

/**
 * Get or create a session for a channel/user
 */
export function getOrCreateSession(channelId, userId, options = {}) {
    const key = `${channelId}_${userId}`;

    let session = activeSessions.get(key);

    if (!session || !session.isRunning) {
        session = new ClaudeSession({
            sessionId: options.sessionId,
            workingDir: options.workingDir
        });
        session.start();
        activeSessions.set(key, session);
    }

    return session;
}

/**
 * Get existing session (don't create)
 */
export function getSession(channelId, userId) {
    return activeSessions.get(`${channelId}_${userId}`);
}

/**
 * Kill and remove a session
 */
export function killSession(channelId, userId) {
    const key = `${channelId}_${userId}`;
    const session = activeSessions.get(key);

    if (session) {
        session.kill();
        activeSessions.delete(key);
        return true;
    }
    return false;
}

/**
 * Get all active sessions
 */
export function getAllSessions() {
    return activeSessions;
}

/**
 * Clean up stale sessions (no activity for > 30 min)
 */
export function cleanupStaleSessions() {
    const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    for (const [key, session] of activeSessions) {
        if (now - session.lastActivity > STALE_THRESHOLD) {
            session.kill();
            activeSessions.delete(key);
        }
    }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleSessions, 5 * 60 * 1000);
