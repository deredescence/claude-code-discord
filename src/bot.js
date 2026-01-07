/**
 * Discord Bot Core (Interactive PTY Version)
 *
 * Persistent Claude sessions with real-time streaming.
 */

import {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    ChannelType
} from 'discord.js';

import {
    ClaudeSession,
    getOrCreateSession,
    getSession,
    killSession,
    getAllSessions
} from './claude-manager.js';
import {
    initDatabase,
    getActiveSession,
    createSession,
    updateSessionClaudeId,
    updateSessionTimestamp,
    deactivateSession,
    getAllUserSessions
} from './utils/session-store.js';
import { formatResponse, formatError, splitMessage } from './utils/formatter.js';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

// Slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('claude')
        .setDescription('Send a message to Claude Code')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('Your message to Claude')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('claude-start')
        .setDescription('Start a new Claude Code session')
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
        .setName('claude-stop')
        .setDescription('Stop your Claude Code session'),

    new SlashCommandBuilder()
        .setName('claude-status')
        .setDescription('Check session status'),

    new SlashCommandBuilder()
        .setName('claude-command')
        .setDescription('Run a Claude Code command (like /help, /config)')
        .addStringOption(option =>
            option.setName('cmd')
                .setDescription('The command (e.g., /help, /plugin, /config)')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('claude-sessions')
        .setDescription('List your recent sessions')
];

export class DiscordBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ]
        });

        // Track message updates for streaming
        this.streamingMessages = new Map(); // channelId_userId -> { message, lastUpdate }

        this.setupEventHandlers();
    }

    async start() {
        initDatabase();
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
            await this.handleCommand(interaction);
        });

        // Handle regular messages as Claude input (if session exists)
        this.client.on('messageCreate', async (message) => {
            if (message.author.bot) return;

            // Check for active session
            const session = getSession(message.channel.id, message.author.id);
            if (session && session.isRunning) {
                await this.handleMessage(message, session);
            }
        });
    }

    async handleCommand(interaction) {
        const { commandName } = interaction;

        switch (commandName) {
            case 'claude':
                await this.handleClaude(interaction);
                break;
            case 'claude-start':
                await this.handleClaudeStart(interaction);
                break;
            case 'claude-stop':
                await this.handleClaudeStop(interaction);
                break;
            case 'claude-status':
                await this.handleClaudeStatus(interaction);
                break;
            case 'claude-command':
                await this.handleClaudeCommand(interaction);
                break;
            case 'claude-sessions':
                await this.handleClaudeSessions(interaction);
                break;
        }
    }

    /**
     * Main claude command - send message to persistent session
     */
    async handleClaude(interaction) {
        const message = interaction.options.getString('message');

        await interaction.deferReply();

        try {
            // Get or create session
            let dbSession = getActiveSession(interaction.channelId, interaction.user.id);

            if (!dbSession) {
                // Auto-create session
                const id = createSession(interaction.channelId, interaction.user.id);
                dbSession = { id, working_directory: process.env.CLAUDE_WORKDIR };
            }

            const session = getOrCreateSession(
                interaction.channelId,
                interaction.user.id,
                {
                    sessionId: dbSession.claude_session_id,
                    workingDir: dbSession.working_directory
                }
            );

            // Set up streaming to Discord
            const key = `${interaction.channelId}_${interaction.user.id}`;
            let outputBuffer = '';
            let lastEdit = Date.now();
            const EDIT_INTERVAL = 1000; // Edit message every second max

            const outputHandler = async (chunk) => {
                outputBuffer += chunk;

                // Throttle Discord edits
                if (Date.now() - lastEdit > EDIT_INTERVAL) {
                    try {
                        const display = outputBuffer.length > 1900
                            ? '...' + outputBuffer.slice(-1900)
                            : outputBuffer;
                        await interaction.editReply(`\`\`\`\n${display}\n\`\`\``);
                        lastEdit = Date.now();
                    } catch (e) {
                        // Edit failed, continue
                    }
                }
            };

            const thinkingHandler = () => {
                // Show thinking indicator
            };

            const sessionHandler = (newId) => {
                updateSessionClaudeId(dbSession.id, newId);
            };

            session.on('output', outputHandler);
            session.on('thinking', thinkingHandler);
            session.on('session', sessionHandler);

            // Send message and wait for response
            const response = await session.send(message);

            // Clean up listeners
            session.off('output', outputHandler);
            session.off('thinking', thinkingHandler);
            session.off('session', sessionHandler);

            // Update timestamp
            updateSessionTimestamp(dbSession.id);

            // Send final response
            const chunks = formatResponse(response);
            if (chunks.length === 0) {
                await interaction.editReply('*(No response)*');
            } else {
                await interaction.editReply(chunks[0].substring(0, 2000));

                for (let i = 1; i < Math.min(chunks.length, 5); i++) {
                    await interaction.followUp(chunks[i].substring(0, 2000));
                }

                if (chunks.length > 5) {
                    await interaction.followUp(`*(${chunks.length - 5} more chunks truncated)*`);
                }
            }

        } catch (error) {
            console.error('Claude error:', error);
            await interaction.editReply(formatError(error));
        }
    }

    /**
     * Start new session explicitly
     */
    async handleClaudeStart(interaction) {
        const workdir = interaction.options.getString('workdir');
        const resumeId = interaction.options.getString('resume');

        await interaction.deferReply({ ephemeral: true });

        try {
            // Kill existing session if any
            killSession(interaction.channelId, interaction.user.id);

            // Deactivate old DB session
            const existing = getActiveSession(interaction.channelId, interaction.user.id);
            if (existing) {
                deactivateSession(existing.id);
            }

            // Create new DB session
            const sessionId = createSession(
                interaction.channelId,
                interaction.user.id,
                workdir || process.env.CLAUDE_WORKDIR
            );

            if (resumeId) {
                updateSessionClaudeId(sessionId, resumeId);
            }

            // Start the PTY session
            const session = getOrCreateSession(
                interaction.channelId,
                interaction.user.id,
                {
                    sessionId: resumeId,
                    workingDir: workdir || process.env.CLAUDE_WORKDIR
                }
            );

            // Wait for it to be ready
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Startup timeout')), 30000);

                session.once('ready', () => {
                    clearTimeout(timeout);
                    resolve();
                });

                session.once('close', () => {
                    clearTimeout(timeout);
                    reject(new Error('Session closed unexpectedly'));
                });
            });

            await interaction.editReply(
                `✅ **Claude Code session started!**\n` +
                `Working directory: \`${workdir || 'default'}\`\n` +
                `${resumeId ? `Resumed: \`${resumeId}\`\n` : ''}` +
                `\nSend messages with \`/claude\` or just type in this channel.`
            );

        } catch (error) {
            console.error('Start error:', error);
            await interaction.editReply(`❌ Failed to start session: ${error.message}`);
        }
    }

    /**
     * Stop session
     */
    async handleClaudeStop(interaction) {
        const killed = killSession(interaction.channelId, interaction.user.id);

        const existing = getActiveSession(interaction.channelId, interaction.user.id);
        if (existing) {
            deactivateSession(existing.id);
        }

        await interaction.reply({
            content: killed ? '⏹️ Session stopped.' : 'No active session.',
            ephemeral: true
        });
    }

    /**
     * Session status
     */
    async handleClaudeStatus(interaction) {
        const session = getSession(interaction.channelId, interaction.user.id);
        const dbSession = getActiveSession(interaction.channelId, interaction.user.id);

        const embed = new EmbedBuilder()
            .setTitle('Claude Code Session')
            .setColor(session?.isRunning ? 0x57F287 : 0x99AAB5)
            .addFields(
                {
                    name: 'Status',
                    value: session?.isRunning
                        ? (session.isReady ? '🟢 Ready' : '🟡 Processing')
                        : '⚪ Inactive',
                    inline: true
                },
                {
                    name: 'Session ID',
                    value: dbSession?.claude_session_id?.substring(0, 12) + '...' || 'None',
                    inline: true
                },
                {
                    name: 'Working Dir',
                    value: dbSession?.working_directory || 'Default',
                    inline: true
                }
            );

        if (session?.isRunning) {
            const uptime = Math.floor((Date.now() - session.lastActivity) / 1000);
            embed.addFields({
                name: 'Last Activity',
                value: `${uptime}s ago`,
                inline: true
            });
        }

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    /**
     * Run Claude Code commands like /help, /plugin, /config
     */
    async handleClaudeCommand(interaction) {
        const cmd = interaction.options.getString('cmd');

        await interaction.deferReply();

        const session = getSession(interaction.channelId, interaction.user.id);

        if (!session || !session.isRunning) {
            await interaction.editReply('❌ No active session. Use `/claude-start` first.');
            return;
        }

        try {
            const response = await session.command(cmd);
            const chunks = formatResponse(response);

            if (chunks.length === 0) {
                await interaction.editReply(`\`${cmd}\` - *(no output)*`);
            } else {
                await interaction.editReply(`**${cmd}**\n${chunks[0].substring(0, 1900)}`);

                for (let i = 1; i < Math.min(chunks.length, 3); i++) {
                    await interaction.followUp(chunks[i].substring(0, 2000));
                }
            }
        } catch (error) {
            await interaction.editReply(formatError(error));
        }
    }

    /**
     * List sessions
     */
    async handleClaudeSessions(interaction) {
        const sessions = getAllUserSessions(interaction.user.id);

        if (sessions.length === 0) {
            await interaction.reply({
                content: 'No sessions found.',
                ephemeral: true
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('Your Sessions')
            .setColor(0x5865F2)
            .setDescription(
                sessions.slice(0, 15).map((s, i) => {
                    const status = s.is_active ? '🟢' : '⚪';
                    const id = s.claude_session_id?.substring(0, 8) || 'pending';
                    const date = new Date(s.updated_at).toLocaleDateString();
                    return `${status} \`${id}...\` - ${date}`;
                }).join('\n')
            );

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    /**
     * Handle regular messages as Claude input
     */
    async handleMessage(message, session) {
        // React to show we're processing
        await message.react('⏳');

        try {
            const response = await session.send(message.content);

            // Remove processing reaction
            await message.reactions.removeAll().catch(() => {});

            // Send response
            const chunks = formatResponse(response);
            if (chunks.length > 0) {
                for (const chunk of chunks.slice(0, 5)) {
                    await message.reply(chunk.substring(0, 2000));
                }
            }
        } catch (error) {
            await message.reactions.removeAll().catch(() => {});
            await message.reply(formatError(error));
        }
    }
}
