import CadProcessingWorker from "./cadProcessing.worker?worker";
import type { CadProcessingResult } from "./types";

const MAX_FILE_BYTES = 80 * 1024 * 1024;

type WorkerMessage =
  | { type: "progress"; progress: number; label: string }
  | { type: "result"; result: CadProcessingResult }
  | { type: "error"; message: string };

export async function processDwgFile(
  file: File,
  onProgress?: (progress: number, label: string) => void,
): Promise<CadProcessingResult> {
  if (!file.name.toLowerCase().endsWith(".dwg")) {
    throw new Error("Нужен файл DWG. Для DXF будет добавлен отдельный импортёр.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Файл больше 80 МБ. Разделите топосъёмку или очистите внешние ссылки.");
  }

  onProgress?.(5, "Читаем файл с диска");
  const content = await file.arrayBuffer();
  onProgress?.(10, "Передаём DWG фоновому CAD-ядру");

  return new Promise<CadProcessingResult>((resolve, reject) => {
    const worker = new CadProcessingWorker({ name: "aedexa-dwg-processor" });
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === "progress") {
        onProgress?.(event.data.progress, event.data.label);
        return;
      }
      if (event.data.type === "result") {
        finish();
        resolve(event.data.result);
        return;
      }
      finish();
      reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      finish();
      reject(
        new Error(event.message || "Фоновое CAD-ядро остановилось. Попробуйте пересохранить DWG."),
      );
    };
    worker.postMessage({ type: "process", fileName: file.name, fileSize: file.size, content }, [
      content,
    ]);
  });
}
