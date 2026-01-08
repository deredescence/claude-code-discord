/**
 * Output Formatter
 * Converts Claude Code terminal output to Discord-friendly markdown
 */

import stripAnsi from 'strip-ansi';

const MAX_MESSAGE_LENGTH = 2000;
const CODE_BLOCK_OVERHEAD = 8; // ```\n...\n```

/**
 * Strip ANSI codes, internal markers, and clean terminal output
 */
export function cleanOutput(text) {
    if (!text) return '';

    // Strip ANSI escape codes
    let cleaned = stripAnsi(text);

    // Remove carriage returns and normalize line endings
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Remove <thinking>...</thinking> blocks (including multiline)
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

    // Remove orphaned <thinking> or </thinking> tags
    cleaned = cleaned.replace(/<\/?thinking>/gi, '');

    // Remove <...> tags (internal Anthropic markers)
    cleaned = cleaned.replace(/<\/?antml:[^>]*>/gi, '');

    // Remove system-reminder blocks
    cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');

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
 * Format structured stream blocks for display
 * @param {Array<{type: string, content: string}>} blocks
 * @param {string} mode 'raw' or 'clean'
 */
export function formatStructuredOutput(blocks, mode = 'raw') {
    if (mode === 'clean') {
        // Only return text content
        return blocks
            .filter(b => b.type === 'text')
            .map(b => cleanOutput(b.content))
            .join('') || '*(Processing...)*';
    }

    // Raw mode: Show everything with Discord subheaders (-#)
    let output = '';
    let lastType = null;

    for (const block of blocks) {
        const cleaned = cleanOutput(block.content);
        if (!cleaned) continue;

        switch (block.type) {
            case 'thinking':
                // Small text for thinking - each on its own line
                if (lastType && lastType !== 'thinking') output += '\n';
                output += `-# 💭 ${cleaned.substring(0, 150)}${cleaned.length > 150 ? '...' : ''}\n`;
                break;

            case 'tool':
                // Small text for tool use - each on its own line
                if (lastType && lastType !== 'tool') output += '\n';
                output += `-# ⚙️ ${cleaned}\n`;
                break;

            case 'text':
            default:
                // Normal text - add spacing if coming from status lines
                if (lastType === 'thinking' || lastType === 'tool') output += '\n';
                output += cleaned;
                break;
        }
        lastType = block.type;
    }

    return output || '*(Processing...)*';
}

/**
 * Format response with spoilers for code blocks
 */
export function formatResponseSmart(text) {
    let cleaned = cleanOutput(text);
    // Wrap code blocks in spoilers
    cleaned = cleaned.replace(/(```[\s\S]*?```)/g, '||$1||');
    return splitMessage(cleaned);
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
