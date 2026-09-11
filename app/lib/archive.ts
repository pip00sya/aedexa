import type { CadDrawing, CadProcessingResult } from "./cad/types";
import type { LayerRole } from "./placement/layerRoles";
import type { SiteContextMark } from "./placement/siteContext";
import type { SiteObject } from "./placement/siteObjects";
import type {
  ImagePlanAnalysis,
  NeighborBuilding,
  ParcelCandidate,
  PlacementAnalysis,
  PlacementConfidence,
  PlacementParameters,
  PlacementPolygon,
  PlacementRelief,
  PlacementSource,
  PlacementSourceKind,
  UtilityRestriction,
} from "./placement/types";
import type { ReconstructionHints, ReconstructionModel } from "./reconstruction/types";

export const ARCHIVE_UPDATED_EVENT = "aedexa:archive-updated";

export type ArchiveKind = "placement" | "topography" | "reconstruction";
export type ArchiveStatus = "ready" | "review" | "blocked";

type ArchiveBase = {
  schema: 1;
  id: string;
  kind: ArchiveKind;
  title: string;
  sourceName: string;
  summary: string;
  status: ArchiveStatus;
  createdAt: string;
  updatedAt: string;
};

export type ArchivedPlacementSource = {
  kind: PlacementSourceKind;
  name: string;
  confidence: PlacementConfidence;
  unitLabel: string;
  coordinateLabel: string;
  parcel: PlacementPolygon | null;
  parcelConfirmed: boolean;
  streetEdgeIndex: number;
  neighbors: NeighborBuilding[];
  parcelCandidates?: ParcelCandidate[];
  selectedParcelCandidateId?: string;
  utilities?: UtilityRestriction[];
  relief?: PlacementRelief;
  image?: ImagePlanAnalysis;
  metersPerPixel?: number;
  anchor?: { lat: number; lon: number; rotation: number };
  warnings: string[];
  cad?: PlacementSource["cad"];
  purpose?: PlacementSource["purpose"];
  withheldParcel?: PlacementSource["withheldParcel"];
};

export type PlacementWorkspaceState = {
  siteObjects: SiteObject[];
  contextMarks: SiteContextMark[];
  layerOverrides: Record<string, LayerRole>;
  buildingHeight: number;
  showShadows: boolean;
  planView: "plan" | "3d";
  exaggeration: number;
  showBase: boolean;
  showRestrictions: boolean;
  showSourceLines: boolean;
  showDimensions: boolean;
  variantsRequested: boolean;
  selectedVariantId?: string;
};

export function placementSourceForArchive(source: PlacementSource): ArchivedPlacementSource {
  const result = { ...source };
  delete result.imageUrl;
  if (source.cad) {
    result.cad = { ...source.cad };
    delete result.cad.drawing;
  }
  return result;
}

export type PlacementArchiveEntry = ArchiveBase & {
  kind: "placement";
  sourceFile?: File;
  payload: {
    source: ArchivedPlacementSource;
    parameters: PlacementParameters;
    analysis: PlacementAnalysis;
    /** Нет у старых записей: открываются с пустыми постройками и окружением */
    workspace?: PlacementWorkspaceState;
  };
};

export type TopographyArchiveEntry = ArchiveBase & {
  kind: "topography";
  sourceFile?: File;
  payload: CadProcessingResult;
};

export type ReconstructionArchiveEntry = ArchiveBase & {
  kind: "reconstruction";
  sourceFile?: File;
  hints?: ReconstructionHints;
  payload: ReconstructionModel;
};

export type ArchiveEntry =
  | PlacementArchiveEntry
  | TopographyArchiveEntry
  | ReconstructionArchiveEntry;

const DATABASE_NAME = "aedexa-results";
const STORE_NAME = "objects";
const DRAWING_STORE_NAME = "drawings";
const DATABASE_VERSION = 2;

type StoredDrawing = { id: string; drawing: CadDrawing };

function openArchiveDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("Этот браузер не поддерживает локальный архив."));
      return;
    }
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const upgrade = request.transaction;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(DRAWING_STORE_NAME)) {
        database.createObjectStore(DRAWING_STORE_NAME, { keyPath: "id" });
      }
      if (upgrade) {
        const objects = upgrade.objectStore(STORE_NAME);
        const drawings = upgrade.objectStore(DRAWING_STORE_NAME);
        const cursorRequest = objects.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const entry = cursor.value as ArchiveEntry;
          if (entry.kind === "topography" && entry.payload?.drawing) {
            const { drawing, ...payload } = entry.payload;
            drawings.put({ id: entry.id, drawing } satisfies StoredDrawing);
            cursor.update({ ...entry, payload });
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Не удалось открыть локальный архив."));
  });
}

export function createArchiveId(kind: ArchiveKind) {
  const randomId =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-${randomId}`;
}

function sortArchiveEntries(entries: ArchiveEntry[]) {
  return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveArchiveEntry(entry: ArchiveEntry) {
  const database = await openArchiveDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, DRAWING_STORE_NAME], "readwrite");
      if (entry.kind === "topography" && entry.payload.drawing) {
        const { drawing, ...payload } = entry.payload;
        transaction
          .objectStore(DRAWING_STORE_NAME)
          .put({ id: entry.id, drawing } satisfies StoredDrawing);
        transaction.objectStore(STORE_NAME).put({ ...entry, payload });
      } else {
        transaction.objectStore(STORE_NAME).put(entry);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Не удалось сохранить результат."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Сохранение результата было прервано."));
    });
  } finally {
    database.close();
  }
  globalThis.dispatchEvent?.(new CustomEvent(ARCHIVE_UPDATED_EVENT, { detail: entry.id }));
}

export async function loadArchiveDrawing(id: string) {
  const database = await openArchiveDatabase();
  try {
    return await new Promise<CadDrawing | undefined>((resolve, reject) => {
      const request = database
        .transaction(DRAWING_STORE_NAME, "readonly")
        .objectStore(DRAWING_STORE_NAME)
        .get(id);
      request.onsuccess = () => resolve((request.result as StoredDrawing | undefined)?.drawing);
      request.onerror = () =>
        reject(request.error ?? new Error("Не удалось прочитать чертёж из архива."));
    });
  } finally {
    database.close();
  }
}

export async function listArchiveEntries() {
  const database = await openArchiveDatabase();
  try {
    const entries = await new Promise<ArchiveEntry[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as ArchiveEntry[]);
      request.onerror = () =>
        reject(request.error ?? new Error("Не удалось прочитать локальный архив."));
    });
    return sortArchiveEntries(entries);
  } finally {
    database.close();
  }
}
