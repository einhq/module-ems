/**
 * What the ems module's commands answer with under `JSON_OUTPUT=1`, as types (`@ems/api`).
 *
 * The UI imports these instead of restating the shapes, and each command checks its answer
 * against them. Import-free, so a browser can import it without type-checking the module.
 */

/** Where one copy of a model is in its life: being read in, resident, or being freed. */
type EmsCopyState = 'loading' | 'loaded' | 'unloading';

/**
 * One copy of a model in a worker's memory. A family can hold two (`insightface` beside
 * `insightface:cpu` after the card ran out), so state is per copy. Times are epoch seconds.
 */
export type EmsModelCopy = {
  key: string;
  state: EmsCopyState;
  /** `cuda` or `cpu`; absent when EMS could not tell. */
  device?: string;
  /** When the copy entered `state`. */
  since?: number;
  lastUsed?: number;
  /** `batch` or `query`: which model worker holds it. */
  worker?: string;
} & EmsModelSize;

/**
 * What a copy cost when it loaded, measured as the card's free memory and the worker's RSS before
 * and after: approximate, since other work beside a load moves both.
 */
export type EmsModelSize = { vramMb?: number; ramMb?: number; loadSeconds?: number };

/** Where a family runs: on the graphics card, on the CPU, or not at all. */
export type EmsPlacement = 'card' | 'cpu' | 'unloaded';

/**
 * Who has the card. `busy` while indexing work arrives: its models own the card and search runs on
 * the CPU. `quiet` after `quietAfter` seconds without any: those are unloaded and search runs on the
 * card where it fits. `off`: no card to share.
 */
export type EmsCardMode = 'busy' | 'quiet' | 'switching' | 'off';

/** A model family EMS can load, resident or not. No copies means not loaded. */
export type EmsFamily = {
  name: string;
  /** The model it holds, as EMS names it (`Qwen/Qwen3-VL-8B-Instruct@nf4`). */
  model?: string;
  /** The device setting (`auto`, `cpu`, `cuda`), not where a copy actually went. */
  device?: string;
  /** What it is for, in a sentence. */
  purpose?: string;
  /** The EMS ops that use it (`vision.describe`). */
  ops?: string[];
  /** Never evicted, and loaded at start. */
  pinned: boolean;
  /** A request holds the family right now. */
  running: boolean;
  /** Requests queued behind the one running. */
  waiting: number;
  copies: EmsModelCopy[];
  /** What each copy cost when it last loaded, by key, kept after it unloads. */
  measured?: Record<string, EmsModelSize>;
  /** Where it runs in each card mode; `why` says why a search model stays off the card when quiet. */
  plan?: { busy: EmsPlacement; quiet: EmsPlacement; why?: string };
};

/** An admission slot held or waited for. Times are epoch seconds; no `started` means queued. */
export type EmsRequest = {
  op: string;
  lane: string;
  interactive: boolean;
  queued: number;
  started?: number;
  /** The model family it is using right now; a voiceprint is `sortformer`, then `titanet`. */
  family?: string;
};

/** What one of EMS's processes holds of the card; `worker` names a model worker's. */
type EmsGpuProcess = { pid: number; usedMb: number; worker?: string };

/** A model worker's own memory, against the ceiling it rebuilds itself at. */
export type EmsWorkerMemory = { rssMb?: number; maxRssMb?: number; recycles?: number };

export type EmsLane = { running: number; waiting: number; limit: number; reserve: number };

export type EmsDegradation = {
  what: string;
  reason: string;
  since?: number;
};

/** `ems-status`: the media service's health, or that it is not answering. */
export type EmsStatus =
  | { running: false; url: string }
  | {
    running: true;
    url: string;
    /** The API version EMS speaks. */
    api: string;
    /** What EMS is: package version and, when the image came from a checkout, its commit. */
    build?: { version?: string; commit?: string; date?: string };
    /** Seconds since the HTTP front started. */
    uptime: number;
    worker: { running: boolean; restarts: number; query?: { running: boolean; restarts: number } };
    /** `family` or `family:device`, for each resident family — the short form `--brief` prints. */
    loaded: string[];
    degraded: EmsDegradation[];
    families: EmsFamily[];
    requests: EmsRequest[];
    /** The card mode, when the card is shared. Times are epoch seconds. */
    card?: { mode: EmsCardMode; since?: number; quietAfter?: number; lastBatch?: number; batchInFlight?: number; searchOnCard: string[] };
    gpu?: {
      present: boolean;
      name?: string;
      driver?: string;
      utilPct?: number;
      decPct?: number;
      encPct?: number;
      memUsedMb?: number;
      memTotalMb?: number;
      tempC?: number;
      powerW?: number;
      powerLimitW?: number;
      /**
       * This EMS's processes on the card. `nvidia-smi` in a container sees only its own, so
       * `memUsedMb` less their sum is other containers' (such as the chat model's server).
       */
      processes?: EmsGpuProcess[];
    };
    vramAllocatedMb?: number;
    vramReservedMb?: number;
    rssMb?: number;
    maxRssMb?: number;
    recycles?: number;
    /** The query worker's memory: its models are on the CPU, so this is where they show. */
    queryWorker?: EmsWorkerMemory;
    queues?: Record<string, EmsLane>;
    warnings?: string[];
  };

/**
 * One reading of the card EMS runs on, as `ems-gpu-sample` answers and the `gpu` series stores it.
 * The loads are means over the seconds before it where EMS can average them; `decPct` and `encPct`
 * are the video decoder and encoder, which `utilPct` does not count.
 */
export type GpuSample = {
  utilPct: number;
  decPct?: number;
  encPct?: number;
  memUsedMb: number;
  memTotalMb: number;
  tempC: number;
};

/** A point of a recent history: epoch ms and a percentage. */
export type GpuPoint = { at: number; value: number };

/**
 * `ems-gpu`: the card now and its recent history, read back from the `gpu` series the
 * `gpu-sampler` service keeps. Null when there is no reading: no media service, or no card.
 */
export type EmsGpu = (GpuSample & { vramPercent?: number; utilSeries: GpuPoint[]; vramSeries: GpuPoint[] }) | null;
