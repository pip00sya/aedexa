import { aiErrorResponse } from "./featherless";
import type { AnalysisProgress } from "./readResponse";

type ReportProgress = (stage: string, percent: number) => void;

export async function analysisResponse(
  request: Request,
  run: (report: ReportProgress) => Promise<object>,
  errorCode: string,
  errorPrefix: string,
): Promise<Response> {
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
    try {
      return Response.json(await run(() => {}));
    } catch (error) {
      return aiErrorResponse(error, errorCode, errorPrefix);
    }
  }
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const report: ReportProgress = (stage, percent) =>
        send({ stage, percent } satisfies AnalysisProgress);
      const heartbeat = setInterval(() => send({}), 20_000);
      try {
        report("Данные приняты, начинается анализ", 5);
        send({ ...(await run(report)), done: true });
      } catch (error) {
        const response = aiErrorResponse(error, errorCode, errorPrefix);
        send({ ...((await response.json()) as object), done: true });
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
