// Telegram forum-topic video limiter bot
//
// What it does:
// - Exempts selected topics (like General, Chatroom, Request) from counting
// - Counts video posts per user per topic in all other forum topics
// - After a user reaches the limit, the bot restricts that user so they can still send text
//   but cannot send videos/media in the group
//
// Install:
//   npm i telegraf dotenv
//
// Run:
//   BOT_TOKEN=123456:ABC... LIMIT=3 node telegram_video_limit_bot.js
//
// Important setup in Telegram:
// - Add the bot to the group as an admin
// - Give it permission to restrict members
// - For best results, disable privacy mode in BotFather or make the bot an admin so it can see messages
//
// Notes:
// - Telegram forum-topic messages are identified by message_thread_id.
// - The bot can only restrict permissions at the chat level, not per-topic.
//   So once someone is restricted, the media block applies to the whole group chat.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  throw new Error('Missing BOT_TOKEN environment variable.');
}

const LIMIT = parseInt(process.env.LIMIT || '3', 10);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const bot = new Telegraf(TOKEN);

// Exempt topics by thread ID.
// General is often thread ID 1 in forums, and we also treat missing thread_id as exempt
// so the bot does not count normal non-topic messages.
const DEFAULT_EXEMPT_TOPICS = new Set([1]);

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { exemptTopics: [1], counts: {}, restrictedUsers: {} };
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      exemptTopics: Array.isArray(data.exemptTopics) ? data.exemptTopics : [1],
      counts: data.counts && typeof data.counts === 'object' ? data.counts : {},
      restrictedUsers: data.restrictedUsers && typeof data.restrictedUsers === 'object' ? data.restrictedUsers : {},
    };
  } catch (err) {
    console.error('Failed to load state:', err);
    return { exemptTopics: [1], counts: {}, restrictedUsers: {} };
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

const state = loadState();

function getThreadId(ctx) {
  const threadId = ctx.message?.message_thread_id ?? ctx.channelPost?.message_thread_id ?? null;
  return threadId;
}

function isForumMessage(ctx) {
  return typeof getThreadId(ctx) === 'number';
}

function isExemptTopic(threadId) {
  if (threadId == null) return true;
  return DEFAULT_EXEMPT_TOPICS.has(threadId) || state.exemptTopics.includes(threadId);
}

function getTopicKey(chatId, threadId) {
  return `${chatId}:${threadId ?? 'general'}`;
}

function getUserKey(chatId, userId, threadId) {
  return `${chatId}:${userId}:${threadId ?? 'general'}`;
}

async function applyMediaRestriction(ctx, userId) {
  // Restrict only media, keep text allowed.
  // Telegram permissions are chat-wide.
  await ctx.telegram.restrictChatMember(
    ctx.chat.id,
    userId,
    {
      can_send_messages: true,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: true,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    },
    { use_independent_chat_permissions: true }
  );
}

function incrementVideoCount(chatId, userId, threadId) {
  const key = getUserKey(chatId, userId, threadId);
  const current = state.counts[key] || 0;
  state.counts[key] = current + 1;
  return state.counts[key];
}

function markRestricted(chatId, userId) {
  const key = `${chatId}:${userId}`;
  state.restrictedUsers[key] = true;
}

function isAlreadyRestricted(chatId, userId) {
  return Boolean(state.restrictedUsers[`${chatId}:${userId}`]);
}

// Admin command: show help
bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      'Commands:',
      '/allowtopic - run this while replying inside a topic to exempt that topic',
      '/deltopic - run this while replying inside a topic to remove exemption',
      '/status - show current settings',
      '',
      `Video limit per user per non-exempt topic: ${LIMIT}`,
    ].join('\n')
  );
});

// Admin command: exempt current topic
bot.command('allowtopic', async (ctx) => {
  const threadId = getThreadId(ctx);
  if (threadId == null) {
    return ctx.reply('Reply to a message inside the topic you want to exempt.');
  }
  if (!state.exemptTopics.includes(threadId)) {
    state.exemptTopics.push(threadId);
    saveState();
  }
  return ctx.reply(`Topic ${threadId} is now exempt.`);
});

// Admin command: remove exemption
bot.command('deltopic', async (ctx) => {
  const threadId = getThreadId(ctx);
  if (threadId == null) {
    return ctx.reply('Reply to a message inside the topic you want to remove from exemptions.');
  }
  state.exemptTopics = state.exemptTopics.filter((id) => id !== threadId);
  saveState();
  return ctx.reply(`Topic ${threadId} is no longer exempt.`);
});

bot.command('status', async (ctx) => {
  const exempt = state.exemptTopics.length ? state.exemptTopics.join(', ') : 'none';
  return ctx.reply(`Limit: ${LIMIT}\nExempt topics: ${exempt}`);
});

// Count only video posts in non-exempt forum topics.
bot.on('video', async (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return;

  const threadId = getThreadId(ctx);
  if (isExemptTopic(threadId)) return;

  const newCount = incrementVideoCount(chatId, userId, threadId);
  saveState();

  if (newCount > LIMIT && !isAlreadyRestricted(chatId, userId)) {
    try {
      await applyMediaRestriction(ctx, userId);
      markRestricted(chatId, userId);
      saveState();
      await ctx.reply(
        `User ${ctx.from.first_name} reached the video limit (${LIMIT}). Media is now restricted, text is still allowed.`,
        { reply_to_message_id: ctx.message.message_id }
      );
    } catch (err) {
      console.error('Failed to restrict user:', err);
      await ctx.reply('I could not restrict that user. Check that I am an admin with restrict permissions.');
    }
  }
});

// Optional: log when other media types are posted in restricted topics.
// This does not block them; it just leaves room for future logic.
bot.on(['photo', 'video_note', 'document', 'animation', 'audio'], async () => {
  // No-op on purpose.
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

bot.launch().then(() => {
  console.log(`Bot started. Limit=${LIMIT}. State file: ${STATE_FILE}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
