/**
 * Claude Code Discord Bot
 */

import { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { getOrCreateSession, removeSession, getSession } from './claude-manager.js';
import { getActiveSession, createSession, deactivateSession, updateSessionClaudeId, addMessage, updateSessionTimestamp, initDatabase, getAllUserSessions, getSessionById, getSessionMessages } from './utils/session-store.js';
import { formatResponseSmart, formatError, formatStructuredOutput, splitMessage } from './utils/formatter.js';
import { processAttachment } from './utils/attachments.js';
import 'dotenv/config';

// Bot configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNELS ? process.env.ALLOWED_CHANNELS.split(',') : [];
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',') : [];

// Per-user display mode: 'raw' (default) or 'clean'
const userDisplayModes = new Map();
const MODE_TOGGLE_TRIGGER = 'ctrl+t';

/**
 * Get display mode for a user (default: raw)
 */
function getDisplayMode(userId) {
    return userDisplayModes.get(userId) || 'raw';
}

/**
 * Toggle display mode for a user
 */
function toggleDisplayMode(userId) {
    const current = getDisplayMode(userId);
    const next = current === 'raw' ? 'clean' : 'raw';
    userDisplayModes.set(userId, next);
    return next;
}

// Slash commands definition
const commands = [
    new SlashCommandBuilder()
        .setName('claude-start')
        .setDescription('Start a Claude Code session')
        .addStringOption(option =>
            option.setName('workdir')
                .setDescription('Working directory')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('resume')
                .setDescription('Session ID to resume')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop your Claude Code session'),

    new SlashCommandBuilder()
        .setName('claude-status')
        .setDescription('Check session status'),

    new SlashCommandBuilder()
        .setName('claude-sessions')
        .setDescription('List your recent sessions'),

    new SlashCommandBuilder()
        .setName('claude-history')
        .setDescription('View message history for a session')
        .addIntegerOption(option =>
            option.setName('session')
                .setDescription('Session ID (from /claude-sessions)')
                .setRequired(false)
        )
];

// Claude Code logo
const CLAUDE_LOGO = `\`\`\`
╲╱╲╱  Claude Code v2.1.1
╱╲╱╲  {{MODEL}} · {{DIR}}
\`\`\``;

export class DiscordBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ],
            partials: [Partials.Channel]
        });

        this.setupEventHandlers();
    }

    async start() {
        await initDatabase();
        await this.registerCommands();
        await this.client.login(DISCORD_TOKEN);
        console.log('Discord bot started!');
    }

    async registerCommands() {
        const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

        try {
            console.log('Registering slash commands...');
            if (DISCORD_GUILD_ID) {
                await rest.put(
                    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
                    { body: commands.map(c => c.toJSON()) }
                );
            } else {
                await rest.put(
                    Routes.applicationCommands(DISCORD_CLIENT_ID),
                    { body: commands.map(c => c.toJSON()) }
                );
            }
            console.log('Slash commands registered!');
        } catch (error) {
            console.error('Failed to register commands:', error);
        }
    }

    setupEventHandlers() {
        this.client.on('ready', () => {
            console.log(`Logged in as ${this.client.user.tag}`);
        });

        this.client.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;
            try {
                await this.handleCommand(interaction);
            } catch (err) {
                console.error('Command error:', err.message);
            }
        });

        this.client.on('messageCreate', async (message) => {
            await this.handleMessage(message);
        });
    }

    async handleCommand(interaction) {
        const { commandName } = interaction;
        switch (commandName) {
            case 'claude-start': await this.handleClaudeStart(interaction); break;
            case 'stop': await this.handleClaudeStop(interaction); break;
            case 'claude-status': await this.handleClaudeStatus(interaction); break;
            case 'claude-sessions': await this.handleClaudeSessions(interaction); break;
            case 'claude-history': await this.handleClaudeHistory(interaction); break;
        }
    }

    async handleClaudeStart(interaction) {
        const workdir = interaction.options.getString('workdir');
        const resumeId = interaction.options.getString('resume');
        await interaction.deferReply();

        try {
            removeSession(interaction.channelId, interaction.user.id);
            const existing = getActiveSession(interaction.channelId, interaction.user.id);
            if (existing) deactivateSession(existing.id);

            const dir = workdir || process.env.CLAUDE_WORKDIR || '.';
            const sessionId = createSession(interaction.channelId, interaction.user.id, dir);
            if (resumeId) updateSessionClaudeId(sessionId, resumeId);

            getOrCreateSession(interaction.channelId, interaction.user.id, {
                sessionId: resumeId,
                workingDir: dir
            });

            const logo = CLAUDE_LOGO
                .replace('{{MODEL}}', process.env.CLAUDE_MODEL || 'claude')
                .replace('{{DIR}}', dir.length > 30 ? '...' + dir.slice(-27) : dir);

            const embed = new EmbedBuilder()
                .setColor(0xE07A2D)
                .setDescription(logo + '\n' + (resumeId ? `*Resuming session \`${resumeId.substring(0, 8)}...\`*\n\n` : '\n') + '**Type your messages below.** Use `/stop` when done.')
                .setFooter({ text: `Session #${sessionId} • ${interaction.user.username}` });

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Start error:', error);
            await interaction.editReply(`Failed to start session: ${error.message}`);
        }
    }

    async handleClaudeStop(interaction) {
        const session = getSession(interaction.channelId, interaction.user.id);
        const dbSession = getActiveSession(interaction.channelId, interaction.user.id);
        const hadSession = !!session || !!dbSession;

        removeSession(interaction.channelId, interaction.user.id);
        if (dbSession) deactivateSession(dbSession.id);

        if (hadSession) {
            const embed = new EmbedBuilder()
                .setColor(0x6B7280)
                .setTitle('Session Ended')
                .setDescription('Use `/claude-start` to begin a new session.')
                .setTimestamp();
            await interaction.reply({ embeds: [embed] });
        } else {
            await interaction.reply({ content: 'No active session to stop.', ephemeral: true });
        }
    }

    async handleClaudeStatus(interaction) {
        const session = getSession(interaction.channelId, interaction.user.id);
        const dbSession = getActiveSession(interaction.channelId, interaction.user.id);
        const embed = new EmbedBuilder()
            .setTitle('Claude Code Session')
            .setColor(session ? 0x57F287 : 0x99AAB5)
            .addFields(
                { name: 'Status', value: session ? (session.isProcessing ? 'Processing' : 'Ready') : 'Inactive', inline: true },
                { name: 'Session ID', value: (dbSession && dbSession.claude_session_id) ? (dbSession.claude_session_id.substring(0, 12) + '...') : 'None', inline: true },
                { name: 'Working Dir', value: dbSession?.working_directory || 'Default', inline: true }
            );
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    async handleClaudeSessions(interaction) {
        const sessions = getAllUserSessions(interaction.user.id);
        if (sessions.length === 0) {
            await interaction.reply({ content: 'No sessions found.', ephemeral: true });
            return;
        }
        const embed = new EmbedBuilder()
            .setTitle('Your Sessions')
            .setColor(0x5865F2)
            .setDescription(sessions.slice(0, 15).map(s => {
                const status = s.is_active ? '🟢' : '⚪';
                const claudeId = s.claude_session_id?.substring(0, 8) || 'pending';
                const date = new Date(s.updated_at).toLocaleDateString();
                return `${status} **#${s.id}** \`${claudeId}...\` - ${date}`;
            }).join('\n'))
            .setFooter({ text: 'Use /claude-history session:<id> to view messages' });
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    async handleClaudeHistory(interaction) {
        // ... (simplified for brevity, similar to previous implementation)
         const sessionIdParam = interaction.options.getInteger('session');
        let targetSession;
        if (sessionIdParam) {
            targetSession = getSessionById(sessionIdParam);
            if (!targetSession || targetSession.discord_user_id !== interaction.user.id) {
                await interaction.reply({ content: 'Session not found or not yours.', ephemeral: true });
                return;
            }
        } else {
            targetSession = getActiveSession(interaction.channelId, interaction.user.id);
            if (!targetSession) {
                await interaction.reply({ content: 'No active session.', ephemeral: true });
                return;
            }
        }

        const messages = getSessionMessages(targetSession.id, 20);
        if (messages.length === 0) {
            await interaction.reply({ content: 'No messages yet.', ephemeral: true });
            return;
        }

        const historyText = messages.map(m => {
            const role = m.role === 'user' ? '**You:**' : '**Claude:**';
            return `${role} ${m.content.substring(0, 200)}...`;
        }).join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle(`Session #${targetSession.id} History`)
            .setColor(0x5865F2)
            .setDescription(historyText.substring(0, 4000));
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    /**
     * Handle message with mode toggle and streaming
     */
    async handleMessage(message) {
        if (message.author.bot) return;
        if (ALLOWED_CHANNELS.length > 0 && !ALLOWED_CHANNELS.includes(message.channelId)) return;
        if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(message.author.id)) return;

        // Mode Toggle
        if (message.content.trim().toLowerCase() === MODE_TOGGLE_TRIGGER) {
            const newMode = toggleDisplayMode(message.author.id);
            try { await message.delete(); } catch (e) {}
            const notice = await message.channel.send(`-# 🔄 Display mode switched to: **${newMode.toUpperCase()}**`);
            setTimeout(() => notice.delete().catch(() => {}), 3000);
            return;
        }

        // Check for session
        const session = getSession(message.channel.id, message.author.id);
        if (!session) return; // Only process if session exists (user must /claude-start)

        // Check if already processing - show friendly message instead of error
        if (session.isProcessing) {
            try {
                await message.react('⏳');
                const notice = await message.reply('-# ⏳ Still processing your previous message. Please wait...');
                setTimeout(() => notice.delete().catch(() => {}), 5000);
            } catch (e) {}
            return;
        }

        try {
            await message.channel.sendTyping();

            // Build content array for Claude Code
            let contentArray = [];

            // Add text content
            if (message.content) {
                contentArray.push({ type: 'text', text: message.content });
            }

            // Process image attachments
            for (const att of message.attachments.values()) {
                const imageData = await processAttachment(att);
                if (imageData) {
                    contentArray.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: imageData.mediaType,
                            data: imageData.base64
                        }
                    });
                }
            }

            // If no content, skip
            if (contentArray.length === 0) return;

            const replyMessage = await message.reply('`░░░░░░░░░░` Thinking...');

            // Stream state
            const streamBlocks = []; // {type: 'text'|'thinking'|'tool', content: string}
            let lastUpdateTime = Date.now();
            let pendingQuestion = null; // Track AskUserQuestion for separate handling
            let currentStatus = 'Thinking...'; // Current activity status
            let startTime = Date.now();
            let statusInterval = null;

            // Animated progress bar frames
            const progressFrames = ['`░░░░░░░░░░`', '`█░░░░░░░░░`', '`██░░░░░░░░`', '`███░░░░░░░`', '`████░░░░░░`', '`█████░░░░░`', '`██████░░░░`', '`███████░░░`', '`████████░░`', '`█████████░`', '`██████████`'];
            let frameIndex = 0;

            const formatStatusLine = () => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                const frame = progressFrames[frameIndex % progressFrames.length];
                frameIndex++;
                return `\n${frame} ${currentStatus} *(${timeStr})*`;
            };

            const updateMessage = async (final = false) => {
                const now = Date.now();
                if (!final && now - lastUpdateTime < 1000) return; // 1s throttle
                lastUpdateTime = now;

                try {
                    const mode = getDisplayMode(message.author.id);
                    let formatted = formatStructuredOutput(streamBlocks, mode);

                    // Add animated status line at bottom (unless final)
                    if (!final) {
                        formatted += formatStatusLine();
                    }

                    const chunks = splitMessage(formatted || 'Processing...');
                    if (chunks.length > 0) {
                        await replyMessage.edit(chunks[0]);
                    }
                } catch (e) {
                    // Edit failed, continue
                }
            };

            // Start status animation interval
            statusInterval = setInterval(() => updateMessage(), 800);

            const onText = (text) => {
                streamBlocks.push({ type: 'text', content: text });
                updateMessage();
            };
            const onThinking = (think) => {
                currentStatus = 'Thinking...';
                streamBlocks.push({ type: 'thinking', content: think });
                updateMessage();
            };
            const onTool = (tool) => {
                // Detect AskUserQuestion and store for separate handling
                if (tool.name === 'AskUserQuestion' && tool.input && tool.input.questions) {
                    pendingQuestion = tool.input;
                }
                // Use human-readable status if available, otherwise show tool name
                currentStatus = tool.status || `Using ${tool.name}`;
                streamBlocks.push({ type: 'tool', content: tool.status || tool.name });
                updateMessage();
            };

            // Listen for status updates too
            const onStatus = (status) => {
                currentStatus = status;
                updateMessage();
            };

            session.on('text', onText);
            session.on('thinking', onThinking);
            session.on('tool_use', onTool);
            session.on('status', onStatus);

            try {
                const result = await session.send(contentArray);

                // Final Update - use streamBlocks for both modes
                const mode = getDisplayMode(message.author.id);
                const formatted = formatStructuredOutput(streamBlocks, mode);
                const chunks = splitMessage(formatted);
                if (chunks.length > 0) {
                    await replyMessage.edit(chunks[0]);
                    for (let i = 1; i < chunks.length; i++) {
                        await message.channel.send(chunks[i]);
                    }
                }

                // If there was an AskUserQuestion, send it as a new message
                if (pendingQuestion && pendingQuestion.questions) {
                    const questionEmbed = new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setTitle('🤔 Claude needs your input');

                    let desc = '';
                    for (const q of pendingQuestion.questions) {
                        desc += `**${q.header || 'Question'}:** ${q.question}\n`;
                        if (q.options && q.options.length > 0) {
                            for (const opt of q.options) {
                                desc += `  • **${opt.label}** - ${opt.description || ''}\n`;
                            }
                        }
                        desc += '\n';
                    }

                    questionEmbed.setDescription(desc.trim());
                    questionEmbed.setFooter({ text: 'Reply with your choice to continue' });
                    await message.channel.send({ embeds: [questionEmbed] });
                }

                // Update DB
                const dbSession = getActiveSession(message.channel.id, message.author.id);
                if (dbSession) {
                    addMessage(dbSession.id, 'user', message.content);
                    addMessage(dbSession.id, 'assistant', result.output);
                    updateSessionTimestamp(dbSession.id);
                }

            } catch (error) {
                console.error('Error processing message:', error);
                await replyMessage.edit(formatError(error));
            } finally {
                // Stop animation and clean up listeners
                clearInterval(statusInterval);
                session.off('text', onText);
                session.off('thinking', onThinking);
                session.off('tool_use', onTool);
                session.off('status', onStatus);
            }

        } catch (error) {
            console.error('Fatal error:', error);
            await message.channel.send(formatError(error));
        }
    }
}
