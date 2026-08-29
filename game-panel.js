const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { GAME_PRESETS } = require('./game-profiles');

function panelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('game:change').setLabel('Đổi Game').setEmoji('🎮').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('game:customize').setLabel('Tùy Chỉnh').setEmoji('✨').setStyle(ButtonStyle.Secondary),
  )].map((row) => row.toJSON());
}
function gameSelectComponents() {
  const options = GAME_PRESETS.map((game) => ({ label: game.name.slice(0, 100), value: game.id, emoji: game.emoji, description: game.statuses[0].slice(0, 100) }));
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('game:select').setPlaceholder('Chọn game gacha...').addOptions(options))].map((row) => row.toJSON());
}
function customizeModal() {
  const modal = new ModalBuilder().setCustomId('game:customize_modal').setTitle('Tùy chỉnh game status');
  const input = (id, label, placeholder, style = TextInputStyle.Short, required = false) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder).setStyle(style).setRequired(required));
  modal.addComponents(
    input('game_id', 'Game ID', 'wuwa hoặc genshin', TextInputStyle.Short, true),
    input('status', 'Trạng thái đang chơi', 'Exploring Teyvat · Farming Artifacts', TextInputStyle.Short, false),
    input('duration', 'Đang chơi bao lâu (phút)', '30', TextInputStyle.Short, false),
    input('large_image', 'URL ảnh game chính', 'https://...', TextInputStyle.Short, false),
    input('small_image', 'URL logo/ảnh nhỏ', 'https://...', TextInputStyle.Short, false),
  );
  return modal;
}
function previewText(profile) {
  return `${profile.emoji} **${profile.gameName}**\n🎮 ${profile.status}\n⏱️ ${profile.durationMinutes} phút\n🖼️ Ảnh lớn: ${profile.largeImageUrl ? 'đã đặt' : 'mặc định'} · ảnh nhỏ: ${profile.smallImageUrl ? 'đã đặt' : 'mặc định'}`;
}
module.exports = { panelComponents, gameSelectComponents, customizeModal, previewText };
