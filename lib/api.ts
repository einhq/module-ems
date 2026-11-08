/**
 * What the ems module's commands answer with under `JSON_OUTPUT=1`, as types (`@ems/api`).
 *
 * The UI imports these instead of restating the shapes, and each command checks its answer
 * against them. Import-free, so a browser can import it without type-checking the module.
 */

/** Where one copy of a model is in its life: being read in, resident, or being freed. */
type EmsCopyState = 'loading' | 'loaded' | 'unloading';

/**
 * One copy of a model in a worker's memory. A family can hold two (`faces:cuda` beside
 * `faces:cpu` after the card ran out), so state is per copy. Times are epoch seconds.
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
  /** Who it is from: the name its key has in EMS's keys file. */
  caller?: string;
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

/**
 * A caller of EMS, by the name its key has: its share against the others' (`weight`), the
 * slot-seconds it has held since EMS started, and its requests running and waiting now. A freed
 * slot goes to the caller that has used the least for its weight.
 */
export type EmsCaller = { weight: number; usedSeconds: number; running: number; waiting: number };

export type EmsDegradation = {
  what: string;
  reason: string;
  since?: number;
};

/** `ems-status`: the media service's health, or that it is not answering. */
export type EmsStatus =
  | { running: false; url: string; instance?: string }
  | {
    running: true;
    url: string;
    /** Which instance this is (`main`, the primary, or another `ems-instance` names). */
    instance?: string;
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
    callers?: Record<string, EmsCaller>;
    memory?: EmsMemoryReading;
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
  /** What the card draws, and the most it may, in watts, when EMS reports them. */
  powerW?: number;
  powerLimitW?: number;
};

/** A point of a recent history: epoch ms and a percentage. */
export type GpuPoint = { at: number; value: number };

/**
 * `ems-gpu`: the card now and its recent history, read back from the `gpu` series the
 * `gpu-sampler` service keeps. Null when there is no reading: no media service, or no card.
 */
export type EmsGpu = (GpuSample & { vramPercent?: number; utilSeries: GpuPoint[]; vramSeries: GpuPoint[] }) | null;

/**
 * The memory of the machine the media service runs on, which need not be EiN's: its total and what
 * is available, and what EMS's own container holds of it (`usedMb`) and may (`limitMb`). MB.
 */
type EmsMemoryReading = { totalMb: number; availableMb?: number; usedMb?: number; limitMb?: number };

/**
 * `ems-memory`: the media service's machine's memory now and over the last six hours, for the
 * Overview's EMS RAM tile: in use (total less available) against the total, and EMS's own part.
 * Null when there is no reading.
 */
export type EmsMemory = {
  usedMb: number;
  totalMb: number;
  percent: number;
  emsMb?: number;
  emsLimitMb?: number;
  series: GpuPoint[];
} | null;

/**
 * What the media service held at one moment, as `ems-models-sample` answers and the `ems-models`
 * series stores it, a minute apart: the card mode, each model copy and where it was, the families a
 * request was using, and EiN's own work beside it from core's newest `pools` reading — not made
 * yet (`notStarted`) and in line for a worker (`inLine`).
 */
export type EmsModelsSample = {
  mode: EmsCardMode;
  copies: { family: string; place: 'card' | 'ram'; worker?: string; state: EmsCopyState }[];
  working: string[];
  /** Its machine's memory then. */
  memory?: EmsMemoryReading;
  /** What other containers held of the card, in a standard install the chat model; absent when EMS cannot tell. */
  othersMb?: number;
  notStarted?: number;
  inLine?: number;
};

/**
 * `ems-models`: the last hours of what the media service held, a sample a minute (epoch ms) — what
 * the Media service tab's strip draws, where a model loaded again and again shows as a row that
 * flickers.
 */
export type EmsModels = { windowMs: number; samples: { at: number; value: EmsModelsSample }[] };

/** `GET /v0/capabilities`, in EMS's own field names: what an instance serves and stamps its results with. */
export type EmsCapabilities = {
  api?: string;
  /** What the instance calls itself (`EMS_NAME`). */
  name?: string;
  build?: { version?: string; commit?: string; date?: string };
  gpu?: { present: boolean; name?: string; memory_mb?: number };
  /** The ops it serves. */
  ops?: string[];
  tools?: Record<string, string>;
  models?: { text_embed?: string; whisper?: string; faces?: string; image_embed?: string; ocr?: string };
  limits?: { models?: number; tools?: number; encodes?: number; queue_depth?: number; interactive_reserve?: number };
  encode?: { video_encoder?: string; cpu_budget?: string };
  signatures?: { transcribe?: string };
};

/**
 * One instance of the media service, as `ems-instance list` answers: what EiN holds of it, and
 * whether it answers and what it says it is. `main` is the primary, the media service settings.
 */
export type EmsInstanceRow = {
  name: string;
  primary: boolean;
  url: string;
  /** Where it reaches EiN's files; the primary's address when its own is unset. */
  filesAddress: string | null;
  /** Whether a key goes with its requests. */
  keySet: boolean;
  /** Slots EiN keeps in flight against it, as set or from its limits; null when neither says. */
  modelSlots: number | null;
  cpuSlots: number | null;
  answering: boolean;
  /** As its capabilities say, while it answers: its own name, the ops it serves, its card and build. */
  calls?: string;
  ops?: string[];
  gpu?: { present: boolean; name?: string; memoryMb?: number };
  build?: { version?: string; commit?: string; date?: string };
  /** For a second instance: the ops it serves that it stamps otherwise than the primary, which it is not given. */
  differs?: string[];
};
