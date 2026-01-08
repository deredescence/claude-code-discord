/**
 * Attachment utilities
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

// Temp directory for downloaded images
const TEMP_DIR = path.join(process.cwd(), '.temp_images');

// Map file extension to MIME type
const MIME_TYPES = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp'
};

/**
 * Download a file from URL to buffer
 */
export async function downloadToBuffer(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        const request = protocol.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                downloadToBuffer(response.headers.location).then(resolve).catch(reject);
                return;
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });

        request.on('error', reject);
    });
}

/**
 * Process a Discord attachment and return base64 data for Claude
 * @returns {Promise<{base64: string, mediaType: string, filename: string} | null>}
 */
export async function processAttachment(attachment) {
    const ext = (attachment.name?.split('.').pop() || 'png').toLowerCase();
    const mediaType = MIME_TYPES[ext];

    // Only process images
    if (!mediaType) {
        return null;
    }

    try {
        const buffer = await downloadToBuffer(attachment.url);
        const base64 = buffer.toString('base64');

        return {
            base64,
            mediaType,
            filename: attachment.name || `image.${ext}`
        };
    } catch (error) {
        console.error('Failed to download attachment:', error);
        return null;
    }
}

/**
 * Legacy: Download attachment to file path
 * @deprecated Use processAttachment for Claude Code integration
 */
export async function downloadAttachment(attachment) {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    const ext = attachment.name?.split('.').pop() || 'png';
    const filename = `${attachment.id}.${ext}`;
    const filepath = path.join(TEMP_DIR, filename);

    const buffer = await downloadToBuffer(attachment.url);
    fs.writeFileSync(filepath, buffer);
    return filepath;
}
