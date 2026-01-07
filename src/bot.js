/**
 * Discord Bot Core
 * Handles Discord connection, slash commands, and message routing
 */

import {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType
} from 'discord.js';

import { ClaudeProcess, getProcess, setProcess, removeProcess } from './claude-manager.js';
import {
    initDatabase,
    getActiveSession,
    createSession,
    updateSessionClaudeId,
    updateSessionTimestamp,
    deactivateSession,
    getAllUserSessions
} from './utils/session-store.js';
import { formatResponse, formatError, formatStatus, splitMessage } from './utils/formatter.js';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

// Slash command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('claude')
        .setDescription('Send a message to Claude Code')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('Your message to Claude')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('workdir')
                .setDescription('Working directory for Claude (optional)')
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option.setName('file')
                .setDescription('Attach a file for Claude to analyze')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('claude-new')
        .setDescription('Start a new Claude Code session (forgets previous context)')
        .addStringOption(option =>
            option.setName('workdir')
                .setDescription('Working directory for the new session')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('claude-resume')
        .setDescription('Resume a previous Claude Code session')
        .addStringOption(option =>
            option.setName('session_id')
                .setDescription('Session ID to resume (leave empty for most recent)')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('claude-stop')
        .setDescription('Stop the current Claude Code session'),

    new SlashCommandBuilder()
        .setName('claude-sessions')
        .setDescription('List your recent Claude Code sessions'),

    new SlashCommandBuilder()
        .setName('claude-status')
        .setDescription('Check if Claude Code is running in this channel')
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

        this.setupEventHandlers();
    }

    async start() {
        // Initialize database
        initDatabase();

        // Register slash commands
        await this.registerCommands();

        // Login to Discord
        await this.client.login(DISCORD_TOKEN);

        console.log('Discord bot started!');
    }

    async registerCommands() {
        const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

        try {
            console.log('Registering slash commands...');

            if (DISCORD_GUILD_ID) {
                // Guild-specific (instant update)
                await rest.put(
                    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
                    { body: commands.map(c => c.toJSON()) }
                );
            } else {
                // Global (can take up to 1 hour)
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
            if (interaction.isChatInputCommand()) {
                await this.handleSlashCommand(interaction);
            } else if (interaction.isButton()) {
                await this.handleButton(interaction);
            }
        });

        // Handle regular messages in threads (for ongoing conversations)
        this.client.on('messageCreate', async (message) => {
            // Ignore bots
            if (message.author.bot) return;

            // Check if this is in a thread we're tracking
            const proc = getProcess(message.channel.id, message.author.id);
            if (proc && proc.isRunning) {
                await this.handleThreadMessage(message, proc);
            }
        });
    }

    async handleSlashCommand(interaction) {
        const { commandName } = interaction;

        switch (commandName) {
            case 'claude':
                await this.handleClaude(interaction);
                break;
            case 'claude-new':
                await this.handleClaudeNew(interaction);
                break;
            case 'claude-resume':
                await this.handleClaudeResume(interaction);
                break;
            case 'claude-stop':
                await this.handleClaudeStop(interaction);
                break;
            case 'claude-sessions':
                await this.handleClaudeSessions(interaction);
                break;
            case 'claude-status':
                await this.handleClaudeStatus(interaction);
                break;
        }
    }

    async handleClaude(interaction) {
        const prompt = interaction.options.getString('prompt');
        const workdir = interaction.options.getString('workdir');
        const file = interaction.options.getAttachment('file');

        await interaction.deferReply();

        try {
            // Get or create session
            let session = getActiveSession(interaction.channelId, interaction.user.id);
            let claudeSessionId = null;

            if (session) {
                claudeSessionId = session.claude_session_id;
                updateSessionTimestamp(session.id);
            } else {
                const sessionId = createSession(
                    interaction.channelId,
                    interaction.user.id,
                    workdir || process.env.CLAUDE_WORKDIR
                );
                session = { id: sessionId };
            }

            // Build prompt with file if attached
            let fullPrompt = prompt;
            if (file) {
                fullPrompt = `[Attached file: ${file.name}]\nURL: ${file.url}\n\n${prompt}`;
            }

            // Create Claude process
            const claude = new ClaudeProcess({
                sessionId: claudeSessionId,
                workingDir: workdir || process.env.CLAUDE_WORKDIR || process.cwd()
            });

            setProcess(interaction.channelId, interaction.user.id, claude);

            // Stream output
            let responseBuffer = '';
            let lastUpdateTime = Date.now();
            const UPDATE_INTERVAL = 1000; // Update every second

            claude.on('output', async (chunk) => {
                responseBuffer += chunk + '\n';

                // Throttle updates
                if (Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
                    try {
                        const chunks = formatResponse(responseBuffer);
                        if (chunks.length > 0) {
                            await interaction.editReply(chunks[0].substring(0, 2000));
                        }
                    } catch (e) {
                        // Ignore edit errors during streaming
                    }
                    lastUpdateTime = Date.now();
                }
            });

            claude.on('session', (newSessionId) => {
                updateSessionClaudeId(session.id, newSessionId);
            });

            // Execute prompt
            const result = await claude.execute(fullPrompt, {
                continueSession: !!claudeSessionId
            });

            // Update session
            if (result.sessionId) {
                updateSessionClaudeId(session.id, result.sessionId);
            }

            // Send final response
            const chunks = formatResponse(result.output);

            if (chunks.length === 0) {
                await interaction.editReply('*(No output)*');
            } else if (chunks.length === 1) {
                await interaction.editReply(chunks[0]);
            } else {
                // Send first chunk as reply, rest as follow-ups
                await interaction.editReply(chunks[0]);
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp(chunks[i]);
                }
            }

            // Add continue button
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('claude_continue')
                        .setLabel('Continue')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('claude_new')
                        .setLabel('New Session')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.followUp({ components: [row], ephemeral: true });

        } catch (error) {
            console.error('Claude error:', error);
            await interaction.editReply(formatError(error));
        } finally {
            removeProcess(interaction.channelId, interaction.user.id);
        }
    }

    async handleClaudeNew(interaction) {
        const workdir = interaction.options.getString('workdir');

        // Deactivate any existing session
        const existing = getActiveSession(interaction.channelId, interaction.user.id);
        if (existing) {
            deactivateSession(existing.id);
        }

        // Remove any running process
        removeProcess(interaction.channelId, interaction.user.id);

        // Create new session
        createSession(
            interaction.channelId,
            interaction.user.id,
            workdir || process.env.CLAUDE_WORKDIR
        );

        await interaction.reply({
            content: '✅ New Claude Code session started. Use `/claude` to send messages.',
            ephemeral: true
        });
    }

    async handleClaudeResume(interaction) {
        const sessionId = interaction.options.getString('session_id');

        await interaction.deferReply({ ephemeral: true });

        if (sessionId) {
            // Resume specific session
            const sessions = getAllUserSessions(interaction.user.id);
            const session = sessions.find(s => s.claude_session_id === sessionId);

            if (!session) {
                await interaction.editReply('❌ Session not found. Use `/claude-sessions` to see your sessions.');
                return;
            }

            // Reactivate session in this channel
            createSession(interaction.channelId, interaction.user.id, session.working_directory);
            updateSessionClaudeId(session.id, sessionId);

            await interaction.editReply(`✅ Resumed session \`${sessionId}\``);
        } else {
            // Resume most recent
            const session = getActiveSession(interaction.channelId, interaction.user.id);

            if (!session?.claude_session_id) {
                await interaction.editReply('❌ No active session to resume. Use `/claude` to start one.');
                return;
            }

            await interaction.editReply(`✅ Ready to continue session \`${session.claude_session_id}\``);
        }
    }

    async handleClaudeStop(interaction) {
        const proc = getProcess(interaction.channelId, interaction.user.id);

        if (proc) {
            removeProcess(interaction.channelId, interaction.user.id);
            await interaction.reply({
                content: '⏹️ Claude Code session stopped.',
                ephemeral: true
            });
        } else {
            await interaction.reply({
                content: 'No active Claude process in this channel.',
                ephemeral: true
            });
        }
    }

    async handleClaudeSessions(interaction) {
        const sessions = getAllUserSessions(interaction.user.id);

        if (sessions.length === 0) {
            await interaction.reply({
                content: 'No sessions found. Use `/claude` to start one.',
                ephemeral: true
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('Your Claude Code Sessions')
            .setColor(0x5865F2)
            .setDescription(
                sessions.map((s, i) => {
                    const status = s.is_active ? '🟢' : '⚪';
                    const sessionId = s.claude_session_id?.substring(0, 8) || 'pending';
                    const date = new Date(s.updated_at).toLocaleDateString();
                    return `${status} \`${sessionId}...\` - ${date} - ${s.working_directory || 'default'}`;
                }).join('\n')
            );

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    async handleClaudeStatus(interaction) {
        const session = getActiveSession(interaction.channelId, interaction.user.id);
        const proc = getProcess(interaction.channelId, interaction.user.id);

        const embed = new EmbedBuilder()
            .setTitle('Claude Code Status')
            .setColor(proc ? 0x57F287 : 0x99AAB5)
            .addFields(
                { name: 'Session', value: session?.claude_session_id || 'None', inline: true },
                { name: 'Process', value: proc ? 'Running' : 'Idle', inline: true },
                { name: 'Working Dir', value: session?.working_directory || 'Default', inline: true }
            );

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    async handleButton(interaction) {
        if (interaction.customId === 'claude_continue') {
            await interaction.reply({
                content: 'Use `/claude` to send your next message. The session will continue automatically.',
                ephemeral: true
            });
        } else if (interaction.customId === 'claude_new') {
            await this.handleClaudeNew(interaction);
        }
    }

    async handleThreadMessage(message, proc) {
        // This handles ongoing interactive sessions
        try {
            proc.send(message.content);
        } catch (error) {
            await message.reply(formatError(error));
        }
    }
}
