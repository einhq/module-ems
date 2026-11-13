/**
 * The card's share as EiN's setting: `CFG_EMS_CARD_SHARE_MB`, the most of the primary's card its
 * processes hold, in MB, 0 for none of it. The `ems-link` service keeps the primary at it
 * (`keepCardShare`): when the setting changes, which restarts the service, and when EMS reports
 * another share, as it does after a restart with the share it starts with. Unset, EMS keeps its own.
 */

import type { Command } from '@ein/client';
import { health, setCardShare } from '@ems/client';
import type { EmsInstance } from '@ems/instances';

/** The share `CFG_EMS_CARD_SHARE_MB` names, in whole MB; undefined while it is unset. */
export const cardShareSetting = (env: Record<string, string | undefined>): number | undefined => {
  const text = (env.CFG_EMS_CARD_SHARE_MB ?? '').trim();
  const mb = Number(text);
  return text && Number.isFinite(mb) && mb >= 0 ? Math.round(mb) : undefined;
};

/** A share as a person reads it. */
const shareText = (mb: number | null | undefined): string => mb === null || mb === undefined ? 'the whole card' : mb === 0 ? 'none of the card' : `${mb} MB`;

/**
 * Give `instance` the share `shareMb` when its health reports another. Answers what was done, for
 * the service's log, or undefined when nothing was: the share is already that, or EMS is not
 * answering or cannot change it. A refusal throws.
 */
export const keepCardShare = async (cmd: Command, instance: EmsInstance, shareMb: number): Promise<string | undefined> => {
  const card = (await health(cmd, instance))?.card;
  if (!card || card.share_mb === undefined || card.share_mb === shareMb) return undefined;
  const { unloaded } = await setCardShare(cmd, instance, shareMb);
  return `the card's share set to ${shareText(shareMb)}, from ${shareText(card.share_mb)}${unloaded.length ? `; unloaded ${unloaded.join(', ')}` : ''}`;
};
