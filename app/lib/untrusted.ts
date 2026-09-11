// Разбор данных, которым нельзя верить на слово: тела запросов и ответы модели

export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

/** Строка в одну строку без лишних пробелов и не длиннее maxLength */
export function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength) : "";
}
