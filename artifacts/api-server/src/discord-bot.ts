// The bot is intentionally kept close to the uploaded JavaScript implementation.
// Discord.js has a large runtime surface that esbuild should leave external.
// @ts-nocheck

import path from "node:path";
import fs from "node:fs";
import { logger } from "./lib/logger";

const Database = require("better-sqlite3");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  SlashCommandBuilder,
} = require("discord.js");

// Keep DISCORD_TOKEN as the documented name, but accept the two common
// alternatives so a correctly stored secret does not make the whole service
// fail just because it was named differently.
const TOKEN =
  process.env.DISCORD_TOKEN?.trim() ||
  process.env.DISCORD_BOT_TOKEN?.trim() ||
  process.env.BOT_TOKEN?.trim();
const LOG_CHANNEL_ID = process.env.INVITE_LOG_CHANNEL_ID?.trim();
const SERVER_LABEL = process.env.SERVER_LABEL?.trim() || "Noomspace";
const HISTORICAL_LOG_CHANNEL_ID =
  process.env.HISTORICAL_LOG_CHANNEL_ID?.trim() || "";
const IMPORT_HISTORICAL_LOGS =
  String(process.env.IMPORT_HISTORICAL_LOGS).toLowerCase() === "true";
const RUN_BOT_TEST =
  String(process.env.RUN_BOT_TEST).toLowerCase() === "true";

const configuredLogChannels = new Map();
const inviteCache = new Map();
let botStarted = false;

function failConfiguration(message) {
  logger.error(message);
  throw new Error(message);
}

if (!TOKEN) {
  failConfiguration(
    "Discord bot is not configured. Add the bot token as the DISCORD_TOKEN secret.",
  );
}

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "invites.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS invite_scores (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS counted_joins (
    guild_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS imported_messages (
    guild_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS seeded_invites (
    guild_id TEXT NOT NULL,
    invite_code TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, invite_code)
  );
  CREATE TABLE IF NOT EXISTS guild_log_channels (
    guild_id TEXT NOT NULL PRIMARY KEY,
    channel_id TEXT NOT NULL
  );
`);

const addScore = db.prepare(`
  INSERT INTO invite_scores (guild_id, user_id, score)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id, user_id)
  DO UPDATE SET score = score + excluded.score
`);
const setScore = db.prepare(`
  INSERT INTO invite_scores (guild_id, user_id, score)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id, user_id)
  DO UPDATE SET score = MAX(score, excluded.score)
`);
const getScore = db.prepare(
  "SELECT score FROM invite_scores WHERE guild_id = ? AND user_id = ?",
);
const hasCountedJoin = db.prepare(
  "SELECT 1 FROM counted_joins WHERE guild_id = ? AND member_id = ?",
);
const markJoin = db.prepare(`
  INSERT OR IGNORE INTO counted_joins
    (guild_id, member_id, message_id, created_at)
  VALUES (?, ?, ?, ?)
`);
const markImported = db.prepare(`
  INSERT OR IGNORE INTO imported_messages (guild_id, message_id)
  VALUES (?, ?)
`);
const isImported = db.prepare(
  "SELECT 1 FROM imported_messages WHERE guild_id = ? AND message_id = ?",
);
const saveSeededInvite = db.prepare(`
  INSERT INTO seeded_invites (guild_id, invite_code, uses)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id, invite_code) DO UPDATE SET uses = excluded.uses
`);
const getSeededInvite = db.prepare(
  "SELECT uses FROM seeded_invites WHERE guild_id = ? AND invite_code = ?",
);
const getGuildLogChannel = db.prepare(
  "SELECT channel_id FROM guild_log_channels WHERE guild_id = ?",
);
const saveGuildLogChannel = db.prepare(`
  INSERT INTO guild_log_channels (guild_id, channel_id)
  VALUES (?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.GuildMember],
});

function displayDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function memberAvatar(user) {
  return user.displayAvatarURL({
    extension: "png",
    size: 256,
    forceStatic: false,
  });
}

function serverName(guild) {
  return SERVER_LABEL || guild.name;
}

function guildIcon(guild, size = 64) {
  return guild.iconURL({ extension: "png", size }) || undefined;
}

async function cacheGuildInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const uses = new Map();

    for (const invite of invites.values()) {
      const count = invite.uses ?? 0;
      uses.set(invite.code, count);
      const existing = getSeededInvite.get(guild.id, invite.code);

      if (!existing) {
        if (invite.inviter?.id && count > 0) {
          setScore.run(guild.id, invite.inviter.id, count);
        }
        saveSeededInvite.run(guild.id, invite.code, count);
      } else if (count > existing.uses) {
        const delta = count - existing.uses;
        if (invite.inviter?.id && delta > 0) {
          addScore.run(guild.id, invite.inviter.id, delta);
        }
        saveSeededInvite.run(guild.id, invite.code, count);
      }
    }

    inviteCache.set(guild.id, uses);
  } catch (error) {
    logger.warn(
      { guild: guild.name, error: error?.message },
      "Could not cache Discord invites",
    );
  }
}

async function findUsedInvite(guild) {
  try {
    const previous = inviteCache.get(guild.id) || new Map();
    const currentInvites = await guild.invites.fetch();
    let usedInvite = null;
    let largestIncrease = 0;

    for (const invite of currentInvites.values()) {
      const oldUses = previous.get(invite.code) ?? 0;
      const newUses = invite.uses ?? 0;
      const increase = newUses - oldUses;
      if (increase > largestIncrease) {
        largestIncrease = increase;
        usedInvite = invite;
      }
    }

    const current = new Map();
    for (const invite of currentInvites.values()) {
      const count = invite.uses ?? 0;
      current.set(invite.code, count);
      saveSeededInvite.run(guild.id, invite.code, count);
    }
    inviteCache.set(guild.id, current);
    return usedInvite;
  } catch (error) {
    logger.warn(
      { guild: guild.name, error: error?.message },
      "Could not determine the used invite",
    );
    return null;
  }
}

function baseEmbed(guild) {
  return new EmbedBuilder()
    .setColor(0x8b3cff)
    .setAuthor({ name: serverName(guild), iconURL: guildIcon(guild) });
}

function joinEmbed(guild, member, inviter) {
  const description = inviter
    ? `<@${inviter.id}> invited <@${member.id}>`
    : `A new member joined: <@${member.id}>`;

  // Keep this compact, matching the supplied screenshot rather than adding
  // extra fields that would make the card taller.
  return baseEmbed(guild)
    .setTitle(member.user.username)
    .setDescription(description)
    .setThumbnail(memberAvatar(member.user))
    .setFooter({
      text: `member #${guild.memberCount} · ${serverName(guild)} · ${displayDate()}`,
    });
}

function creationEmbed(guild, invite) {
  const creator = invite.inviter;
  return baseEmbed(guild)
    .setTitle("Invite Link Created")
    .setDescription(
      creator
        ? `<@${creator.id}> created an invite link`
        : "An invite link was created",
    )
    .setThumbnail(
      creator ? memberAvatar(creator) : guild.iconURL({ extension: "png", size: 256 }),
    )
    .addFields(
      { name: "Invite", value: `\`${invite.code}\``, inline: true },
      { name: "Uses", value: `**${invite.uses ?? 0}**`, inline: true },
    )
    .setFooter({ text: `${serverName(guild)} · ${displayDate()}` });
}

function invitesEmbed(guild, user, score) {
  return baseEmbed(guild)
    .setTitle(`${user.username}'s invites`)
    .setDescription(`<@${user.id}> has **${score}** successful invite${score === 1 ? "" : "s"}.`)
    .setThumbnail(memberAvatar(user))
    .setFooter({ text: `${serverName(guild)} · ${displayDate()}` });
}

function testJoinEmbed(guild, user) {
  return baseEmbed(guild)
    .setTitle(user.username)
    .setDescription(`<@${client.user.id}> invited <@${user.id}>`)
    .setThumbnail(memberAvatar(user))
    .setFooter({
      text: `member #${guild.memberCount} · ${serverName(guild)} · ${displayDate()}`,
    });
}

function botTestEmbed(guild) {
  return baseEmbed(guild)
    .setTitle("noom Bot Test")
    .setDescription(`<@${client.user.id}> sent a test invite card`)
    .setThumbnail(memberAvatar(client.user))
    .setFooter({
      text: `member #${guild.memberCount} · ${serverName(guild)} · ${displayDate()}`,
    });
}

function canWriteLogChannel(channel, guild) {
  if (!channel || channel.type !== ChannelType.GuildText) return false;

  const me = guild.members.me;
  const permissions = me ? channel.permissionsFor(me) : null;
  return Boolean(
    permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]),
  );
}

function resolveLogChannel(guild) {
  const storedChannelId =
    configuredLogChannels.get(guild.id) ||
    getGuildLogChannel.get(guild.id)?.channel_id;
  const candidates = [
    storedChannelId ? guild.channels.cache.get(storedChannelId) : null,
    LOG_CHANNEL_ID ? guild.channels.cache.get(LOG_CHANNEL_ID) : null,
    guild.systemChannel,
    ...guild.channels.cache.values(),
  ];
  const seen = new Set();

  for (const channel of candidates) {
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    if (canWriteLogChannel(channel, guild)) {
      configuredLogChannels.set(guild.id, channel.id);
      saveGuildLogChannel.run(guild.id, channel.id);
      return channel;
    }
  }

  return null;
}

async function sendLog(guild, payload) {
  const channel = resolveLogChannel(guild);
  if (!channel?.isTextBased()) {
    logger.warn(
      { guild: guild.name },
      "No writable text channel is available for invite logs",
    );
    return null;
  }

  try {
    return await channel.send(payload);
  } catch (error) {
    logger.error({ guild: guild.name, error: error?.message }, "Could not send invite log");
    return null;
  }
}

async function importHistoricalMessages(guild) {
  if (!HISTORICAL_LOG_CHANNEL_ID) return;
  const channel = guild.channels.cache.get(HISTORICAL_LOG_CHANNEL_ID);
  if (!channel?.isTextBased()) return;

  let before;
  let fetchedAny = true;
  let imported = 0;

  while (fetchedAny) {
    const options = { limit: 100 };
    if (before) options.before = before;
    const batch = await channel.messages.fetch(options);
    fetchedAny = batch.size > 0;
    if (!fetchedAny) break;

    for (const message of batch.values()) {
      if (isImported.get(guild.id, message.id)) continue;
      const text = [
        message.content || "",
        ...message.embeds.flatMap((embed) => [
          embed.title || "",
          embed.description || "",
          ...(embed.fields || []).flatMap((field) => [field.name || "", field.value || ""]),
        ]),
      ].join(" ");
      const match = text.match(/<@!?(\d+)>\s+invited\s+<@!?(\d+)>/i);
      if (match) {
        const inviterId = match[1];
        if (!hasCountedJoin.get(guild.id, match[2])) {
          addScore.run(guild.id, inviterId, 1);
        }
        imported++;
      }
      markImported.run(guild.id, message.id);
    }
    before = batch.last()?.id;
  }

  logger.info({ guild: guild.name, imported }, "Historical invite logs imported");
}

function commandPayloads() {
  const commands = [
    new SlashCommandBuilder()
      .setName("invites")
      .setDescription("Check your successful invite score")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Another member to check")
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("invitechannel")
      .setDescription("Choose where invite activity is logged")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("A normal text channel")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("invitetest")
      .setDescription("Post a screenshot-style invite card using your profile"),
  ];
  return commands.map((command) => command.toJSON());
}

async function registerCommands(guild) {
  try {
    await guild.commands.set(commandPayloads());
    logger.info({ guild: guild.name }, "Registered invite tracker commands");
  } catch (error) {
    logger.error(
      {
        guild: guild.name,
        error: error?.message,
        rawError: error?.rawError,
        requestBody: error?.requestBody,
      },
      "Could not register invite tracker commands",
    );
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  try {
    if (interaction.commandName === "invitetest") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        content: "You need **Manage Channels** to post a test card.",
        ephemeral: true,
      });
      return;
    }

      const message = await sendLog(interaction.guild, {
        content: `<@${interaction.user.id}>`,
        embeds: [testJoinEmbed(interaction.guild, interaction.user)],
        allowedMentions: { users: [interaction.user.id] },
      });

      await interaction.reply({
        content: message
          ? "The test invite card was posted in the configured invite channel."
          : "I could not post the test card. Check the bot’s channel permissions.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "invites") {
      const target = interaction.options.getUser("user") || interaction.user;
      const score = getScore.get(interaction.guildId, target.id)?.score ?? 0;
      await interaction.reply({
        embeds: [invitesEmbed(interaction.guild, target, score)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (interaction.commandName === "invitechannel") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({
          content: "You need **Manage Channels** to change the invite log channel.",
          ephemeral: true,
        });
        return;
      }

      const channel = interaction.options.getChannel("channel", true);
      if (channel.type !== ChannelType.GuildText) {
        await interaction.reply({
          content: "Please choose a normal text channel.",
          ephemeral: true,
        });
        return;
      }

      configuredLogChannels.set(interaction.guildId, channel.id);
      saveGuildLogChannel.run(interaction.guildId, channel.id);
      await interaction.reply({
        content: `Invite activity will now be posted in <#${channel.id}>.`,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    logger.error(
      {
        command: interaction.commandName,
        error: error?.message,
        rawError: error?.rawError,
        requestBody: error?.requestBody,
      },
      "Discord command request failed",
    );
  }
});

client.once("ready", async () => {
  const visibleLogChannels = client.guilds.cache.filter((guild) =>
    Boolean(resolveLogChannel(guild)),
  ).size;
  logger.info(
    {
      user: client.user.tag,
      applicationId: client.user.id,
      guilds: client.guilds.cache.size,
      visibleLogChannels,
      configuredChannel: LOG_CHANNEL_ID || "automatic per-server selection",
      inviteUrl: getBotInviteUrl(),
    },
    "Discord bot logged in",
  );
  if (visibleLogChannels === 0) {
    logger.warn(
      {},
      "The bot cannot find a writable text channel in any joined server",
    );
  }

  for (const guild of client.guilds.cache.values()) {
    await registerCommands(guild);
    await cacheGuildInvites(guild);
    if (IMPORT_HISTORICAL_LOGS) {
      try {
        await importHistoricalMessages(guild);
      } catch (error) {
        logger.error(
          { guild: guild.name, error: error?.message },
          "Historical invite import failed",
        );
      }
    }
  }

  if (RUN_BOT_TEST) {
    const testGuild = [...client.guilds.cache.values()].find((guild) =>
      Boolean(guild.channels.cache.get(LOG_CHANNEL_ID)),
    );
    if (testGuild) {
      const message = await sendLog(testGuild, {
        embeds: [botTestEmbed(testGuild)],
        allowedMentions: { parse: [] },
      });
      logger.info(
        { guild: testGuild.name, posted: Boolean(message) },
        "Bot-only test embed completed",
      );
    } else {
      logger.warn(
        {},
        "Bot-only test could not find a writable invite log channel",
      );
    }
  }
});

client.on("guildCreate", async (guild) => {
  logger.info({ guild: guild.name, guildId: guild.id }, "Discord bot joined a server");
  await registerCommands(guild);
  await cacheGuildInvites(guild);
});

client.on("inviteCreate", async (invite) => {
  const guild = invite.guild;
  if (!guild) return;
  const current = inviteCache.get(guild.id) || new Map();
  current.set(invite.code, invite.uses ?? 0);
  inviteCache.set(guild.id, current);
  saveSeededInvite.run(guild.id, invite.code, invite.uses ?? 0);

  const creator = invite.inviter;
  await sendLog(guild, {
    content: creator ? `<@${creator.id}>` : "",
    embeds: [creationEmbed(guild, invite)],
    allowedMentions: creator ? { users: [creator.id] } : { parse: [] },
  });
});

client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;
  const invite = await findUsedInvite(guild);
  const inviter = invite?.inviter ?? null;
  let score = 0;

  if (inviter) {
    if (!hasCountedJoin.get(guild.id, member.id)) {
      addScore.run(guild.id, inviter.id, 1);
      markJoin.run(guild.id, member.id, null, Date.now());
    }
    score = getScore.get(guild.id, inviter.id)?.score ?? 0;
  }

  const message = await sendLog(guild, {
    content: inviter ? `<@${inviter.id}>` : "",
    embeds: [joinEmbed(guild, member, inviter, score)],
    allowedMentions: inviter
      ? { users: [inviter.id, member.id] }
      : { users: [member.id] },
  });

  if (message && inviter) {
    db.prepare(
      "UPDATE counted_joins SET message_id = ? WHERE guild_id = ? AND member_id = ?",
    ).run(message.id, guild.id, member.id);
  }
});

client.on("error", (error) => {
  logger.error({ error: error?.message }, "Discord client error");
});

function closeBot() {
  db.close();
  client.destroy();
}

const INVITE_PERMISSIONS = "85024";

export function getBotInviteUrl() {
  const applicationId =
    client.user?.id || process.env.DISCORD_CLIENT_ID?.trim();
  if (!applicationId || !/^\d{17,20}$/.test(applicationId)) return null;

  const params = new URLSearchParams({
    client_id: applicationId,
    scope: "bot applications.commands",
    permissions: INVITE_PERMISSIONS,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

process.once("SIGINT", closeBot);
process.once("SIGTERM", closeBot);

export function startDiscordBot() {
  if (botStarted) return;
  botStarted = true;
  client.login(TOKEN).catch((error) => {
    logger.error({ error: error?.message }, "Discord bot login failed");
    process.exitCode = 1;
  });
}