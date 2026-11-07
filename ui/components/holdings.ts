import type { EmsStatus } from '@ems/api';

type Running = Extract<EmsStatus, { running: true }>;

/**
 * One copy of a model the media service holds, as the dashboard draws it: on the card or in RAM,
 * how much, and what it is doing. The flow board's model column, the memory map and the shelf all
 * read the same list, so they cannot disagree.
 */
export type Holding = {
  family: string;
  key: string;
  place: 'card' | 'ram';
  /** `batch`, `query` or `card`: the model worker holding it. */
  worker?: string;
  /** Its memory where it sits: VRAM on the card, RSS in RAM; absent when EMS did not measure it. */
  mb?: number;
  state: 'loading' | 'loaded' | 'unloading';
  /** A request is using the family right now. */
  working: boolean;
  /** One of the search models (the query worker's or the card worker's). */
  search: boolean;
  /**
   * A search model's copy in RAM kept while its card copy answers the searches (the card is quiet):
   * the copy that answers the moment indexing starts and the card copy is dropped, so search never
   * stops. Held on purpose, at the cost of its RAM (ein/core#1070).
   */
  standby: boolean;
};

/** The color of a model on the card, and in RAM, on the flow board and the memory map. */
export const CARD_COLOR = 'var(--mantine-color-teal-6)';
export const RAM_COLOR = 'var(--mantine-color-blue-5)';

const SEARCH_WORKERS = new Set(['query', 'card']);

export const holdingsOf = (status: Running): Holding[] => {
  const busy = new Set(status.requests.filter((request) => request.started !== undefined && request.family).map((request) => request.family!));
  return status.families.flatMap((family) => {
    const onCard = family.copies.some((copy) => copy.device === 'cuda' && copy.worker === 'card' && copy.state === 'loaded');
    return family.copies.map((copy): Holding => {
      const place = copy.device === 'cuda' ? 'card' : 'ram';
      const search = copy.worker !== undefined && SEARCH_WORKERS.has(copy.worker);
      return {
        family: family.name,
        key: copy.key,
        place,
        worker: copy.worker,
        mb: place === 'card' ? copy.vramMb : copy.ramMb,
        state: copy.state,
        working: family.running || busy.has(family.name),
        search,
        standby: place === 'ram' && copy.worker === 'query' && onCard,
      };
    });
  });
};

/** `1.9 GB`, `840 MB`, or `—` when not measured. */
export const size = (mb?: number): string => mb === undefined ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
