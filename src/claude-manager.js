/**
 * Claude Code Process Manager (JSON Streaming version)
 *
 * Uses child_process spawn with --input-format stream-json --output-format stream-json
 * for true bidirectional streaming with Claude Code.
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// On Windows, use claude.cmd explicitly
const isWindows = process.platform === 'win32';
const CLAUDE_PATH = process.env.CLAUDE_PATH || (isWindows ? 'claude.cmd' : 'claude');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || null;

/**
 * Interactive Claude Code session with JSON streaming
 */
export class ClaudeSession extends EventEmitter {
    constructor(options = {}) {
        super();
        this.sessionId = options.sessionId || null;
        this.workingDir = options.workingDir || process.cwd();
        this.timeout = options.timeout || 300000; // 5 min per message
        this.process = null;
        this.isProcessing = false;
        this.pendingResolve = null;
        this.pendingReject = null;
        this.currentOutput = '';
        this.timeoutId = null;
    }

    /**
     * Send a message to Claude and stream the response
     * @param {string | Array} message - Text string or content array with text/image blocks
     */
    async send(message) {
        if (this.isProcessing) {
            throw new Error('Already processing a message. Please wait.');
        }

        return new Promise((resolve, reject) => {
            this.isProcessing = true;
            this.pendingResolve = resolve;
            this.pendingReject = reject;
            this.currentOutput = '';

            const args = [
                '-p',
                '--input-format', 'stream-json',
                '--output-format', 'stream-json'
            ];

            // Add model if specified
            if (CLAUDE_MODEL) {
                args.push('--model', CLAUDE_MODEL);
            }

            // Resume session if we have one
            if (this.sessionId) {
                args.push('--resume', this.sessionId);
            }

            // Spawn Claude
            this.process = spawn(CLAUDE_PATH, args, {
                cwd: this.workingDir,
                shell: isWindows,
                windowsHide: true,
                env: {
                    ...process.env,
                    FORCE_COLOR: '0',
                    NO_COLOR: '1'
                }
            });

            let buffer = '';

            this.process.stdout.on('data', (data) => {
                buffer += data.toString();

                // Process complete JSON lines
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.trim()) {
                        this.handleJsonLine(line.trim());
                    }
                }
            });

            this.process.stderr.on('data', (data) => {
                const text = data.toString();
                this.emit('stderr', text);
            });

            this.process.on('close', (code) => {
                this.isProcessing = false;
                this.process = null;
                clearTimeout(this.timeoutId);

                if (this.pendingResolve) {
                    this.pendingResolve({
                        output: this.currentOutput,
                        sessionId: this.sessionId
                    });
                    this.pendingResolve = null;
                    this.pendingReject = null;
                }
            });

            this.process.on('error', (err) => {
                this.isProcessing = false;
                this.process = null;
                clearTimeout(this.timeoutId);

                if (this.pendingReject) {
                    this.pendingReject(err);
                    this.pendingResolve = null;
                    this.pendingReject = null;
                }
            });

            // Timeout
            this.timeoutId = setTimeout(() => {
                if (this.process) {
                    this.process.kill('SIGTERM');
                    if (this.pendingReject) {
                        this.pendingReject(new Error('Response timeout'));
                        this.pendingResolve = null;
                        this.pendingReject = null;
                    }
                }
            }, this.timeout);

            // Send the user message - handle both string and content array
            const content = typeof message === 'string' ? message : message;
            const inputMessage = JSON.stringify({
                type: 'user',
                message: {
                    role: 'user',
                    content: content
                }
            });

            this.process.stdin.write(inputMessage + '\n');
            this.process.stdin.end();
        });
    }

    /**
     * Handle a JSON line from Claude's output
     */
    handleJsonLine(line) {
        try {
            const data = JSON.parse(line);

            switch (data.type) {
                case 'system':
                    if (data.subtype === 'init') {
                        // Session started
                        if (data.session_id && !this.sessionId) {
                            this.sessionId = data.session_id;
                            this.emit('session', this.sessionId);
                        }
                        this.emit('init', data);
                    }
                    break;

                case 'assistant':
                    // Extract text content from message
                    if (data.message && data.message.content) {
                        for (const block of data.message.content) {
                            if (block.type === 'text') {
                                this.currentOutput += block.text;
                                this.emit('text', block.text);
                            } else if (block.type === 'thinking') {
                                // Extended thinking content
                                this.emit('thinking', block.thinking);
                            } else if (block.type === 'tool_use') {
                                // Emit detailed tool status
                                const toolName = block.name || 'Tool';
                                const toolInput = block.input || {};

                                // Generate human-readable status
                                let status = toolName;
                                if (toolName === 'Read' && toolInput.file_path) {
                                    status = `Reading ${this.shortenPath(toolInput.file_path)}`;
                                } else if (toolName === 'Write' && toolInput.file_path) {
                                    status = `Writing ${this.shortenPath(toolInput.file_path)}`;
                                } else if (toolName === 'Edit' && toolInput.file_path) {
                                    status = `Editing ${this.shortenPath(toolInput.file_path)}`;
                                } else if (toolName === 'Bash' && toolInput.command) {
                                    const cmd = toolInput.command.substring(0, 30);
                                    status = `Running: ${cmd}${toolInput.command.length > 30 ? '...' : ''}`;
                                } else if (toolName === 'Grep' || toolName === 'Glob') {
                                    status = `Searching...`;
                                } else if (toolName === 'WebFetch') {
                                    status = `Fetching web content`;
                                } else if (toolName === 'Task') {
                                    status = `Spawning agent...`;
                                }

                                this.emit('tool_use', { name: toolName, input: toolInput, status });
                                this.emit('status', status);
                            }
                        }
                    }
                    // Capture session ID
                    if (data.session_id && !this.sessionId) {
                        this.sessionId = data.session_id;
                        this.emit('session', this.sessionId);
                    }
                    break;

                case 'content_block_start':
                    // Tool is starting
                    if (data.content_block && data.content_block.type === 'tool_use') {
                        const toolName = data.content_block.name;
                        this.emit('status', `Using ${toolName}...`);
                    } else if (data.content_block && data.content_block.type === 'thinking') {
                        this.emit('status', 'Thinking...');
                    }
                    break;

                case 'content_block_delta':
                    // Streaming content
                    if (data.delta) {
                        if (data.delta.type === 'thinking_delta' && data.delta.thinking) {
                            this.emit('thinking', data.delta.thinking);
                        } else if (data.delta.type === 'text_delta' && data.delta.text) {
                            this.currentOutput += data.delta.text;
                            this.emit('text', data.delta.text);
                        }
                    }
                    break;

                case 'result':
                    // Final result
                    if (data.result) {
                        this.currentOutput = data.result; // Use final result
                    }
                    if (data.session_id) {
                        this.sessionId = data.session_id;
                    }
                    this.emit('result', data);
                    break;

                default:
                    this.emit('event', data);
            }
        } catch (e) {
            this.emit('parse_error', { line, error: e.message });
        }
    }

    /**
     * Shorten a file path for display
     */
    shortenPath(path) {
        if (!path) return '';
        const parts = path.replace(/\\/g, '/').split('/');
        if (parts.length > 2) {
            return '.../' + parts.slice(-2).join('/');
        }
        return path;
    }

    /**
     * Kill the current process
     */
    kill() {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        this.isProcessing = false;
        clearTimeout(this.timeoutId);
    }
}

// Active sessions: key -> ClaudeSession
const sessions = new Map();

/**
 * Get or create session for channel/user
 */
export function getOrCreateSession(channelId, userId, options = {}) {
    const key = `${channelId}_${userId}`;

    let session = sessions.get(key);

    if (!session) {
        session = new ClaudeSession({
            sessionId: options.sessionId,
            workingDir: options.workingDir
        });
        sessions.set(key, session);
    } else {
        // Update session ID if provided
        if (options.sessionId) {
            session.sessionId = options.sessionId;
        }
        if (options.workingDir) {
            session.workingDir = options.workingDir;
        }
    }

    return session;
}

/**
 * Get existing session
 */
export function getSession(channelId, userId) {
    return sessions.get(`${channelId}_${userId}`);
}

/**
 * Remove session
 */
export function removeSession(channelId, userId) {
    const key = `${channelId}_${userId}`;
    const session = sessions.get(key);

    if (session) {
        session.kill();
    }

    sessions.delete(key);
    return !!session;
}

/**
 * Get all sessions
 */
export function getAllSessions() {
    return sessions;
}
