import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Хранение на диске — простые JSON-файлы (без нативных модулей на сервере).
 * Каталог берём при первом обращении, а не при импорте: .env подгружается позже.
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let cachedDir: string | null = null;

export function dataDir(): string {
  if (cachedDir) return cachedDir;
  const dir = path.resolve(process.env.DATA_DIR || path.join(rootDir, 'data'));
  fs.mkdirSync(dir, { recursive: true });
  cachedDir = dir;
  return dir;
}

export function dataFile(name: string): string {
  return path.join(dataDir(), name);
}

/** Пишем во временный файл и переименовываем: обрыв записи не портит основной файл. */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/**
 * Читает JSON. Нет файла — null. Битый файл переименовывается в `<имя>.broken-<время>`
 * (данные не теряем), об этом громко пишем в лог, возвращаем null.
 */
export function readJsonSafe<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    const broken = file.replace(/\.json$/, `.broken-${Date.now()}.json`);
    console.error(`[storage] !!! ${file} повреждён (${(err as Error).message}); сохраняю как ${broken}, стартую с пустого`);
    try {
      fs.renameSync(file, broken);
    } catch (renameErr) {
      console.error('[storage] не удалось переименовать битый файл:', renameErr);
    }
    return null;
  }
}
