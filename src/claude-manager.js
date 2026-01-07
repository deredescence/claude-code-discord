/**
 * Claude Code Process Manager
 * Spawns and manages Claude Code CLI processes
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { cleanOutput, extractSessionId, isWaitingForInput } from './utils/formatter.js';

const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const DEFAULT_TIMEOUT = 300000; // 5 minutes

export class ClaudeProcess extends EventEmitter {
    constructor(options = {}) {
        super();
        this.process = null;
        this.sessionId = options.sessionId || null;
        this.workingDir = options.workingDir || process.cwd();
        this.isRunning = false;
        this.outputBuffer = '';
        this.timeout = options.timeout || DEFAULT_TIMEOUT;
        this.timeoutHandle = null;
    }

    /**
     * Start a new Claude Code session
     */
    start(initialPrompt = null, options = {}) {
        const args = ['--dangerously-skip-permissions'];

        // Add resume flag if we have a session ID
        if (this.sessionId) {
            args.push('--resume', this.sessionId);
        }

        // Add print mode for non-interactive use
        if (initialPrompt) {
            args.push('-p', initialPrompt);
        }

        // Add output format
        args.push('--output-format', 'text');

        this.process = spawn(CLAUDE_PATH, args, {
            cwd: this.workingDir,
            env: {
                ...process.env,
                FORCE_COLOR: '0', // Disable colors for cleaner output
                NO_COLOR: '1'
            },
            shell: true
        });

        this.isRunning = true;
        this.setupListeners();
        this.resetTimeout();

        return this;
    }

    /**
     * Send a message to the running Claude process
     */
    send(message) {
        if (!this.process || !this.isRunning) {
            throw new Error('Claude process is not running');
        }

        this.resetTimeout();
        this.process.stdin.write(message + '\n');
    }

    /**
     * Execute a single prompt and get response
     */
    async execute(prompt, options = {}) {
        return new Promise((resolve, reject) => {
            const args = ['-p', prompt, '--output-format', 'text'];

            if (this.sessionId) {
                args.push('--resume', this.sessionId);
            }

            if (options.continueSession) {
                args.push('--continue');
            }

            const proc = spawn(CLAUDE_PATH, args, {
                cwd: this.workingDir,
                env: {
                    ...process.env,
                    FORCE_COLOR: '0',
                    NO_COLOR: '1'
                },
                shell: true
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdout += chunk;
                this.emit('output', cleanOutput(chunk));
            });

            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                // Try to extract session ID from output
                const newSessionId = extractSessionId(stdout) || extractSessionId(stderr);
                if (newSessionId) {
                    this.sessionId = newSessionId;
                    this.emit('session', newSessionId);
                }

                if (code === 0) {
                    resolve({
                        output: cleanOutput(stdout),
                        sessionId: this.sessionId
                    });
                } else {
                    reject(new Error(`Claude exited with code ${code}: ${stderr}`));
                }
            });

            proc.on('error', (error) => {
                reject(error);
            });

            // Set timeout
            setTimeout(() => {
                if (!proc.killed) {
                    proc.kill();
                    reject(new Error('Claude process timed out'));
                }
            }, this.timeout);
        });
    }

    /**
     * Execute with streaming output
     */
    async *executeStream(prompt, options = {}) {
        const args = ['-p', prompt, '--output-format', 'stream-json'];

        if (this.sessionId) {
            args.push('--resume', this.sessionId);
        }

        if (options.continueSession) {
            args.push('--continue');
        }

        const proc = spawn(CLAUDE_PATH, args, {
            cwd: this.workingDir,
            env: {
                ...process.env,
                FORCE_COLOR: '0',
                NO_COLOR: '1'
            },
            shell: true
        });

        this.process = proc;
        this.isRunning = true;

        const chunks = [];

        proc.stdout.on('data', (data) => {
            chunks.push(data.toString());
        });

        proc.stderr.on('data', (data) => {
            this.emit('error', data.toString());
        });

        // Yield chunks as they come in
        while (this.isRunning || chunks.length > 0) {
            if (chunks.length > 0) {
                const chunk = chunks.shift();
                yield cleanOutput(chunk);
            } else {
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            // Check if process has ended
            if (proc.exitCode !== null) {
                this.isRunning = false;
            }
        }
    }

    /**
     * Kill the Claude process
     */
    kill() {
        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
        }
        this.isRunning = false;
        this.clearTimeout();
    }

    setupListeners() {
        this.process.stdout.on('data', (data) => {
            const output = data.toString();
            this.outputBuffer += output;

            const cleaned = cleanOutput(output);
            if (cleaned) {
                this.emit('output', cleaned);
            }

            // Check for session ID in output
            const sessionId = extractSessionId(output);
            if (sessionId && !this.sessionId) {
                this.sessionId = sessionId;
                this.emit('session', sessionId);
            }

            // Check if waiting for input
            if (isWaitingForInput(output)) {
                this.emit('ready');
            }
        });

        this.process.stderr.on('data', (data) => {
            const error = data.toString();
            this.emit('error', cleanOutput(error));
        });

        this.process.on('close', (code) => {
            this.isRunning = false;
            this.clearTimeout();
            this.emit('close', code);
        });

        this.process.on('error', (error) => {
            this.isRunning = false;
            this.clearTimeout();
            this.emit('error', error.message);
        });
    }

    resetTimeout() {
        this.clearTimeout();
        this.timeoutHandle = setTimeout(() => {
            this.emit('timeout');
            this.kill();
        }, this.timeout);
    }

    clearTimeout() {
        if (this.timeoutHandle) {
            clearTimeout(this.timeoutHandle);
            this.timeoutHandle = null;
        }
    }
}

// Active processes map: channelId_userId -> ClaudeProcess
const activeProcesses = new Map();

export function getProcess(channelId, userId) {
    return activeProcesses.get(`${channelId}_${userId}`);
}

export function setProcess(channelId, userId, process) {
    activeProcesses.set(`${channelId}_${userId}`, process);
}

export function removeProcess(channelId, userId) {
    const key = `${channelId}_${userId}`;
    const proc = activeProcesses.get(key);
    if (proc) {
        proc.kill();
        activeProcesses.delete(key);
    }
}

export function getAllProcesses() {
    return activeProcesses;
}
