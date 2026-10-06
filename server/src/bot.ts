import { Bot, InlineKeyboard } from 'grammy';
import { applyAction } from '@tge/shared';
import { pushStateSafe } from './hub.js';
import { bindBot, inviteToRematch } from './notify.js';
import { rematchRoom } from './rematch.js';
import { createRoom, getRoom, myGames } from './rooms.js';
import { getUser, setNotify, touchUser } from './users.js';

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
  '/wargame — варгейм: армия на стартовый капитал, без экономики — сразу в бой',
  '/join КОД — присоединиться к существующей комнате',
  '/games — мои партии: где сейчас ваш ход',
  '/notify on|off — сообщения «Ваш ход» и итоги партий',
  '/help — эта справка',
].join('\n');

/** Короткая подпись партии для списка /games. */
function gameLine(g: ReturnType<typeof myGames>[number]): string {
  if (g.phase === 'lobby') return `🕓 <b>${g.roomCode}</b> — лобби, ${g.players.length} игр.`;
  if (g.phase === 'finished') return `🏁 <b>${g.roomCode}</b> — партия окончена`;
  if (g.phase === 'deploy') return `🛡️ <b>${g.roomCode}</b> — варгейм, расстановка армий`;
  const round = `раунд ${g.round}/${g.maxRounds}`;
  return g.myTurn
    ? `⚔️ <b>${g.roomCode}</b> — ваш ход (${round})`
    : `⏳ <b>${g.roomCode}</b> — ходит ${g.turnName || '—'} (${round})`;
}

export async function startBot(config: BotConfig): Promise<Bot> {
  const bot = new Bot(config.token);
  const me = await bot.api.getMe();
  bindBot(bot.api, config.webAppUrl);

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

  // Раз игрок написал боту в личку — писать ему в ответ можно (уведомления «Ваш ход»).
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot && ctx.chat?.type === 'private') {
      touchUser(String(ctx.from.id), ctx.from.first_name || ctx.from.username || `Игрок ${ctx.from.id}`, true);
    }
    await next();
  });

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

  bot.command('wargame', async (ctx) => {
    const hostId = String(ctx.from?.id ?? '');
    if (!hostId) return;
    const state = createRoom(hostId, 'wargame');
    await ctx.reply(
      [
        `⚔️ Варгейм: <b>${state.roomCode}</b>`,
        '',
        'Без экономики: каждый покупает армию на стартовый капитал (его задаёт хост в лобби),',
        'вслепую расставляет её у своего края карты — и в бой.',
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

  bot.command('games', async (ctx) => {
    const userId = String(ctx.from?.id ?? '');
    const games = userId ? myGames(userId) : [];
    if (games.length === 0) {
      await ctx.reply('Активных партий нет. /newgame — создать новую.');
      return;
    }
    const kb = new InlineKeyboard();
    for (const g of games) {
      if (isPrivate(ctx)) kb.webApp(`Открыть ${g.roomCode}`, `${config.webAppUrl}?room=${g.roomCode}`).row();
      else kb.url(`Открыть ${g.roomCode}`, inviteLink(g.roomCode)).row();
    }
    await ctx.reply(games.map(gameLine).join('\n'), { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.command('notify', async (ctx) => {
    const userId = String(ctx.from?.id ?? '');
    if (!userId) return;
    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      const on = getUser(userId)?.notify !== false;
      await ctx.reply(`Уведомления сейчас ${on ? 'включены' : 'выключены'}. Изменить: /notify on или /notify off`);
      return;
    }
    setNotify(userId, arg === 'on');
    await ctx.reply(arg === 'on' ? 'Уведомления включены: пришлю, когда настанет ваш ход.' : 'Уведомления выключены.');
  });

  // «Реванш» под итогами партии: создаёт (или находит) комнату с теми же настройками.
  bot.callbackQuery(/^rematch:([A-Z0-9]{3,16})$/, async (ctx) => {
    const code = ctx.match[1]!;
    const old = getRoom(code);
    if (!old) {
      await ctx.answerCallbackQuery({ text: 'Партия уже удалена', show_alert: true });
      return;
    }
    const userId = String(ctx.from.id);
    const result = rematchRoom(old, userId, ctx.from.first_name || `Игрок ${userId}`, false);
    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: result.error, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    if (result.created) inviteToRematch(old, result.state.roomCode, userId);
    await ctx.reply(`🔁 Реванш: комната <b>${result.state.roomCode}</b> ждёт вас.`, {
      parse_mode: 'HTML',
      reply_markup: openKeyboard(ctx, result.state.roomCode),
    });
  });

  // Предложение перемирия/союза офлайн-игроку: «Принять / Отклонить» прямо из чата.
  bot.callbackQuery(/^dip:([ad]):([A-Z0-9]{3,16}):(.{1,128})$/, async (ctx) => {
    const [, act, code, fromId] = ctx.match;
    const state = getRoom(code!);
    if (!state) {
      await ctx.answerCallbackQuery({ text: 'Партия уже удалена', show_alert: true });
      return;
    }
    const userId = String(ctx.from.id);
    const id = `${fromId}>${userId}`;
    const result = applyAction(state, userId, act === 'a' ? { type: 'acceptProposal', id } : { type: 'declineProposal', id });
    if (!result.ok) {
      await ctx.answerCallbackQuery({ text: result.error, show_alert: true });
      return;
    }
    pushStateSafe(state);
    await ctx.answerCallbackQuery({ text: act === 'a' ? 'Договор заключён' : 'Предложение отклонено' });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // Сообщение могли уже изменить — не критично.
    }
  });

  bot.catch((err) => {
    console.error('[bot] ошибка:', err.message);
  });

  try {
    await bot.api.setMyCommands([
      { command: 'play', description: 'Открыть игру' },
      { command: 'newgame', description: 'Создать новую партию' },
      { command: 'wargame', description: 'Варгейм: армия на капитал, сразу в бой' },
      { command: 'join', description: 'Присоединиться по коду' },
      { command: 'games', description: 'Мои партии' },
      { command: 'notify', description: 'Уведомления о ходе: on / off' },
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
