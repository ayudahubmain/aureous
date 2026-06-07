// Cloudflare Worker Telegram bot: forum-topic video limiter
//
// What this Worker does:
// - Receives Telegram updates via webhook
// - Exempts selected topics (for example General / Chatroom / Request)
// - Counts only VIDEO messages in non-exempt topics
// - When a user passes the limit, restricts that user so text is still allowed
//   but media (videos/photos/documents/etc.) is blocked at the chat level
//
// Cloudflare setup needed:
// 1) Add a KV namespace binding named STATE
// 2) Add secrets / vars in Worker settings:
//    - BOT_TOKEN (secret)
//    - WEBHOOK_SECRET (secret, any random string)
//    - LIMIT (var, example: 3)
//    - EXEMPT_TOPICS (var, optional CSV topic ids, example: 1,12,34)
//
// Important Telegram notes:
// - The bot must be an admin in the supergroup and have permission to restrict members
// - Telegram forum topics are identified by message_thread_id
// - The General topic can be exempted by putting its thread id in EXEMPT_TOPICS
// - This code uses a webhook, which is the correct model for Cloudflare Workers

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers || {}) },
  });
}

function text(body, init = {}) {
  return new Response(body, { ...init, headers: init.headers || {} });
}

function parseCsvIds(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
}

function getThreadId(message) {
  return typeof message?.message_thread_id === 'number' ? message.message_thread_id : null;
}

function getLimit(env) {
  const n = Number(env.LIMIT ?? 3);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

function getExemptTopics(env) {
  // Add your topic IDs here in the dashboard, e.g. "1,12,34"
  return new Set(parseCsvIds(env.EXEMPT_TOPICS));
}

function isExemptTopic(threadId, exemptSet) {
  // Messages not inside a topic are treated as exempt
  if (threadId == null) return true;
  return exemptSet.has(threadId);
}

async function telegram(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok || !data?.ok) {
    const desc = data?.description || `HTTP ${res.status}`;
    throw new Error(`${method} failed: ${desc}`);
  }

  return data.result;
}

async function kvGetJSON(env, key) {
  const raw = await env.STATE.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function kvPutJSON(env, key, value) {
  await env.STATE.put(key, JSON.stringify(value));
}

function countKey(chatId, userId, threadId) {
  return `count:${chatId}:${userId}:${threadId ?? 'general'}`;
}

function restrictedKey(chatId, userId) {
  return `restricted:${chatId}:${userId}`;
}

async function isAdmin(env, chatId, userId) {
  const member = await telegram(env, 'getChatMember', {
    chat_id: chatId,
    user_id: userId,
  });
  return ['creator', 'administrator'].includes(member.status);
}

async function restrictMediaOnly(env, chatId, userId) {
  await telegram(env, 'restrictChatMember', {
    chat_id: chatId,
    user_id: userId,
    permissions: {
      can_send_messages: true,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: true,
      can_send_other_messages: false,
      can_add_web_page_previews: true,
    },
    use_independent_chat_permissions: true,
  });
}

async function handleMessage(env, message) {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  if (!chatId || !userId) return;

  const threadId = getThreadId(message);
  const exemptSet = getExemptTopics(env);
  const limit = getLimit(env);

  // Admin commands for manual control.
  const textValue = typeof message.text === 'string' ? message.text.trim() : '';
  if (textValue === '/status') {
    const admin = await isAdmin(env, chatId, userId);
    const counts = await env.STATE.list({ prefix: `count:${chatId}:` });
    return { reply: admin ? `Limit: ${limit}\nKV count keys: ${counts.keys.length}` : 'Limit: hidden' };
  }

  if (textValue === '/allowtopic' || textValue === '/deltopic') {
    const admin = await isAdmin(env, chatId, userId);
    if (!admin) return { reply: 'Admin only.' };
    if (threadId == null) return { reply: 'Open the command inside the topic you want to change.' };

    const list = parseCsvIds(env.EXEMPT_TOPICS);
    const set = new Set(list);
    if (textValue === '/allowtopic') set.add(threadId);
    if (textValue === '/deltopic') set.delete(threadId);

    await kvPutJSON(env, 'config:exempt_topics', [...set]);
    return { reply: `Saved topic ${threadId}.` };
  }

  // Apply runtime override from KV if you use the commands above.
  const savedExempt = await kvGetJSON(env, 'config:exempt_topics');
  const runtimeExemptSet = Array.isArray(savedExempt)
    ? new Set(savedExempt.map((n) => Number(n)).filter((n) => Number.isInteger(n)))
    : exemptSet;

  if (message.video && !isExemptTopic(threadId, runtimeExemptSet)) {
    const key = countKey(chatId, userId, threadId);
    const current = (await kvGetJSON(env, key)) || { count: 0 };
    current.count += 1;
    await kvPutJSON(env, key, current);

    if (current.count > limit) {
      const rKey = restrictedKey(chatId, userId);
      const already = await kvGetJSON(env, rKey);
      if (!already) {
        await restrictMediaOnly(env, chatId, userId);
        await kvPutJSON(env, rKey, { restricted: true, at: Date.now(), threadId });
        return { reply: `User reached the video limit (${limit}). Media is now restricted.` };
      }
    }
  }

  return { reply: null };
}

async function setWebhookIfRequested(env, url) {
  const hookUrl = url instanceof URL ? url : new URL(url);
  const endpoint = `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      url: `${hookUrl.origin}/webhook/${env.WEBHOOK_SECRET}`,
      secret_token: env.WEBHOOK_SECRET,
      drop_pending_updates: true,
      allowed_updates: ['message'],
    }),
  });
  return await res.json();
}

export default {
  async fetch(request, env, ctx) {
    if (!env.BOT_TOKEN) return text('Missing BOT_TOKEN', { status: 500 });
    if (!env.WEBHOOK_SECRET) return text('Missing WEBHOOK_SECRET', { status: 500 });
    if (!env.STATE) return text('Missing KV binding STATE', { status: 500 });

    const url = new URL(request.url);

    // Simple health check.
    if (request.method === 'GET' && url.pathname === '/') {
      return text('ok');
    }

    // One-time webhook setup route.
    // Visit /set-webhook?secret=YOUR_SETUP_SECRET (or just use it after deployment).
    if (request.method === 'GET' && url.pathname === '/set-webhook') {
      const secret = url.searchParams.get('secret');
      const setupSecret = env.SETUP_SECRET || env.WEBHOOK_SECRET;
      if (secret !== setupSecret) return text('forbidden', { status: 403 });
      const result = await setWebhookIfRequested(env, url);
      return json(result);
    }

    // Telegram webhook endpoint.
    if (request.method === 'POST' && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      const secretHeader = request.headers.get('x-telegram-bot-api-secret-token');
      if (secretHeader !== env.WEBHOOK_SECRET) {
        return text('forbidden', { status: 403 });
      }

      const update = await request.json();
      const message = update?.message;
      if (message) {
        try {
          const result = await handleMessage(env, message);
          if (result?.reply) {
            await telegram(env, 'sendMessage', {
              chat_id: message.chat.id,
              message_thread_id: getThreadId(message) ?? undefined,
              text: result.reply,
            });
          }
        } catch (err) {
          console.error('update handling failed:', err);
        }
      }

      return text('ok');
    }

    return text('not found', { status: 404 });
  },
};
