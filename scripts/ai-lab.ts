
if (mode === 'trace') {
  const a = (process.argv[3] ?? 'hard') as AiLevel;
  const b = (process.argv[4] ?? 'easy') as AiLevel;
  const seed = Number(process.argv[5] ?? 1);
  const res = playAi([a, b], seed * 101, { mapSize: 10, rounds: 30 });
  const s = res.state;
  for (const h of s.history) {
    if (h.round % 3 !== 0 && h.round !== 1) continue;
    console.log(`r${h.round}`, s.players.map((p) => `${p.ai}: sc${h.players[p.id]!.score} t${h.players[p.id]!.tiles} a${h.players[p.id]!.army} inc${h.players[p.id]!.income}`).join(' | '));
  }
  for (const p of s.players) {
    console.log(p.ai, JSON.stringify(p.stats), JSON.stringify(p.tech), JSON.stringify(p.resources), 'bldgs', s.tiles.filter((t) => t.ownerId === p.id && t.building).length);
  }
}
