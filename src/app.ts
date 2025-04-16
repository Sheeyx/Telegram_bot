import express from 'express';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { nanoid } from 'nanoid';
import mongoose from 'mongoose';
import moment from 'moment';
import fs from 'fs';

dotenv.config();
const app = express();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);

const ALLOWED_USERS = ['615764917', '499127006','6520848060'];
const ADMIN_ID = process.env.ADMIN_ID!;

// MongoDB connection
mongoose
  .connect(process.env.MONGO_URL as string, {})
  .then(() => {
    console.log("✅ MongoDB connected");

    const PORT = process.env.PORT ?? 3003;
    app.listen(PORT, () => {
      console.info(`🚀 Server running on port: ${PORT}`);
      console.info(`🌐 Admin: http://localhost:${PORT} \n`);
    });

    bot.launch();
    console.log('🤖 Bot running...');

    bot.telegram.setMyCommands([
      { command: 'add', description: 'Add money entry' },
      { command: 'balance', description: 'View balance' },
      { command: 'list', description: 'Show all entries' },
      { command: 'clear', description: 'Clear all entries (admin only)' },
      { command: 'cancel', description: 'Cancel current operation' },
      // { command: 'delete', description: 'Delete an entry by ID' },
    ]);
  })
  .catch((err) => console.error("❌ MongoDB connection error", err));

// ========== Schemas & Models ==========

type UserName = 'Sheyx' | 'Polvon' | 'Jyan' | 'Umumiy';

interface IEntry {
  id: string;
  name: UserName;
  amount: number;
  note: string;
  time: Date;
}

interface ISession {
  userId: string;
  name: UserName | null;
}

const entrySchema = new mongoose.Schema<IEntry>({
  id: String,
  name: { type: String, enum: ['Sheyx', 'Polvon', 'Jyan', 'Umumiy'], required: true },
  amount: Number,
  note: String,
  time: Date
});

const sessionSchema = new mongoose.Schema<ISession>({
  userId: { type: String, required: true, unique: true },
  name: { type: String, enum: ['Sheyx', 'Polvon', 'Jyan', null], default: null }
});

const Entry = mongoose.model<IEntry>('Entry', entrySchema);
const Session = mongoose.model<ISession>('Session', sessionSchema);

// ========== Middleware ==========

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id);
  if (!ALLOWED_USERS.includes(userId)) {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `🚨 Unauthorized Access Attempt\n👤 User: ${ctx.from?.username} (${ctx.from?.id})\nMessage: ${ctx.message && 'text' in ctx.message ? ctx.message.text : 'Unknown'}`
    );
    return ctx.reply("🚫 You are not authorized to use this bot.");
  }
  return next();
});

// ========== Commands ==========

bot.start((ctx) => {
  ctx.reply(`👋 Welcome!\nUse /add to add money.\nUse /balance to view totals.\nUse /list to see entries.`);
});

bot.command('add', async (ctx) => {
  const userId = String(ctx.from?.id);

  try {
    // Update session data to null before proceeding
    await Session.findOneAndUpdate({ userId }, { name: null }, { upsert: true });

    // Check if the user is Jyan, and show only Umumiy option
    if (userId === '6520848060') {
      // Only show Umumiy option for Jyan
      await ctx.reply('You can only add money to the Umumiy category (split equally).', Markup.inlineKeyboard([
        [Markup.button.callback('Umumiy (Split equally)', 'choose_Umumiy')],
        [Markup.button.callback('❌ Cancel', 'choose_cancel')]
      ]));
    } else {
      // Show all options for other users
      await ctx.reply('Who is adding money?', Markup.inlineKeyboard([
        [Markup.button.callback('Sheyx', 'choose_Sheyx')],
        [Markup.button.callback('Polvon', 'choose_Polvon')],
        [Markup.button.callback('Jyan', 'choose_Jyan')],
        [Markup.button.callback('Umumiy (Split equally)', 'choose_Umumiy')],
        [Markup.button.callback('❌ Cancel', 'choose_cancel')]
      ]));
    }

  } catch (error) {
    console.error("Error during add command:", error);
    ctx.reply("❌ An error occurred while processing your request.");
  }
});

bot.action('choose_Umumiy', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    await Session.findOneAndUpdate({ userId }, { name: 'Umumiy' }, { upsert: true });
    await ctx.reply(`💬 Great! Now enter the total amount to be split equally and a note.\nExample: \`1500 snacks\`\nOr type /cancel to abort.`, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
  } catch (error) {
    console.error("Error during choose_Umumiy action:", error);
    ctx.reply("❌ An error occurred while processing your request.");
    await ctx.answerCbQuery();
  }
});


bot.action('choose_cancel', async (ctx) => {
  const userId = String(ctx.from?.id);
  await Session.findOneAndUpdate({ userId }, { name: null });
  await ctx.reply('Operation cancelled.');
  await ctx.answerCbQuery();
});

bot.command('cancel', async (ctx) => {
  const userId = String(ctx.from?.id);
  await Session.findOneAndUpdate({ userId }, { name: null });
  ctx.reply('Operation cancelled.');
});

bot.action(/choose_(Sheyx|Polvon|Jyan)/, async (ctx) => {
  const userId = String(ctx.from?.id);
  const chosenName = ctx.match[1] as UserName;
  await Session.findOneAndUpdate({ userId }, { name: chosenName }, { upsert: true });
  await ctx.reply(`💬 Great! Now enter amount and note.\nExample: \`500 lunch\`\nOr type /cancel to abort.`, { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

bot.command('balance', async (ctx) => {
  const userId = String(ctx.from?.id);
  const session = await Session.findOne({ userId });

  if (userId !== '6520848060') {
    // Not Jyan, give options to view others
    await ctx.reply('Choose whose balance to view:', Markup.inlineKeyboard([
      [Markup.button.callback('Sheyx', 'balance_Sheyx')],
      [Markup.button.callback('Polvon', 'balance_Polvon')],
      [Markup.button.callback('Jyan', 'balance_Jyan')],
      [Markup.button.callback('Total Balance', 'balance_total')]
    ]));
  } else {
    // Jyan can only view his own balance
    await ctx.reply('You can only view your own balance.', Markup.inlineKeyboard([
      [Markup.button.callback('Jyan', 'balance_Jyan')]
    ]));
  }
});

bot.action('balance_Jyan', async (ctx) => {
  const userId = String(ctx.from?.id);

  try {
    const entries = await Entry.find({ name: 'Jyan' }).sort({ time: -1 });
    if (entries.length === 0) {
      await ctx.reply(`No entries found for Jyan.`);
      return ctx.answerCbQuery();
    }

    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    let message = `💰 Jyan's Total: ${total}₩\n\n📝 Entries:\n`;
    entries.forEach(entry => {
      message += `🔹 ${entry.amount}₩ - ${entry.note || 'No note'} (${moment(entry.time).format('YYYY-MM-DD HH:mm')})\n`;
    });

    await ctx.reply(message);
    await ctx.answerCbQuery();
  } catch (err) {
    console.error(`Error fetching Jyan's entries:`, err);
    await ctx.reply('❌ Error fetching entries.');
    await ctx.answerCbQuery();
  }
});



bot.action('balance_total', async (ctx) => {
  try {
    const entries = await Entry.find();
    const balances: Record<UserName, number> = {
      Sheyx: 0,
      Polvon: 0,
      Jyan: 0,
      Umumiy: 0
    };

    entries.forEach(entry => {
      balances[entry.name] += entry.amount;
    });

    await ctx.reply(`💰 Balance:\nSheyx: ${balances.Sheyx}₩\nPolvon: ${balances.Polvon}₩\nJyan: ${balances.Jyan}₩`);
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('Error calculating balance:', err);
    await ctx.reply('❌ Error fetching balance.');
    await ctx.answerCbQuery();
  }
});

bot.action(/balance_(Sheyx|Polvon|Jyan)/, async (ctx) => {
  const name = ctx.match[1] as UserName;

  try {
    const entries = await Entry.find({ name }).sort({ time: -1 });
    if (entries.length === 0) {
      await ctx.reply(`No entries found for ${name}.`);
      return ctx.answerCbQuery();
    }

    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    let message = `💰 ${name}'s Total: ${total}₩\n\n📝 Entries:\n`;
    entries.forEach(entry => {
      message += `🔹 ${entry.amount}₩ - ${entry.note || 'No note'} (${moment(entry.time).format('YYYY-MM-DD HH:mm')})\n`;
    });

    await ctx.reply(message);
    await ctx.answerCbQuery();
  } catch (err) {
    console.error(`Error fetching ${name}'s entries:`, err);
    await ctx.reply('❌ Error fetching entries.');
    await ctx.answerCbQuery();
  }
});

bot.command('list', async (ctx) => {
  const userId = String(ctx.from?.id);
  const session = await Session.findOne({ userId });

  if (userId !== '6520848060') {
    // Not Jyan, give options to view others' entries
    await ctx.reply('Choose whose entries to view:', Markup.inlineKeyboard([
      [Markup.button.callback('Sheyx', 'list_Sheyx')],
      [Markup.button.callback('Polvon', 'list_Polvon')],
      [Markup.button.callback('Jyan', 'list_Jyan')],
      [Markup.button.callback('All Entries', 'list_all')]
    ]));
  } else {
    // Jyan can only view his own entries
    await ctx.reply('You can only view your own entries.', Markup.inlineKeyboard([
      [Markup.button.callback('Jyan', 'list_Jyan')]
    ]));
  }
});

bot.action('list_Jyan', async (ctx) => {
  const userId = String(ctx.from?.id);

  try {
    const entries = await Entry.find({ name: 'Jyan' }).sort({ time: -1 });

    if (entries.length === 0) {
      await ctx.reply(`📭 No entries found for Jyan.`);
      return ctx.answerCbQuery();
    }

    let message = `📄 Entries for Jyan:\n\n`;
    entries.forEach((entry, index) => {
      message += `${index + 1}. 💵 ${entry.amount}₩ \n  📝 ${entry.note || 'No note'} \n  🕒 ${moment(entry.time).format('YYYY-MM-DD HH:mm')}\n\n`;
    });

    const chunks = message.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error(`❌ Error fetching entries for Jyan:`, err);
    await ctx.reply('❌ Error fetching entries.');
    await ctx.answerCbQuery();
  }
});



bot.action(/list_(Sheyx|Polvon|Jyan)/, async (ctx) => {
  const name = ctx.match[1] as UserName;

  try {
    const entries = await Entry.find({ name }).sort({ time: -1 });

    if (entries.length === 0) {
      await ctx.reply(`📭 No entries found for ${name}.`);
      return ctx.answerCbQuery();
    }

    let message = `📄 Entries for ${name}:\n\n`;
    entries.forEach((entry, index) => {
      message += `${index + 1}. 💵 ${entry.amount}₩ \n  📝 ${entry.note || 'No note'} \n  🕒 ${moment(entry.time).format('YYYY-MM-DD HH:mm')}\n\n`;
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
      message += `👤 ${entry.name} \n 💵 ${entry.amount}₩ \n 📝 ${entry.note || 'No note'} \n 🕒 ${moment(entry.time).format('YYYY-MM-DD HH:mm')}\n\n`;
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

// Existing code...
bot.command('clear', async (ctx) => {
  const userId = String(ctx.from?.id);

  // Check if the user is Jyan and deny access if they are
  if (userId == '6520848060') {
    return ctx.reply("🚫 You are not allowed to clear entries.");
  }

  // Check if the user is allowed to clear entries
  if (!ALLOWED_USERS.includes(userId)) {
    return ctx.reply("🚫 You're not authorized.");
  }

  try {
    // Fetch the last 4 entries
    const entries = await Entry.find().sort({ time: -1 }).limit(4);

    if (entries.length === 0) {
      await ctx.reply("❌ No entries found to clear.");
      return;
    }

    // Format the entries as text
    let entriesText = "Last 4 entries before clearing:\n\n";
    entries.forEach((entry, index) => {
      entriesText += `${index + 1}. 👤 ${entry.name}\n 💵 ${entry.amount}₩ \n 📝 ${entry.note || 'No note'} \n 🕒 ${moment(entry.time).format('YYYY-MM-DD HH:mm')}\n\n`;
    });

    // Write to a text file (log the last 4 entries)
    const filePath = 'last_entries.txt';
    fs.writeFileSync(filePath, entriesText, { encoding: 'utf8' });

    // Notify admin about the log
    await bot.telegram.sendDocument(ADMIN_ID, { source: filePath });

    // Continue with clearing entries
    const otherUserId = ALLOWED_USERS.find(uid => uid !== userId);
    await bot.telegram.sendMessage(
      otherUserId!,
      `⚠️ User ${ctx.from?.username} is requesting to clear all entries. Do you approve?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Approve', 'approve_clear')],
        [Markup.button.callback('❌ Deny', 'deny_clear')]
      ])
    );

    await ctx.reply("🔔 Request to clear entries has been sent to the other user for approval.");
  } catch (err) {
    console.error('❌ Error fetching entries before clearing:', err);
    await ctx.reply('❌ Error fetching entries before clearing.');
  }
});



bot.action('approve_clear', async (ctx) => {
  const userId = String(ctx.from?.id);

  // Check if the user is Jyan and deny approval if they are
  if (userId == '6520848060') {
    return ctx.reply("🚫 You are not authorized to approve clearing entries.");
  }

  // Check if the user is allowed
  if (!ALLOWED_USERS.includes(userId)) {
    return ctx.reply("🚫 You're not authorized.");
  }

  // Proceed to clear entries if the user is authorized
  await Entry.deleteMany({});
  await ctx.reply("🧹 All entries have been cleared.");

  // Notify the other authorized user
  const otherUserId = ALLOWED_USERS.find(uid => uid !== userId);
  if (otherUserId) {
    await bot.telegram.sendMessage(otherUserId, "🧹 The entries have been cleared.");
  }
});


bot.action('deny_clear', async (ctx) => {
  const userId = String(ctx.from?.id);
  if (!ALLOWED_USERS.includes(userId)) return ctx.reply("🚫 You're not authorized.");

  const otherUserId = ALLOWED_USERS.find(uid => uid !== userId);
  await bot.telegram.sendMessage(otherUserId!, "❌ The request to clear entries was denied by the other user.");
  await ctx.reply("❌ Your request to clear entries has been denied.");
});

bot.command('delete', async (ctx) => {
  const userId = String(ctx.from?.id);
  const messageParts = ctx.message.text.split(' ');

  if (messageParts.length !== 2) {
    return ctx.reply('❌ Usage: /delete <entry_id>\nExample: `/delete abc123`', { parse_mode: 'Markdown' });
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
        `⚠️ Entry deleted by admin:\n👤 ${entry.name}\n💵 ${entry.amount}₩\n📝 ${entry.note}\n🕒 ${moment(entry.time).format('YYYY-MM-DD HH:mm')}`
      );
    }
  }
});

bot.on('text', async (ctx) => {
  const userId = String(ctx.from?.id);
  const session = await Session.findOne({ userId });

  if (!session?.name) return;

  const parts = ctx.message.text.split(' ');
  const amount = parseFloat(parts[0]);
  const note = parts.slice(1).join(' ') || '';

  if (isNaN(amount)) {
    return ctx.reply('❌ Invalid amount. Please enter a valid amount (e.g., `500 snacks`).\nOr type /cancel to abort.', { parse_mode: 'Markdown' });
  }

  try {
    if (session.name === 'Umumiy') {
      const share = (amount / 3).toFixed(2);
      const entries = ['Sheyx', 'Polvon', 'Jyan'].map(name => new Entry({
        id: nanoid(),
        name,
        amount: parseFloat(share),
        note,
        time: new Date()
      }));

      await Entry.insertMany(entries);
      await Session.findOneAndUpdate({ userId }, { name: null });

      ctx.reply(`✅ Amount of ${amount}₩ has been divided equally among all users: ${share}₩ each.`);

      // Notify all users
      for (const uid of ALLOWED_USERS) {
        if (uid !== userId) {
          await bot.telegram.sendMessage(
            uid,
            `🔔 Amount of ${amount}₩ has been divided equally.\n💵 Each person gets ${share}₩\n📝 Note: ${note}\n🕒 ${moment(new Date()).format('YYYY-MM-DD HH:mm')}`
          );
        }
      }
    } else {
      const entry = new Entry({
        id: nanoid(),
        name: session.name,
        amount,
        note,
        time: new Date()
      });

      await entry.save();
      await Session.findOneAndUpdate({ userId }, { name: null });

      ctx.reply(`✅ Amount of ${amount}₩ has been added for ${session.name}.`);
      // Notify all users except the current user
      for (const uid of ALLOWED_USERS) {
        if (uid !== userId) {
          await bot.telegram.sendMessage(
            uid,
            `🔔 ${session.name} added ${amount}₩\n📝 Note: ${note}\n🕒 ${moment(new Date()).format('YYYY-MM-DD HH:mm')}`
          );
        }
      }
    }
  } catch (error) {
    console.error("Error during text handling:", error);
    ctx.reply("❌ An error occurred while processing your request.");
  }
});


process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));