import express from 'express';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { nanoid } from 'nanoid';
import mongoose from 'mongoose';
import moment from 'moment';
import fs from 'fs';
import cron from 'node-cron';

dotenv.config();
const app = express();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);

const ALLOWED_USERS = ['615764917', '499127006']; // update if needed
const ADMIN_ID = process.env.ADMIN_ID!;

// ========== MongoDB connection ==========
mongoose
  .connect(process.env.MONGO_URL as string, {})
  .then(() => {
    console.log('✅ MongoDB connected');

    const PORT = process.env.PORT ?? 3003;
    app.listen(PORT, () => {
      console.info(`🚀 Server running on port: ${PORT}`);
      console.info(`🌐 Admin: http://localhost:${PORT}\n`);
    });

    bot.launch();
    console.log('🤖 Bot running...');

    bot.telegram.setMyCommands([
      { command: 'add', description: 'Add money entry' },
      { command: 'balance', description: 'View balance' },
      { command: 'list', description: 'Show entries' },
      { command: 'clear', description: 'Clear all entries (approval required)' },
      { command: 'cancel', description: 'Cancel current operation' },
      // { command: 'delete', description: 'Delete an entry by ID' },
    ]);

    // ========== SCHEDULED AUTO-CLEAR ==========
    // Runs at 23:55 Asia/Seoul on days 10, 20, 30 of every month
    cron.schedule(
      '55 23 10,20,30 * *',
      async () => {
        try {
          await sendMonthlyReportAndClear();
        } catch (err) {
          console.error('❌ Auto-clear job failed:', err);
          try {
            await bot.telegram.sendMessage(
              ADMIN_ID,
              `❌ Auto-clear job failed: ${err instanceof Error ? err.message : String(err)}`
            );
          } catch {}
        }
      },
      { timezone: 'Asia/Seoul' }
    );
  })
  .catch((err) => console.error('❌ MongoDB connection error', err));

// ========== Schemas & Models ==========

type UserName = 'Sheyx' | 'Polvon';
type SessionName = UserName | 'Umumiy' | null;
type Mode = 'debt' | 'expenses' | null;

interface IEntry {
  id: string;
  name: UserName;
  amount: number;
  note: string;
  time: Date;
}

interface ISession {
  userId: string;
  name: SessionName;
  mode: Mode;
}

const entrySchema = new mongoose.Schema<IEntry>({
  id: { type: String, required: true },
  name: { type: String, enum: ['Sheyx', 'Polvon'], required: true },
  amount: { type: Number, required: true },
  note: { type: String, default: '' },
  time: { type: Date, required: true },
});

const sessionSchema = new mongoose.Schema<ISession>({
  userId: { type: String, required: true, unique: true },
  name: { type: String, enum: ['Sheyx', 'Polvon', 'Umumiy', null], default: null },
  mode: { type: String, enum: ['debt', 'expenses', null], default: null },
});

const Entry = mongoose.model<IEntry>('Entry', entrySchema);
const Session = mongoose.model<ISession>('Session', sessionSchema);

// ========== Helpers (parsing/formatting + report) ==========

function parseKrwAmount(raw: string): number | null {
  if (!raw) return null;
  // allow: 100000, 100.000, 100,000, 100 000, 100_000
  const cleaned = raw.replace(/[.,\s_]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const value = parseInt(cleaned, 10);
  return Number.isFinite(value) ? value : null;
}

function formatKRW(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

async function getBalances() {
  const entries = await Entry.find();
  const balances: Record<UserName, number> = { Sheyx: 0, Polvon: 0 };
  entries.forEach((e) => {
    balances[e.name] += e.amount;
  });
  return { balances, entries };
}

function formatKST(date: Date | string | number) {
  return moment(date).utcOffset(9).format('YYYY-MM-DD HH:mm');
}

function buildDetailedReportText(entries: IEntry[], balances: Record<UserName, number>) {
  // newest first globally
  const sorted = [...entries].sort((a, b) => b.time.getTime() - a.time.getTime());

  // group by person in fixed order
  const order: UserName[] = ['Sheyx', 'Polvon'];
  const grouped: Record<UserName, IEntry[]> = { Sheyx: [], Polvon: [] };
  sorted.forEach((e) => grouped[e.name].push(e));

  const now = formatKST(new Date());

  let txt =
    `🧾 Auto-clear report (Asia/Seoul)\n` +
    `Date/Time: ${now}\n\n`;

  for (const name of order) {
    txt += `👤 ${name}\n\n`;
    const list = grouped[name];
    if (list.length === 0) {
      continue;
    }
    list.forEach((entry, idx) => {
      txt += `${idx + 1}.  👤 ${name}\n`;
      txt += `💵 ${formatKRW(entry.amount)}₩\n`;
      txt += `📝 ${entry.note?.trim() ? entry.note : 'No note'}\n`;
      txt += `🕒 ${formatKST(entry.time)}\n\n`;
    });
  }

  txt += `Balances BEFORE clearing:\n`;
  txt += `• Sheyx: ${formatKRW(balances.Sheyx)}₩\n`;
  txt += `• Polvon: ${formatKRW(balances.Polvon)}₩\n`;

  return txt;
}

async function sendMonthlyReportAndClear() {
  const { balances, entries } = await getBalances();

  const fileContent = buildDetailedReportText(entries, balances);
  const filePath = 'last_entries.txt'; // exact filename you wanted
  fs.writeFileSync(filePath, fileContent, { encoding: 'utf8' });

  // send file to everyone
  for (const uid of ALLOWED_USERS) {
    try {
      await bot.telegram.sendDocument(uid, { source: filePath });
    } catch (e) {
      console.error('Failed to send report to', uid, e);
    }
  }

  // clear all
  await Entry.deleteMany({});

  // notify
  const doneMsg = `🧹 Auto-clear completed. All entries have been cleared.`;
  for (const uid of ALLOWED_USERS) {
    try {
      await bot.telegram.sendMessage(uid, doneMsg);
    } catch (e) {
      console.error('Failed to send completion to', uid, e);
    }
  }
}

// ========== Middleware (auth) ==========

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id);
  if (!ALLOWED_USERS.includes(userId)) {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `🚨 Unauthorized Access Attempt\n👤 User: ${ctx.from?.username} (${ctx.from?.id})\nMessage: ${
        ctx.message && 'text' in ctx.message ? ctx.message.text : 'Unknown'
      }`
    );
    return ctx.reply('🚫 You are not authorized to use this bot.');
  }
  return next();
});

// ========== Commands ==========

bot.start((ctx) => {
  ctx.reply(
    `👋 Welcome!\n\n` +
      `• /add – add an entry\n` +
      `• /balance – view balances\n` +
      `• /list – show entries\n` +
      `• /clear – clear all entries (needs approval)\n` +
      `• /cancel – cancel current operation`
  );
});

bot.command('add', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    await Session.findOneAndUpdate({ userId }, { name: null, mode: null }, { upsert: true });

    await ctx.reply(
      'Who is adding money?',
      Markup.inlineKeyboard([
        [Markup.button.callback('Sheyx', 'choose_Sheyx')],
        [Markup.button.callback('Polvon', 'choose_Polvon')],
        [Markup.button.callback('Umumiy (Split equally)', 'choose_Umumiy')],
        [Markup.button.callback('❌ Cancel', 'choose_cancel')],
      ])
    );
  } catch (error) {
    console.error('Error during /add:', error);
    ctx.reply('❌ An error occurred while processing your request.');
  }
});

bot.action('choose_Umumiy', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    await Session.findOneAndUpdate({ userId }, { name: 'Umumiy', mode: null }, { upsert: true });
    await ctx.reply(
      `💬 Enter the TOTAL amount and note.\n` +
        `It will be split 50/50 between *Sheyx* and *Polvon*.\n` +
        `Example: \`50.000 snacks\` (same as 50000)\n` +
        `Or type /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery();
  } catch (error) {
    console.error('Error during choose_Umumiy:', error);
    ctx.reply('❌ An error occurred while processing your request.');
    await ctx.answerCbQuery();
  }
});

bot.action('choose_cancel', async (ctx) => {
  const userId = String(ctx.from?.id);
  await Session.findOneAndUpdate({ userId }, { name: null, mode: null });
  await ctx.reply('Operation cancelled.');
  await ctx.answerCbQuery();
});

bot.command('cancel', async (ctx) => {
  const userId = String(ctx.from?.id);
  await Session.findOneAndUpdate({ userId }, { name: null, mode: null });
  ctx.reply('Operation cancelled.');
});

// Choose person → then choose mode
bot.action(/choose_(Sheyx|Polvon)/, async (ctx) => {
  const userId = String(ctx.from?.id);
  const chosenName = ctx.match[1] as UserName;

  await Session.findOneAndUpdate({ userId }, { name: chosenName, mode: null }, { upsert: true });

  await ctx.reply(
    `Choose the type for ${chosenName}:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💳 Expenses (split 50/50)', 'type_expenses')],
      [Markup.button.callback('📌 Debt (single entry)', 'type_debt')],
      [Markup.button.callback('❌ Cancel', 'choose_cancel')],
    ])
  );
  await ctx.answerCbQuery();
});

bot.action('type_expenses', async (ctx) => {
  const userId = String(ctx.from?.id);
  const sess = await Session.findOne({ userId });
  const who = sess?.name ?? 'the selected person';

  await Session.findOneAndUpdate({ userId }, { mode: 'expenses' });
  await ctx.reply(
    `💬 Enter the TOTAL amount and note.\n` +
      `I will split it 50/50 and **record only ${who}'s half**.\n` +
      `Example: \`50.000 lunch\` (same as 50000)\nOr type /cancel to abort.`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCbQuery();
});

bot.action('type_debt', async (ctx) => {
  const userId = String(ctx.from?.id);
  await Session.findOneAndUpdate({ userId }, { mode: 'debt' });
  await ctx.reply(
    `💬 Enter the amount and note for the selected person.\n` +
      `Example: \`30.000 borrowed\` (same as 30000)\nOr type /cancel to abort.`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCbQuery();
});

// ========== Balance ==========

bot.command('balance', async (ctx) => {
  await ctx.reply(
    'Choose whose balance to view:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Sheyx', 'balance_Sheyx')],
      [Markup.button.callback('Polvon', 'balance_Polvon')],
      [Markup.button.callback('Total Balance', 'balance_total')],
    ])
  );
});

bot.action('balance_total', async (ctx) => {
  try {
    const { balances } = await getBalances();
    await ctx.reply(
      `💰 Balance:\n` +
        `• Sheyx: ${formatKRW(balances.Sheyx)}₩\n` +
        `• Polvon: ${formatKRW(balances.Polvon)}₩`
    );
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('Error calculating balance:', err);
    await ctx.reply('❌ Error fetching balance.');
    await ctx.answerCbQuery();
  }
});

bot.action(/balance_(Sheyx|Polvon)/, async (ctx) => {
  const name = ctx.match[1] as UserName;

  try {
    const entries = await Entry.find({ name }).sort({ time: -1 });
    if (entries.length === 0) {
      await ctx.reply(`No entries found for ${name}.`);
      return ctx.answerCbQuery();
    }

    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    let message = `💰 ${name}'s Total: ${formatKRW(total)}₩\n\n📝 Entries:\n`;
    entries.forEach((entry) => {
      message += `🔹 ${formatKRW(entry.amount)}₩ - ${entry.note || 'No note'} (${moment(entry.time).format('YYYY-MM-DD HH:mm')})\n`;
    });

    await ctx.reply(message);
    await ctx.answerCbQuery();
  } catch (err) {
    console.error(`Error fetching ${name}'s entries:`, err);
    await ctx.reply('❌ Error fetching entries.');
    await ctx.answerCbQuery();
  }
});

// ========== List ==========

bot.command('list', async (ctx) => {
  await ctx.reply(
    'Choose whose entries to view:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Sheyx', 'list_Sheyx')],
      [Markup.button.callback('Polvon', 'list_Polvon')],
      [Markup.button.callback('All Entries', 'list_all')],
    ])
  );
});

bot.action(/list_(Sheyx|Polvon)/, async (ctx) => {
  const name = ctx.match[1] as UserName;

  try {
    const entries = await Entry.find({ name }).sort({ time: -1 });

    if (entries.length === 0) {
      await ctx.reply(`📭 No entries found for ${name}.`);
      return ctx.answerCbQuery();
    }

    let message = `📄 Entries for ${name}:\n\n`;
    entries.forEach((entry, index) => {
      message += `${index + 1}. 💵 ${formatKRW(entry.amount)}₩\n  📝 ${entry.note || 'No note'}\n  🕒 ${moment(entry.time).format('YYYY-MM-DD HH:mm')}\n\n`;
    });

    const chunks = message.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error(`❌ Error fetching entries for ${name}:`, err);
    await ctx.reply('❌ Error fetching entries.');
    await ctx.answerCbQuery();
  }
});

bot.action('list_all', async (ctx) => {
  try {
    const entries = await Entry.find().sort({ time: -1 });

    if (entries.length === 0) {
      await ctx.reply('📭 No entries found.');
      return ctx.answerCbQuery();
    }

    let message = `📜 All Entries:\n\n`;
    entries.forEach((entry) => {
      message += `👤 ${entry.name}\n 💵 ${formatKRW(entry.amount)}₩\n 📝 ${entry.note || 'No note'}\n 🕒 ${moment(entry.time).format('YYYY-MM-DD HH:mm')}\n\n`;
    });

    const chunks = message.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error('❌ Error fetching all entries:', err);
    await ctx.reply('❌ Error fetching all entries.');
    await ctx.answerCbQuery();
  }
});

// ========== Clear (with approval) ==========

bot.command('clear', async (ctx) => {
  const userId = String(ctx.from?.id);

  if (!ALLOWED_USERS.includes(userId)) {
    return ctx.reply("🚫 You're not authorized.");
  }

  try {
    // Build a mini report of the last 4 entries for audit before approval
    const { balances, entries } = await getBalances();
    const recent = [...entries].sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 4);
    const previewText = buildDetailedReportText(recent, balances);
    const filePath = 'last_entries.txt';
    fs.writeFileSync(filePath, previewText, { encoding: 'utf8' });
    await bot.telegram.sendDocument(ADMIN_ID, { source: filePath });

    const otherUserId = ALLOWED_USERS.find((uid) => uid !== userId);
    await bot.telegram.sendMessage(
      otherUserId!,
      `⚠️ User ${ctx.from?.username} is requesting to clear all entries. Do you approve?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve', 'approve_clear')],
        [Markup.button.callback('❌ Deny', 'deny_clear')],
      ])
    );

    await ctx.reply('🔔 Request to clear entries has been sent to the other user for approval.');
  } catch (err) {
    console.error('❌ Error before clearing:', err);
    await ctx.reply('❌ Error preparing report before clearing.');
  }
});

bot.action('approve_clear', async (ctx) => {
  const userId = String(ctx.from?.id);

  if (!ALLOWED_USERS.includes(userId)) {
    return ctx.reply("🚫 You're not authorized.");
  }

  await Entry.deleteMany({});
  await ctx.reply('🧹 All entries have been cleared.');

  const otherUserId = ALLOWED_USERS.find((uid) => uid !== userId);
  if (otherUserId) {
    await bot.telegram.sendMessage(otherUserId, '🧹 The entries have been cleared.');
  }
});

bot.action('deny_clear', async (ctx) => {
  const userId = String(ctx.from?.id);
  if (!ALLOWED_USERS.includes(userId)) return ctx.reply("🚫 You're not authorized.");

  const otherUserId = ALLOWED_USERS.find((uid) => uid !== userId);
  await bot.telegram.sendMessage(otherUserId!, '❌ The request to clear entries was denied by the other user.');
  await ctx.reply('❌ Your request to clear entries has been denied.');
});

// ========== Delete by ID (admin only) ==========

bot.command('delete', async (ctx) => {
  const userId = String(ctx.from?.id);
  const messageParts = ctx.message.text.split(' ');

  if (messageParts.length !== 2) {
    return ctx.reply('❌ Usage: /delete <entry_id>\nExample: `/delete abc123`', {
      parse_mode: 'Markdown',
    });
  }

  const entryId = messageParts[1];
  const entry = await Entry.findOne({ id: entryId });

  if (!entry) {
    return ctx.reply(`❌ Entry with ID \`${entryId}\` not found.`, { parse_mode: 'Markdown' });
  }

  if (!ALLOWED_USERS.includes(userId) || userId !== ADMIN_ID) {
    return ctx.reply("🚫 You're not authorized to delete entries.");
  }

  await Entry.deleteOne({ id: entryId });
  ctx.reply(`🗑️ Entry \`${entryId}\` deleted successfully.`, { parse_mode: 'Markdown' });

  for (const uid of ALLOWED_USERS) {
    if (uid !== userId) {
      await bot.telegram.sendMessage(
        uid,
        `⚠️ Entry deleted by admin:\n👤 ${entry.name}\n💵 ${formatKRW(entry.amount)}₩\n📝 ${entry.note}\n🕒 ${moment(entry.time).format('YYYY-MM-DD HH:mm')}`
      );
    }
  }
});

// ========== Text handler (core add flow) ==========

bot.on('text', async (ctx) => {
  const userId = String(ctx.from?.id);
  const session = await Session.findOne({ userId });

  if (!session?.name) return;

  const parts = ctx.message.text.trim().split(' ');
  const amount = parseKrwAmount(parts[0]);
  const note = parts.slice(1).join(' ') || '';

  if (amount === null) {
    return ctx.reply(
      '❌ Invalid amount. Examples: `50000`, `50.000`, `50,000`, `50 000`\nOr type /cancel to abort.',
      { parse_mode: 'Markdown' }
    );
  }

  try {
    // Umumiy → split 50/50 between Sheyx and Polvon (two entries)
    if (session.name === 'Umumiy') {
      const share = Math.round(amount / 2);
      const entries = (['Sheyx', 'Polvon'] as UserName[]).map((name) =>
        new Entry({
          id: nanoid(),
          name,
          amount: share,
          note,
          time: new Date(),
        })
      );

      await Entry.insertMany(entries);
      await Session.findOneAndUpdate({ userId }, { name: null, mode: null });

      await ctx.reply(
        `✅ Umumiy recorded. Total ${formatKRW(amount)}₩ split 50/50 → ${formatKRW(share)}₩ each.`
      );
      for (const uid of ALLOWED_USERS) {
        if (uid !== userId) {
          await bot.telegram.sendMessage(
            uid,
            `🔔 Umumiy split: total ${formatKRW(amount)}₩ → Sheyx ${formatKRW(share)}₩, Polvon ${formatKRW(share)}₩\n📝 Note: ${note}\n🕒 ${moment(new Date()).format('YYYY-MM-DD HH:mm')}`
          );
        }
      }
      return;
    }

    // Person selected
    if (session.mode === 'expenses') {
      // Record ONLY the chosen person's half
      const half = Math.round(amount / 2);
      const entry = new Entry({
        id: nanoid(),
        name: session.name as UserName,
        amount: half,
        note,
        time: new Date(),
      });

      await entry.save();
      await Session.findOneAndUpdate({ userId }, { name: null, mode: null });

      await ctx.reply(
        `✅ Expenses recorded for ${session.name}: total ${formatKRW(amount)}₩ → saved ${formatKRW(half)}₩ (their half only).`
      );
      for (const uid of ALLOWED_USERS) {
        if (uid !== userId) {
          await bot.telegram.sendMessage(
            uid,
            `🔔 Expenses: ${session.name} saved ${formatKRW(half)}₩ (from total ${formatKRW(amount)}₩)\n📝 Note: ${note}\n🕒 ${moment(new Date()).format('YYYY-MM-DD HH:mm')}`
          );
        }
      }
      return;
    }

    // Debt (or default): single full entry for chosen person
    const entry = new Entry({
      id: nanoid(),
      name: session.name as UserName,
      amount,
      note,
      time: new Date(),
    });

    await entry.save();
    await Session.findOneAndUpdate({ userId }, { name: null, mode: null });

    await ctx.reply(`✅ ${session.name} debt recorded: ${formatKRW(amount)}₩.`);
    for (const uid of ALLOWED_USERS) {
      if (uid !== userId) {
        await bot.telegram.sendMessage(
          uid,
          `🔔 Debt added for ${session.name}: ${formatKRW(amount)}₩\n📝 Note: ${note}\n🕒 ${moment(new Date()).format('YYYY-MM-DD HH:mm')}`
        );
      }
    }
  } catch (error) {
    console.error('Error during text handling:', error);
    ctx.reply('❌ An error occurred while processing your request.');
  }
});

// ========== Shutdown ==========
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
