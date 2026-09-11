import { processDwgBuffer } from "./processDwg";

type WorkerRequest = {
  type: "process";
  fileName: string;
  fileSize: number;
  content: ArrayBuffer;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type !== "process") return;
  try {
    const result = await processDwgBuffer(
      {
        fileName: event.data.fileName,
        fileSize: event.data.fileSize,
        content: event.data.content,
      },
      (progress, label) => self.postMessage({ type: "progress", progress, label }),
    );
    self.postMessage({ type: "result", result });
  } catch (reason) {
    self.postMessage({
      type: "error",
      message: reason instanceof Error ? reason.message : "Не удалось разобрать DWG",
    });
  }
};
