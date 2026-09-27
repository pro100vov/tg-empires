import { Bot, InlineKeyboard } from 'grammy';
import { createRoom, getRoom } from './rooms.js';

export interface BotConfig {
  token: string;
  webAppUrl: string;
  shortName: string;
}

const HELP = [
  '<b>TG Empires</b> — пошаговая стратегия на несколько игроков.',
  '',
  'Развивайте державу, стройте фермы, шахты и крепости, нанимайте войска,',
  'изучайте технологии и захватывайте земли соперников.',
  '',
  '/newgame — создать комнату и получить ссылку-приглашение',
  '/join КОД — присоединиться к существующей комнате',
  '/help — эта справка',
].join('\n');

export async function startBot(config: BotConfig): Promise<Bot> {
  const bot = new Bot(config.token);
  const me = await bot.api.getMe();

  /**
   * Ссылка для пересылки. С short name Mini App (BotFather /newapp) она сразу
   * открывает игру с кодом в start_param, иначе ведёт в чат бота (/start КОД).
   */
  const appLink = config.shortName ? `https://t.me/${me.username}/${config.shortName}` : '';
  const inviteLink = (code: string) =>
    appLink ? `${appLink}?startapp=${code}` : `https://t.me/${me.username}?start=${code}`;

  // Кнопки web_app разрешены только в личных чатах Telegram; в группе ctx.reply
  // с .webApp(...) падает с ошибкой, и пользователь не видит вообще ничего.
  const isPrivate = (ctx: { chat?: { type?: string } }) => ctx.chat?.type === 'private';

  const playKeyboard = (ctx: { chat?: { type?: string } }) =>
    isPrivate(ctx)
      ? new InlineKeyboard().webApp('🎮 Играть', config.webAppUrl)
      : new InlineKeyboard().url('🎮 Играть', appLink || `https://t.me/${me.username}`);

  const openKeyboard = (ctx: { chat?: { type?: string } }, code: string) =>
    isPrivate(ctx)
      ? new InlineKeyboard()
          .webApp('🎮 Открыть игру', `${config.webAppUrl}?room=${code}`)
          .row()
          .url('🔗 Ссылка для друзей', inviteLink(code))
      : new InlineKeyboard().url('🎮 Открыть игру', inviteLink(code));

  bot.command('start', async (ctx) => {
    const payload = ctx.match?.trim();
    if (payload) {
      const code = payload.toUpperCase();
      const room = getRoom(code);
      if (!room) {
        await ctx.reply(`Комната ${code} не найдена или уже закрыта. Создайте новую: /newgame`);
        return;
      }
      await ctx.reply(`Комната <b>${code}</b>. Игроков: ${room.players.length}`, {
        parse_mode: 'HTML',
        reply_markup: openKeyboard(ctx, code),
      });
      return;
    }
    await ctx.reply(HELP, {
      parse_mode: 'HTML',
      reply_markup: playKeyboard(ctx),
    });
  });

  bot.command('play', (ctx) =>
    ctx.reply('Откройте игру кнопкой ниже — не через старое окно Mini App.', {
      reply_markup: playKeyboard(ctx),
    }),
  );

  bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  bot.command('newgame', async (ctx) => {
    const hostId = String(ctx.from?.id ?? '');
    if (!hostId) return;
    const state = createRoom(hostId);
    await ctx.reply(
      [
        `Комната создана: <b>${state.roomCode}</b>`,
        '',
        'Откройте игру и дождитесь друзей — до 4 держав в партии.',
        `Приглашение: ${inviteLink(state.roomCode)}`,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: openKeyboard(ctx, state.roomCode) },
    );
  });

  bot.command('join', async (ctx) => {
    const code = ctx.match?.trim().toUpperCase();
    if (!code) {
      await ctx.reply('Укажите код комнаты: /join ABCDE');
      return;
    }
    if (!getRoom(code)) {
      await ctx.reply(`Комната ${code} не найдена.`);
      return;
    }
    await ctx.reply(`Комната <b>${code}</b> ждёт вас.`, {
      parse_mode: 'HTML',
      reply_markup: openKeyboard(ctx, code),
    });
  });

  bot.catch((err) => {
    console.error('[bot] ошибка:', err.message);
  });

  try {
    await bot.api.setMyCommands([
      { command: 'play', description: 'Открыть игру' },
      { command: 'newgame', description: 'Создать новую партию' },
      { command: 'join', description: 'Присоединиться по коду' },
      { command: 'help', description: 'Правила и команды' },
    ]);
  } catch (err) {
    console.error('[bot] не удалось задать список команд:', err);
  }

  if (config.webAppUrl.startsWith('https://')) {
    try {
      await bot.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Играть',
          web_app: { url: config.webAppUrl },
        },
      });
    } catch (err) {
      console.error('[bot] не удалось задать кнопку меню:', err);
    }
  }

  bot.start({ onStart: () => console.log(`[bot] @${me.username} запущен`) }).catch((err) => {
    console.error('[bot] polling остановлен:', err);
  });
  return bot;
}
