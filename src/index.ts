import { makeTownsBot } from "@towns-protocol/bot";
import { isDefaultChannelId } from "@towns-protocol/sdk";
import { Hono } from "hono";
import { logger } from "hono/logger";
import commands from "./commands";
import { Database } from "bun:sqlite";
import cron from "node-cron";
import { Filter } from "bad-words";
type UserStats = {
  user_id: string;
  message_count: number;
  reaction_count: number;
};

type BotChannel = {
  id?: number;
  space_id: string;
  channel_id: string;
  last_cron_post?: number;
  scheduled_message?: string;
  cron_enabled?: boolean;
};

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

db.run(`
CREATE TABLE IF NOT EXISTS bot_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  last_cron_post INTEGER,        
  scheduled_message TEXT DEFAULT '🌞 gm everyone!',
  cron_enabled INTEGER DEFAULT 0 -- 0 = false, 1 = true            
);
`);

db.run(`
CREATE TABLE IF NOT EXISTS user_infractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s', 'now')),
  infraction_count INTEGER DEFAULT 1
);
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
const filter = new Filter();

const handlerLogger = (scope: string) => ({
  info: (...args: any[]) => console.log(`[${scope}]`, ...args),
  warn: (...args: any[]) => console.warn(`[${scope}]`, ...args),
  error: (...args: any[]) => console.error(`[${scope}]`, ...args),
});
const messageLogger = handlerLogger("MESSAGE");

//--------------- Slash Commands -------------------//
bot.onSlashCommand("help", async (handler, { channelId }) => {
  await handler.sendMessage(
    channelId,
    "**Available Commands:**\n\n" +
      "• `/help` - Show this help message\n" +
      "• `/leaderboard` - Who is getting rewarded this month? \n\n" +
      "• `/set_gm` - Wake the people up with a bubbly message \n\n" +
      "• Some messages trigger me, so feel free to say hello and see what works. \n",
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
        .all(spaceId) as UserStats[];

      if (topUsers.length === 0) {
        await handler.sendMessage(channelId, "📊 No activity data yet!");
        return;
      }

      const medals = ["🥇", "🥈", "🥉"];
      let leaderboard = "🏆 **Top Contributors**\n\n";

      topUsers.forEach((user: UserStats, index: number) => {
        const medal = medals[index] ?? `${index + 1}.`;

        leaderboard += `${medal} <@${user.user_id}>\n`;
        leaderboard += `   💬 ${user.message_count} messages | ❤️ ${user.reaction_count} reactions\n\n`;

        if (userId.toString() === user.user_id) {
          leaderboard += `   🎉 You are position ${index + 1} with ${user.message_count} messages and ${user.reaction_count} reactions`;
        }
      });
    } catch (error) {
      console.error("Leaderboard error:", error);
      await handler.sendMessage(channelId, "❌ Error fetching leaderboard");
    }
  },
);

bot.onSlashCommand(
  "set_gm",
  async (handler, { spaceId, channelId, userId, args }) => {
    let gm_message = args.join(" ");

    const isAdmin = await handler.hasAdminPermission(userId, spaceId);
    if (!isAdmin) {
      await handler.sendMessage(channelId, "❌ Only admins can schedule gms.");
      return;
    }
    await db.run(
      `
    INSERT INTO bot_channels (space_id, channel_id, scheduled_message, cron_enabled)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(channel_id) DO UPDATE SET cron_enabled = 1
    `,
      [spaceId, channelId, gm_message],
    );

    await handler.sendMessage(
      channelId,
      "✅ We keep the 'gm' rolling every morning!",
    );
  },
);

bot.onSlashCommand("infractions", async (handler, { spaceId, channelId }) => {
  const infractions = db
    .query(
      `SELECT user_id, COUNT(*) as total
       FROM user_infractions
       WHERE space_id = ?
       GROUP BY user_id
       ORDER BY total DESC
       LIMIT 10`,
    )
    .all(spaceId) as { user_id: string; total: number }[];

  if (infractions.length === 0) {
    await handler.sendMessage(channelId, "✅ No infractions logged yet!");
    return;
  }

  let msg = "🚨 **Top Offenders**\n\n";
  for (const row of infractions) {
    msg += `• <@${row.user_id}> — ${row.total} infractions\n`;
  }

  await handler.sendMessage(channelId, msg);
});

//--------------- Bot Listeners -------------------//
bot.onMessage(
  async (
    handler,
    { message, userId, eventId, mentions, channelId, spaceId },
  ) => {
    const isAdmin = handler.hasAdminPermission(userId, spaceId);

    // 1️⃣ Profanity check
    if (filter.isProfane(message)) {
      console.log(`🧹 Profanity detected from ${userId}: "${message}"`);

      // 2️⃣React to the message
      await handler.sendReaction(channelId, eventId, "👎🏾");
      await handler.sendReaction(channelId, eventId, "❌");

      // Add user infraction to db
      db.run(
        `
      INSERT INTO user_infractions (user_id, space_id, message)
      VALUES (?, ?, ?)
    `,
        [userId, spaceId, message],
      );

      // count user's infractions
      const result = db
        .query(
          `SELECT COUNT(*) as count FROM user_infractions WHERE user_id = ? AND space_id = ?`,
        )
        .get(userId, spaceId) as { count: number };

      const totalInfractions = result?.count || 1;

      if (totalInfractions >= 5) {
        await handler.sendMessage(
          channelId,
          `⚠️ <@${userId}>, please avoid using inappropriate language.`,
        );
      }

      if (totalInfractions === 20) {
        await handler.sendMessage(
          channelId,
          `⛔ <@${userId}>, you have been muted for repeated profanity.`,
        );

        try {
          await handler.ban(userId, spaceId);
        } catch (error) {
          console.warn("Mute not supported or failed:", error);
        }
      }

      return;
    }

    try {
      if (!isAdmin) {
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
      }

      if (
        message.toLowerCase().includes("tip") &&
        mentions &&
        mentions.length > 0
      ) {
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
        handleChannelMessage(handler, { message, userId, channelId, spaceId });
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

//---------------------Functions----------------------------//
async function handleChannelMessage(handler: any, event: any) {
  const { message, userId, channelId, spaceId } = event;
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("gm") || lowerMessage.includes("good morning")) {
    await handler.sendMessage(channelId, `GM <@${userId}>! ☀️📸`);
    return;
  }

  if (lowerMessage.includes("gn") || lowerMessage.includes("good night")) {
    await handler.sendMessage(channelId, `Good night <@${userId}>! 🌙📸`);
    return;
  }

  if (lowerMessage.match(/(hello|hi|hey)/)) {
    await handler.sendMessage(channelId, `Hello <@${userId}>! 👋📸`);
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
      `💡 For now, /leaderboard brings up the leaderboard`,
    );
  }
}

async function postCronMessages() {
  const channels = db
    .query(`SELECT * FROM bot_channels WHERE cron_enabled = 1`)
    .all() as BotChannel[];

  const now = Date.now();

  for (const channel of channels) {
    const message = channel.scheduled_message || "🌞 gm everyone!";
    await bot.sendMessage(channel.channel_id, message);

    // Update last post info
    await db.run(
      `UPDATE bot_channels SET last_cron_post = ? WHERE channel_id = ?`,
      [now, channel.channel_id],
    );
  }
}

//---------------------CRON----------------------------//
cron.schedule(
  "0 9 * * *",
  async () => {
    postCronMessages();
  },
  { timezone: "UTC" },
);

export default app;
