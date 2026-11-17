import { Bot, Keyboard, GrammyError, HttpError } from 'grammy';

const { BOT_TOKEN, REVIEWS_CHAT_ID } = process.env;

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN. Скопируйте .env.example в .env и заполните его.');
  process.exit(1);
}
if (!REVIEWS_CHAT_ID) {
  console.error('Не задан REVIEWS_CHAT_ID. Укажите ID чата для отзывов в .env.');
  process.exit(1);
}

// ---------- Тексты кнопок ----------
const BTN_REVIEW = '📝 Оставить отзыв';
const BTN_HELP = 'ℹ️ Помощь';
const BTN_CANCEL = '❌ Отмена';

const ORDER_NUMBER_LENGTH = 8;
// Запас под заголовок пересылаемого сообщения (лимит Telegram — 4096 символов).
const MAX_REVIEW_LENGTH = 3500;

// ---------- Клавиатуры ----------
const mainMenu = new Keyboard()
  .text(BTN_REVIEW)
  .row()
  .text(BTN_HELP)
  .resized()
  .persistent();

const cancelMenu = new Keyboard().text(BTN_CANCEL).resized().persistent();

// ---------- Состояние диалога (в памяти) ----------
// userId -> { step: 'awaiting_order' | 'awaiting_review', orderNumber?: string }
const sessions = new Map();

const STEP_ORDER = 'awaiting_order';
const STEP_REVIEW = 'awaiting_review';

// ---------- Вспомогательные функции ----------
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function validateOrderNumber(raw) {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    return 'Номер заявки должен состоять только из цифр, без букв, пробелов и других символов.';
  }
  if (value.length !== ORDER_NUMBER_LENGTH) {
    return `Номер заявки должен содержать ровно ${ORDER_NUMBER_LENGTH} цифр, а вы ввели ${value.length}.`;
  }
  return null;
}

// Кто оставил отзыв: @username, а если его нет — имя (ссылкой на профиль).
function formatAuthor(from) {
  if (from.username) return `@${escapeHtml(from.username)}`;
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ') || `id ${from.id}`;
  return `<a href="tg://user?id=${from.id}">${escapeHtml(fullName)}</a>`;
}

async function showMainMenu(ctx, text) {
  sessions.delete(ctx.from.id);
  await ctx.reply(text, { reply_markup: mainMenu });
}

// ---------- Бот ----------
const bot = new Bot(BOT_TOKEN);

// Сценарий работает только в личных сообщениях с ботом.
const pm = bot.chatType('private');

pm.command('start', (ctx) =>
  showMainMenu(
    ctx,
    'Здравствуйте! 👋\nЗдесь можно оставить отзыв о работе по вашей заявке.\n\n' +
      `Нажмите «${BTN_REVIEW}», чтобы начать.`,
  ),
);

pm.command('cancel', (ctx) => cancel(ctx));
pm.hears(BTN_CANCEL, (ctx) => cancel(ctx));

async function cancel(ctx) {
  const hadSession = sessions.has(ctx.from.id);
  await showMainMenu(ctx, hadSession ? 'Отменено. Вы в главном меню.' : 'Вы в главном меню.');
}

const helpText =
  'Как оставить отзыв:\n' +
  `1. Нажмите «${BTN_REVIEW}».\n` +
  `2. Введите ${ORDER_NUMBER_LENGTH}-значный номер заявки.\n` +
  '3. Напишите отзыв одним сообщением.\n\n' +
  `Отменить можно в любой момент кнопкой «${BTN_CANCEL}» или командой /cancel.`;

pm.command('help', (ctx) => ctx.reply(helpText, { reply_markup: sessions.has(ctx.from.id) ? cancelMenu : mainMenu }));
pm.hears(BTN_HELP, (ctx) => ctx.reply(helpText, { reply_markup: sessions.has(ctx.from.id) ? cancelMenu : mainMenu }));

pm.hears(BTN_REVIEW, async (ctx) => {
  sessions.set(ctx.from.id, { step: STEP_ORDER });
  await ctx.reply(`Введите номер заявки — ${ORDER_NUMBER_LENGTH} цифр, например 12345678.`, {
    reply_markup: cancelMenu,
  });
});

pm.on('message:text', async (ctx) => {
  const session = sessions.get(ctx.from.id);
  const text = ctx.message.text;

  if (!session) {
    await ctx.reply(`Чтобы оставить отзыв, нажмите «${BTN_REVIEW}».`, { reply_markup: mainMenu });
    return;
  }

  if (session.step === STEP_ORDER) {
    const error = validateOrderNumber(text);
    if (error) {
      await ctx.reply(`${error}\n\nПожалуйста, введите номер заявки ещё раз.`, {
        reply_markup: cancelMenu,
      });
      return;
    }
    session.orderNumber = text.trim();
    session.step = STEP_REVIEW;
    await ctx.reply('Спасибо! Теперь напишите ваш отзыв одним сообщением.', {
      reply_markup: cancelMenu,
    });
    return;
  }

  if (session.step === STEP_REVIEW) {
    const review = text.trim();
    if (!review) {
      await ctx.reply('Отзыв не может быть пустым. Напишите, пожалуйста, текст отзыва.', {
        reply_markup: cancelMenu,
      });
      return;
    }
    if (review.length > MAX_REVIEW_LENGTH) {
      await ctx.reply(
        `Отзыв слишком длинный (${review.length} символов). Сократите его до ${MAX_REVIEW_LENGTH} символов и отправьте снова.`,
        { reply_markup: cancelMenu },
      );
      return;
    }

    const message =
      `📋 <b>Заявка:</b> <code>${escapeHtml(session.orderNumber)}</code>\n` +
      `💬 <b>${formatAuthor(ctx.from)}</b>: ${escapeHtml(review)}`;

    try {
      await ctx.api.sendMessage(REVIEWS_CHAT_ID, message, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('Не удалось отправить отзыв в чат отзывов:', err);
      await ctx.reply(
        'Не получилось отправить отзыв из-за технической ошибки 😔 Попробуйте, пожалуйста, ещё раз чуть позже.',
        { reply_markup: cancelMenu },
      );
      return; // состояние сохраняем — клиент может просто отправить отзыв повторно
    }

    await showMainMenu(ctx, 'Спасибо за ваш отзыв! Рассмотрим в ближайшее время 🙏');
  }
});

// Фото, стикеры, голосовые и т.п. посреди сценария.
pm.on('message', async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) {
    await ctx.reply(`Чтобы оставить отзыв, нажмите «${BTN_REVIEW}».`, { reply_markup: mainMenu });
    return;
  }
  const what = session.step === STEP_ORDER ? 'номер заявки' : 'отзыв';
  await ctx.reply(`Пожалуйста, отправьте ${what} обычным текстовым сообщением.`, {
    reply_markup: cancelMenu,
  });
});

bot.catch((err) => {
  const e = err.error;
  console.error(`Ошибка при обработке update ${err.ctx.update.update_id}:`);
  if (e instanceof GrammyError) console.error('Ошибка Telegram API:', e.description);
  else if (e instanceof HttpError) console.error('Сетевая ошибка:', e);
  else console.error(e);
});

await bot.api.setMyCommands([
  { command: 'start', description: 'Главное меню' },
  { command: 'cancel', description: 'Отменить текущее действие' },
  { command: 'help', description: 'Как оставить отзыв' },
]);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

console.log('Бот запущен.');
await bot.start({
  onStart: (info) => console.log(`Работаю как @${info.username}`),
});
