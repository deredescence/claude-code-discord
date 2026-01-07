/**
 * Session Store
 * Persists Claude Code session IDs for --resume functionality
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'sessions.db');

let db = null;

export function initDatabase() {
    db = new Database(DB_PATH);

    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_channel_id TEXT NOT NULL,
            discord_user_id TEXT NOT NULL,
            claude_session_id TEXT,
            working_directory TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_active INTEGER DEFAULT 1
        );

        CREATE INDEX IF NOT EXISTS idx_channel_user
        ON sessions(discord_channel_id, discord_user_id);

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
    `);

    return db;
}

export function getActiveSession(channelId, userId) {
    const stmt = db.prepare(`
        SELECT * FROM sessions
        WHERE discord_channel_id = ?
        AND discord_user_id = ?
        AND is_active = 1
        ORDER BY updated_at DESC
        LIMIT 1
    `);
    return stmt.get(channelId, userId);
}

export function createSession(channelId, userId, workingDir = null) {
    const stmt = db.prepare(`
        INSERT INTO sessions (discord_channel_id, discord_user_id, working_directory)
        VALUES (?, ?, ?)
    `);
    const result = stmt.run(channelId, userId, workingDir);
    return result.lastInsertRowid;
}

export function updateSessionClaudeId(sessionId, claudeSessionId) {
    const stmt = db.prepare(`
        UPDATE sessions
        SET claude_session_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);
    stmt.run(claudeSessionId, sessionId);
}

export function updateSessionTimestamp(sessionId) {
    const stmt = db.prepare(`
        UPDATE sessions
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);
    stmt.run(sessionId);
}

export function deactivateSession(sessionId) {
    const stmt = db.prepare(`
        UPDATE sessions
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);
    stmt.run(sessionId);
}

export function getAllUserSessions(userId) {
    const stmt = db.prepare(`
        SELECT * FROM sessions
        WHERE discord_user_id = ?
        ORDER BY updated_at DESC
        LIMIT 20
    `);
    return stmt.all(userId);
}

export function addMessage(sessionId, role, content) {
    const stmt = db.prepare(`
        INSERT INTO messages (session_id, role, content)
        VALUES (?, ?, ?)
    `);
    stmt.run(sessionId, role, content);
}

export function getSessionMessages(sessionId, limit = 50) {
    const stmt = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `);
    return stmt.all(sessionId, limit).reverse();
}
