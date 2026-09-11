import { allowedUnits } from "../../lib/reconstruction/server/context";
import { reconstruct, StageError, errorPayload } from "../../lib/reconstruction/server/service";
import { type ReconstructionHints, type ReconstructionUnit } from "../../lib/reconstruction/types";

export const runtime = "edge";

const MAX_DATA_URL_LENGTH = 22_000_000;

const MAX_TOTAL_SOURCE_LENGTH = 58_000_000;

const MAX_SOURCE_ITEMS = 7;

const MAX_CAD_CONTEXT_LENGTH = 850_000;

const acceptedDataUrl = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i;

interface ReconstructionRequest {
  sourceName?: unknown;
  dataUrl?: unknown;
  dataUrls?: unknown;
  context?: unknown;
  hints?: unknown;
}

function safeHints(value: unknown): ReconstructionHints {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const unit = allowedUnits.has(input.unit as ReconstructionUnit)
    ? (input.unit as ReconstructionUnit)
    : undefined;
  const positive = (candidate: unknown) =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate > 0 &&
    candidate <= 1_000_000
      ? candidate
      : undefined;
  return {
    unit,
    width: positive(input.width),
    height: positive(input.height),
    depth: positive(input.depth),
    notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 800) : undefined,
    allowInferredGeometry: input.allowInferredGeometry !== false,
  };
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_TOTAL_SOURCE_LENGTH + MAX_CAD_CONTEXT_LENGTH + 100_000) {
    return Response.json(
      { code: "FILE_TOO_LARGE", error: "Файл слишком большой для анализа." },
      { status: 413 },
    );
  }

  let body: ReconstructionRequest;
  try {
    body = (await request.json()) as ReconstructionRequest;
  } catch {
    return Response.json(
      { code: "INVALID_REQUEST", error: "Не удалось прочитать запрос." },
      { status: 400 },
    );
  }

  const requestedName =
    typeof body.sourceName === "string" ? body.sourceName.trim().slice(0, 220) : "";
  const sourceName = requestedName || "drawing";
  const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
  const requestedDataUrls = Array.isArray(body.dataUrls)
    ? body.dataUrls.filter((value): value is string => typeof value === "string")
    : [];
  const dataUrls = requestedDataUrls.length ? requestedDataUrls : dataUrl ? [dataUrl] : [];
  const context =
    typeof body.context === "string" ? body.context.slice(0, MAX_CAD_CONTEXT_LENGTH) : "";
  const hints = safeHints(body.hints);
  const invalidSource =
    !dataUrls.length ||
    dataUrls.length > MAX_SOURCE_ITEMS ||
    dataUrls.some((value) => value.length > MAX_DATA_URL_LENGTH || !acceptedDataUrl.test(value)) ||
    dataUrls.reduce((total, value) => total + value.length, 0) > MAX_TOTAL_SOURCE_LENGTH;
  if (invalidSource) {
    return Response.json(
      {
        code: "UNSUPPORTED_INPUT",
        error: "Поддерживаются PNG, JPEG и WEBP после подготовки чертежа.",
      },
      { status: 415 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      try {
        send({ stage: "Чертёж принят, готовится аудит", percent: 12 });
        const result = await reconstruct(sourceName, dataUrls, context, hints, (stage, percent) =>
          send({ stage, percent }),
        );
        send({ done: true, ...result });
      } catch (error) {
        const payload =
          error instanceof StageError
            ? errorPayload(error.cause, error.code)
            : errorPayload(error, "INVALID_MODEL");
        send({ done: true, ...payload });
      } finally {
        controller.close();
      }
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
