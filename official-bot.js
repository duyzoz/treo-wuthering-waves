const {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
} = require('discord.js');

function createOfficialBot({ token, logChannelId, welcomeChannelId, goodbyeChannelId, onMemberJoin, onMemberLeave, onError }) {
  if (!token) return null;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember, Partials.User],
  });

  client.once('ready', () => {
    client.user.setPresence({
      activities: [{ name: 'Wuthering Waves', type: ActivityType.Playing }],
      status: 'online',
    });
  });
  client.on('guildMemberAdd', (member) => onMemberJoin?.(member));
  client.on('guildMemberRemove', (member) => onMemberLeave?.(member));
  client.on('error', (error) => onError?.(error));

  async function getChannel(channelId) {
    if (!channelId) return null;
    const channel = await client.channels.fetch(channelId);
    return channel?.isTextBased?.() ? channel : null;
  }

  async function sendEmbed(channelId, embed) {
    const channel = await getChannel(channelId);
    if (!channel) throw new Error(`Official bot không tìm thấy text channel ${channelId}`);
    return channel.send({ embeds: [embed] });
  }

  async function editEmbed(channelId, messageId, embed) {
    const channel = await getChannel(channelId);
    if (!channel) throw new Error(`Official bot không tìm thấy text channel ${channelId}`);
    const message = await channel.messages.fetch(messageId);
    return message.edit({ embeds: [embed] });
  }

  async function findRecentEmbed(channelId, titlePart) {
    const channel = await getChannel(channelId);
    if (!channel) return null;
    const messages = await channel.messages.fetch({ limit: 10 });
    return messages.find((message) => message.embeds?.[0]?.title?.includes(titlePart)) || null;
  }

  async function login() {
    return client.login(token);
  }

  return {
    client,
    logChannelId,
    welcomeChannelId,
    goodbyeChannelId,
    sendEmbed,
    editEmbed,
    findRecentEmbed,
    login,
  };
}

module.exports = { createOfficialBot };
