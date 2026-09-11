export type AnalysisProgress = { stage?: string; percent?: number; done?: boolean };

export async function readAnalysisResponse<T extends object>(
  response: Response,
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error(
        `Сервер не вернул результат анализа (HTTP ${response.status}). Повторите запуск.`,
      );
    }
  }
  if (!response.body) throw new Error("Сервер вернул пустой ответ анализа.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: T | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as T & AnalysisProgress;
    if (event.done) final = event;
    else onProgress?.(event);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    consume(buffer + decoder.decode());
  } finally {
    reader.releaseLock();
  }
  if (!final) throw new Error("Соединение прервалось до завершения анализа. Повторите запуск.");
  return final;
}
