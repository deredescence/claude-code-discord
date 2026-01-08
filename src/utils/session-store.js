/**
 * Session Store (sql.js version - no native dependencies)
 * Persists Claude Code session IDs for --resume functionality
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'sessions.db');

let db = null;

export async function initDatabase() {
    const SQL = await initSqlJs();

    // Load existing database or create new
    if (existsSync(DB_PATH)) {
        const buffer = readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_channel_id TEXT NOT NULL,
            discord_user_id TEXT NOT NULL,
            claude_session_id TEXT,
            working_directory TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            is_active INTEGER DEFAULT 1
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        )
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_channel_user
        ON sessions(discord_channel_id, discord_user_id)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id)
    `);

    saveDatabase();
    return db;
}

function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        writeFileSync(DB_PATH, buffer);
    }
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
    stmt.bind([channelId, userId]);

    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

export function createSession(channelId, userId, workingDir = null) {
    db.run(`
        INSERT INTO sessions (discord_channel_id, discord_user_id, working_directory)
        VALUES (?, ?, ?)
    `, [channelId, userId, workingDir]);

    const result = db.exec("SELECT last_insert_rowid()");
    saveDatabase();
    return result[0].values[0][0];
}

export function updateSessionClaudeId(sessionId, claudeSessionId) {
    db.run(`
        UPDATE sessions
        SET claude_session_id = ?, updated_at = datetime('now')
        WHERE id = ?
    `, [claudeSessionId, sessionId]);
    saveDatabase();
}

export function updateSessionTimestamp(sessionId) {
    db.run(`
        UPDATE sessions
        SET updated_at = datetime('now')
        WHERE id = ?
    `, [sessionId]);
    saveDatabase();
}

export function deactivateSession(sessionId) {
    db.run(`
        UPDATE sessions
        SET is_active = 0, updated_at = datetime('now')
        WHERE id = ?
    `, [sessionId]);
    saveDatabase();
}

export function getAllUserSessions(userId) {
    const results = [];
    const stmt = db.prepare(`
        SELECT * FROM sessions
        WHERE discord_user_id = ?
        ORDER BY updated_at DESC
        LIMIT 20
    `);
    stmt.bind([userId]);

    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

export function addMessage(sessionId, role, content) {
    db.run(`
        INSERT INTO messages (session_id, role, content)
        VALUES (?, ?, ?)
    `, [sessionId, role, content]);
    saveDatabase();
}

export function getSessionMessages(sessionId, limit = 50) {
    const results = [];
    const stmt = db.prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
        ORDER BY created_at ASC
        LIMIT ?
    `);
    stmt.bind([sessionId, limit]);

    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

export function getSessionById(sessionId) {
    const stmt = db.prepare(`
        SELECT * FROM sessions WHERE id = ?
    `);
    stmt.bind([sessionId]);

    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}
