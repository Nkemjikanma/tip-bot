import { makeTownsBot } from "@towns-protocol/bot";
import { isDefaultChannelId } from "@towns-protocol/sdk";
import { Hono } from "hono";
import { logger } from "hono/logger";
import commands from "./commands";
import { Database } from "bun:sqlite";
import cron from "node-cron";
import { Filter } from "bad-words";
import { getBotUsdcBalance, networkURL, USDC_ADDRESS } from "./utils";
import { readContract } from "viem/actions";
import { erc20Abi } from "viem";
import { SpaceAddressFromSpaceId } from "@towns-protocol/web3";

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

// User infractions - eg usuing bad words
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

// Weekly Challenges
db.run(`
CREATE TABLE IF NOT EXISTS photo_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  theme TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  active INTEGER DEFAULT 1
);
`);

// Weekly challenge  entries
db.run(`
CREATE TABLE IF NOT EXISTS challenge_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reaction_count INTEGER DEFAULT 0,
  FOREIGN KEY(challenge_id) REFERENCES photo_challenges(id)
);
`);

// Challenge winners
db.run(`
CREATE TABLE IF NOT EXISTS challenge_winners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER,
  user_id TEXT,
  reaction_count INTEGER,
  prize_amount INTEGER,
  timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);
`);

console.log(`✅ Database initialized at: ${DB_PATH}`);

const bot = await makeTownsBot(
  process.env.APP_PRIVATE_DATA!,
  process.env.JWT_SECRET!,
  {
    commands,
    baseRpcUrl: networkURL,
  },
);

const { jwtMiddleware, handler } = bot.start();

const PHOTOGRAPHY_CHANNEL = "0x16c26e46624ebfd0929c0b0a2d0f51ff1514eb31";
const app = new Hono();
app.use(logger());
app.post("/webhook", jwtMiddleware, handler);
const filter = new Filter();

const balance = await readContract(bot.viem, {
  address: USDC_ADDRESS,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: ["0xa384291B9A555Dd904743BE86fd95834c89EC007"],
});
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
      "• `/infractions` - Who has been messing up? \n\n" +
      "• `/challenge_start` - ADMIN ONLY - Start weekly challenge \n\n" +
      "• `/challenge_end` - ADMIN ONLY - End weekly challenge \n\n" +
      "• `/challenge_current` - Show current challenge(s) \n\n" +
      "• `/set_gm` - ADMIN ONLY - Wake the people up with a bubbly message \n\n" +
      "• `/challenge_winners` - See list of all challenge winners \n\n" +
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

bot.onSlashCommand(
  "challenge_start",
  async (handler, { spaceId, channelId, userId, args }) => {
    const isAdmin = await handler.hasAdminPermission(userId, spaceId);
    if (!isAdmin) {
      await handler.sendMessage(
        channelId,
        "❌ Only admins can start challenges.",
      );
      return;
    }

    const theme = args.join(" ");
    if (!theme) {
      await handler.sendMessage(
        channelId,
        "⚠️ Please specify a theme, e.g. `/challenge_start Reflections`",
      );
      return;
    }

    const now = Date.now();
    const end = now + 7 * 24 * 60 * 60 * 1000; // 7 days later

    db.run(
      `INSERT INTO photo_challenges (space_id, channel_id, theme, start_time, end_time, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
      [spaceId, channelId, theme, now, end],
    );

    await handler.sendMessage(
      channelId,
      `📸 **New Weekly Photo Challenge!**\n\nTheme: *${theme}*\n\nPost your photos with **#weeklychallenge** this week! ❤️`,
    );
  },
);

bot.onSlashCommand(
  "challenge_end",
  async (handler, { spaceId, channelId, userId }) => {
    const isAdmin = await handler.hasAdminPermission(userId, spaceId);
    if (!isAdmin) {
      await handler.sendMessage(
        channelId,
        "❌ Only admins can end challenges.",
      );
      return;
    }

    db.run(
      `UPDATE photo_challenges SET active = 0 WHERE space_id = ? AND active = 1`,
      [spaceId],
    );

    await handler.sendMessage(
      channelId,
      `✅ The current photo challenge has been closed for submissions.`,
    );
  },
);

bot.onSlashCommand(
  "challenge_current",
  async (handler, { spaceId, channelId }) => {
    const challenge = db
      .query(
        `SELECT theme, end_time FROM photo_challenges WHERE space_id = ? AND active = 1 LIMIT 1`,
      )
      .get(spaceId) as { theme: string; end_time: number } | undefined;

    if (!challenge) {
      await handler.sendMessage(channelId, "📷 No active challenge right now!");
      return;
    }

    const daysLeft = Math.ceil(
      (challenge.end_time - Date.now()) / (1000 * 60 * 60 * 24),
    );
    await handler.sendMessage(
      channelId,
      `🗓️ Current theme: *${challenge.theme}* (${daysLeft} days left)`,
    );
  },
);

bot.onSlashCommand("challenge_winners", async (handler, event) => {
  try {
    const rows = db
      .query(
        `
        SELECT cw.*, pc.theme
        FROM challenge_winners cw
        LEFT JOIN photo_challenges pc ON cw.challenge_id = pc.id
        ORDER BY cw.timestamp DESC
        LIMIT 5
        `,
      )
      .all() as {
      user_id: string;
      theme: string;
      prize_amount: number;
      timestamp: number;
    }[];

    if (rows.length === 0) {
      await handler.sendMessage(
        event.channelId,
        "🏆 No photo challenge winners yet! Participate this week to become the first!",
      );
      return;
    }

    const messageLines = rows.map((row, i) => {
      const date = new Date(row.timestamp * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });

      return `**${i + 1}.** <@${row.user_id}> — *${row.theme || "Unknown theme"}*  
💰 ${Number(row.prize_amount) / 1_000_000} USDC — 🗓 ${date}`;
    });

    await handler.sendMessage(
      event.channelId,
      "📸 **Photo Challenge Hall of Fame**\n\n" + messageLines.join("\n\n"),
    );
  } catch (err) {
    console.error("Error fetching winners:", err);
    await handler.sendMessage(
      event.channelId,
      "⚠️ Couldn't fetch winners right now. Please try again later.",
    );
  }
});

//--------------- Bot Listeners -------------------//
bot.onMessage(
  async (
    handler,
    { message, userId, eventId, mentions, channelId, spaceId },
  ) => {
    const isAdmin = handler.hasAdminPermission(userId, spaceId);
    if (checkIsPhotography(spaceId)) {
      try {
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
        if (!isAdmin) {
          // 🏁 Check if there's an active challenge
          const activeChallenge = db
            .query(
              `SELECT id FROM photo_challenges WHERE space_id = ? AND active = 1 LIMIT 1`,
            )
            .get(spaceId) as { id: number } | undefined;

          if (activeChallenge && message.includes("#weeklychallenge")) {
            db.run(
              `INSERT INTO challenge_entries (challenge_id, user_id, message_id)
     VALUES (?, ?, ?)`,
              [activeChallenge.id, userId, eventId],
            );

            await handler.sendMessage(
              channelId,
              `✅ <@${userId}> entered this week's challenge! Good luck! 📷`,
            );
          }

          // Keep track of user stats
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

        // "0x@Tip Bot tip @Hikki"
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

          const tipAmount = 1_000_000n;

          if (balance < tipAmount) {
            await handler.sendMessage(
              channelId,
              "⚠️ I don’t have enough USDC to send a tip.",
            );
            return;
          }

          if (BigInt(balance) < tipAmount) {
            await handler.sendMessage(
              channelId,
              "⚠️ I don’t have enough USDC to send a tip.",
            );
            return;
          }

          // TODO: // Check bot balance
          for (const mention of mentions) {
            await bot.sendTip({
              currency: USDC_ADDRESS,
              userId: mention.userId as `0x${string}`,
              channelId,
              amount: 1_000_000n,
              messageId: eventId,
            });

            await handler.sendMessage(
              channelId,
              ` 💸💸 You've been tipped ${mention.displayName} `,
            );
          }
        } else {
          handleChannelMessage(handler, {
            message,
            userId,
            channelId,
            spaceId,
          });
        }
      } catch (error) {
        messageLogger.error("Failed handling message", error, {
          spaceId: spaceId,
          channelId: channelId,
          userId: userId,
          eventId: eventId,
        });
      }
    } else {
      return;
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
  const { userId, spaceId, messageId } = event;

  if (userId === bot.botId) return;
  // Track reactions for challenges
  db.run(
    `UPDATE challenge_entries
     SET reaction_count = reaction_count + 1
     WHERE message_id = ?`,
    [messageId],
  );

  // user activity stats
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

  if (
    (lowerMessage.includes("bot") && lowerMessage.includes("gm")) ||
    (lowerMessage.includes("bot") && lowerMessage.includes("good morning"))
  ) {
    await handler.sendMessage(channelId, `GM <@${userId}>! ☀️📸`);
    return;
  }

  if (
    (lowerMessage.includes("bot") && lowerMessage.includes("gn")) ||
    (lowerMessage.includes("bot") && lowerMessage.includes("good night"))
  ) {
    await handler.sendMessage(channelId, `Good night <@${userId}>! 🌙📸`);
    return;
  }

  if (lowerMessage.match(/(hello|hi|hey bot)/)) {
    await handler.sendMessage(channelId, `Hello <@${userId}>! 👋📸`);
    return;
  }

  if (lowerMessage.includes("bot") && lowerMessage.includes("wagmi")) {
    await handler.sendReaction(channelId, event.eventId, "🚀");
    return;
  }

  if (lowerMessage.includes("bot") && lowerMessage.includes("moon")) {
    await handler.sendReaction(channelId, event.eventId, "🌙");
    return;
  }

  if (
    (lowerMessage.includes("bot") && lowerMessage.includes("help")) ||
    lowerMessage.includes("!help")
  ) {
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

async function announceWeeklyWinner() {
  const endedChallenges = db
    .query(
      `
      SELECT * FROM photo_challenges
      WHERE active = 1 AND end_time <= ?
    `,
    )
    .all(Date.now()) as {
    id: number;
    channel_id: string;
    theme: string;
    space_id: string;
  }[];

  for (const challenge of endedChallenges) {
    const topEntry = db
      .query(
        `
        SELECT user_id, reaction_count
        FROM challenge_entries
        WHERE challenge_id = ?
        ORDER BY reaction_count DESC
        LIMIT 1
      `,
      )
      .get(challenge.id) as
      | { user_id: string; reaction_count: number }
      | undefined;

    if (topEntry) {
      const { user_id, reaction_count } = topEntry;
      const tipAmount = 5_000_000n; // 5 USDC

      try {
        // 💸 Send the tip
        await bot.sendTip({
          currency: USDC_ADDRESS,
          userId: user_id as `0x${string}`,
          channelId: challenge.channel_id,
          amount: tipAmount,
          messageId: `challenge-${challenge.id}`,
        });

        //  Announce the winner
        await bot.sendMessage(
          challenge.channel_id,
          `🏆 **Photo of the Week — Theme: ${challenge.theme}** 🏆\n\n` +
            `<@${user_id}> wins with ${reaction_count} reactions!\n\n` +
            `💰 **Prize:** 5 USDC sent on-chain!`,
        );
      } catch (error) {
        console.error("Error tipping challenge winner:", error);
        await bot.sendMessage(
          challenge.channel_id,
          `⚠️ Could not send tip to <@${user_id}>. Please check the bot’s permissions or wallet balance.`,
        );
      }
    } else {
      await bot.sendMessage(
        challenge.channel_id,
        `📸 The challenge "${challenge.theme}" ended with no entries this week.`,
      );
    }

    db.run(`UPDATE photo_challenges SET active = 0 WHERE id = ?`, [
      challenge.id,
    ]);
  }
}

const checkIsPhotography = (spaceId: string) => {
  if (SpaceAddressFromSpaceId(spaceId)) return true;

  return false;
};
//---------------------CRON----------------------------//
cron.schedule(
  "0 9 * * *",
  async () => {
    postCronMessages();
  },
  { timezone: "UTC" },
);

cron.schedule(
  "0 23 * * SUN",
  async () => {
    console.log("📅 Running weekly challenge results...");
    await announceWeeklyWinner();
  },
  { timezone: "UTC" },
);

export default app;
