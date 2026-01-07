/**
 * Output Formatter
 * Converts Claude Code terminal output to Discord-friendly markdown
 */

import stripAnsi from 'strip-ansi';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_EMBED_LENGTH = 4096;
const CODE_BLOCK_OVERHEAD = 8; // ```\n...\n```

/**
 * Strip ANSI codes and clean terminal output
 */
export function cleanOutput(text) {
    if (!text) return '';

    // Strip ANSI escape codes
    let cleaned = stripAnsi(text);

    // Remove carriage returns and normalize line endings
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Remove excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/**
 * Split long content into Discord-safe chunks
 */
export function splitMessage(content, maxLength = MAX_MESSAGE_LENGTH) {
    if (content.length <= maxLength) {
        return [content];
    }

    const chunks = [];
    let remaining = content;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Try to split at newline
        let splitIndex = remaining.lastIndexOf('\n', maxLength);

        // If no newline, split at space
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }

        // If still no good split point, force split
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
}

/**
 * Format tool output (file reads, bash commands, etc.)
 */
export function formatToolOutput(toolName, output) {
    const cleaned = cleanOutput(output);
    const maxContent = MAX_MESSAGE_LENGTH - CODE_BLOCK_OVERHEAD - toolName.length - 10;

    if (cleaned.length > maxContent) {
        const truncated = cleaned.substring(0, maxContent - 20) + '\n... (truncated)';
        return `**${toolName}**\n\`\`\`\n${truncated}\n\`\`\``;
    }

    return `**${toolName}**\n\`\`\`\n${cleaned}\n\`\`\``;
}

/**
 * Format Claude's text response
 */
export function formatResponse(text) {
    const cleaned = cleanOutput(text);
    return splitMessage(cleaned);
}

/**
 * Format progress/status updates
 */
export function formatStatus(status, emoji = '⏳') {
    return `${emoji} ${status}`;
}

/**
 * Format error messages
 */
export function formatError(error) {
    const cleaned = cleanOutput(error.toString());
    return `❌ **Error**\n\`\`\`\n${cleaned}\n\`\`\``;
}

/**
 * Parse Claude Code output to extract session ID
 */
export function extractSessionId(output) {
    // Claude Code outputs session ID in various formats
    const patterns = [
        /session[:\s]+([a-f0-9-]+)/i,
        /resuming[:\s]+([a-f0-9-]+)/i,
        /--resume[=\s]+([a-f0-9-]+)/i
    ];

    for (const pattern of patterns) {
        const match = output.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

/**
 * Detect if output indicates Claude is waiting for input
 */
export function isWaitingForInput(output) {
    const indicators = [
        '> ', // Standard prompt
        '? ', // Question prompt
        'Enter your message',
        'Type your response',
        'waiting for input'
    ];

    const cleaned = cleanOutput(output);
    const lastLine = cleaned.split('\n').pop()?.trim() || '';

    return indicators.some(ind => lastLine.includes(ind) || lastLine.endsWith(ind));
}

/**
 * Detect thinking/processing indicators
 */
export function isThinking(output) {
    const indicators = [
        'Thinking...',
        'Processing...',
        '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', // Spinner chars
        '...'
    ];

    const cleaned = cleanOutput(output);
    return indicators.some(ind => cleaned.includes(ind));
}
