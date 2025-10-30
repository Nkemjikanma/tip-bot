import { makeTownsBot } from "@towns-protocol/bot";
import { isDefaultChannelId } from "@towns-protocol/sdk";
import { Hono } from "hono";
import { logger } from "hono/logger";
import commands from "./commands";
import { type Address } from "viem";
import { Database } from "bun:sqlite";

const DB_PATH = process.env.DATABASE_PATH || "./photography.db";
const db = new Database("photography.db");
db.run(`
  CREATE TABLE IF NOT EXISTS user_stats (
    user_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    reaction_count INTEGER DEFAULT 0,
    last_active INTEGER DEFAULT 0
  )
`);

console.log(`✅ Database initialized at: ${DB_PATH}`);

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`;

const bot = await makeTownsBot(
  process.env.APP_PRIVATE_DATA!,
  process.env.JWT_SECRET!,
  {
    commands,
  },
);

const { jwtMiddleware, handler } = bot.start();

const app = new Hono();
app.use(logger());
app.post("/webhook", jwtMiddleware, handler);

const handlerLogger = (scope: string) => ({
  info: (...args: any[]) => console.log(`[${scope}]`, ...args),
  warn: (...args: any[]) => console.warn(`[${scope}]`, ...args),
  error: (...args: any[]) => console.error(`[${scope}]`, ...args),
});
const messageLogger = handlerLogger("MESSAGE");

bot.onSlashCommand("help", async (handler, { channelId }) => {
  await handler.sendMessage(
    channelId,
    "**Available Commands:**\n\n" +
      "• `/help` - Show this help message\n" +
      "• `/leaderboard` - Who is getting rewarded this month? \n\n" +
      "• Some messages trigger me, so feel free to say hello and see what works. \n",
  );
});

bot.onMessage(
  async (
    handler,
    { message, userId, eventId, mentions, channelId, spaceId },
  ) => {
    try {
      db.run(
        `
    INSERT INTO user_stats (user_id, space_id, message_count, last_active)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      message_count = message_count + 1,
      last_active = ?
  `,
        [userId, spaceId, Date.now(), Date.now()],
      );

      if (
        message.toLowerCase().includes("tip") &&
        mentions &&
        mentions.length > 0
      ) {
        const isAdmin = handler.hasAdminPermission(userId, spaceId);

        if (!isAdmin) {
          await handler.sendMessage(
            channelId,
            `❌ <@${userId}>, you need admin permissions to use this command.`,
          );
          return;
        }
        mentions.forEach(async (mention, index) => {
          const sendTipResponse = await handler.sendTip({
            currency: USDC,
            userId: mention.userId as `0x${string}`,
            channelId,
            amount: 1_000_000n,
            messageId: message,
          });

          await handler.sendMessage(
            channelId,
            ` 💸💸 You've been tipped ${mention.displayName} `,
          );
        });
      } else {
        handleChannelMessage(handler, event);
      }
    } catch (error) {
      messageLogger.error("Failed handling message", error, {
        spaceId: spaceId,
        channelId: channelId,
        userId: userId,
        eventId: eventId,
      });
    }
  },
);

bot.onChannelJoin(async (handler, event) => {
  try {
    const { userId, channelId, spaceId } = event;

    // Skip when bot joins channels
    if (userId === bot.botId) {
      console.log("Bot joined a channel");
      return;
    }

    if (isDefaultChannelId(channelId)) {
      // Welcome the new member
      await handler.sendMessage(
        channelId,
        `👋 Welcome <@${userId}>! We're excited to have you here!

We&apos;re excited to have you in our community! Here&apos;s how to get started:

📋 **Getting Started:**
• Explore our channels and join conversations
• Use \`/
          help\` to see available commands
• Check pinned messages for important info
• Introduce yourself when you&apos;re ready!

💡 **Quick Tips:**
• Be respectful and kind to all members
• Ask questions - we&apos;re here to help!
• Have fun and engage with the community

Welcome aboard! 🚀 `,
      );
    }
  } catch (error) {
    messageLogger.error("Failed handling message", error, {
      spaceId: event.spaceId,
      channelId: event.channelId,
      userId: event.userId,
      eventId: event.eventId,
    });
  }
});

bot.onTip(async (handler, event) => {
  const { userId, channelId } = event;

  handler.sendMessage(
    channelId,
    `I see you champ! Keep that coming! ${userId}`,
  );
});

bot.onReaction(async (handler, event) => {
  const { userId, spaceId } = event;

  if (userId === bot.botId) return;

  db.run(
    `
    INSERT INTO user_stats (user_id, space_id, reaction_count, last_active)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      reaction_count = reaction_count + 1,
      last_active = ?
  `,
    [userId, spaceId, Date.now(), Date.now()],
  );
});

bot.onSlashCommand(
  "leaderboard",
  async (handler, { spaceId, channelId, userId }) => {
    try {
      const topUsers = db
        .query(
          `
      SELECT user_id, message_count, reaction_count
      FROM user_stats
      WHERE space_id = ?
      ORDER BY message_count DESC
      LIMIT 10
    `,
        )
        .all(spaceId);

      if (topUsers.length === 0) {
        await handler.sendMessage(channelId, "📊 No activity data yet!");
        return;
      }

      let leaderboard = "🏆 **Top Contributors**\n\n";

      topUsers.forEach((user, index) => {
        const medal =
          index === 0
            ? "🥇"
            : index === 1
              ? "🥈"
              : index === 2
                ? "🥉"
                : `${index + 1}.`;
        leaderboard += `${medal} <@${user.user_id}>\n`;
        leaderboard += `   💬 ${user.message_count} messages | ❤️ ${user.reaction_count} reactions\n\n`;

        if (userId === user.user_id) {
          leaderboard += `   🎉 You are position ${index + 1} with ${user.message_count} messages and ${user.reaction_count} reactions`;
        }
      });
    } catch (error) {
      console.error("Leaderboard error:", error);
      await handler.sendMessage(channelId, "❌ Error fetching leaderboard");
    }
  },
);

async function handleChannelMessage(handler: any, event: any) {
  const { message, userId, channelId, spaceId } = event;
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("gm") || lowerMessage.includes("good morning")) {
    await handler.sendMessage(channelId, `GM <@\${userId}>! ☀️📸\\`);
    return;
  }

  if (lowerMessage.includes("gn") || lowerMessage.includes("good night")) {
    await handler.sendMessage(channelId, `Good night <@\${userId}>! 🌙📸\\`);
    return;
  }

  if (lowerMessage.match(/(hello|hi|hey)/)) {
    await handler.sendMessage(channelId, `Hello <@\${userId}>! 👋📸\\`);
    return;
  }

  if (lowerMessage.includes("wagmi")) {
    await handler.sendReaction(channelId, event.eventId, "🚀");
    return;
  }

  if (lowerMessage.includes("moon")) {
    await handler.sendReaction(channelId, event.eventId, "🌙");
    return;
  }

  if (lowerMessage.includes("bot help") || lowerMessage.includes("!help")) {
    await handler.sendMessage(
      channelId,
      `💡 For now, the only available command involves mentioning me with a "tip" in the sentence`,
    );
  }
}

export default app;
