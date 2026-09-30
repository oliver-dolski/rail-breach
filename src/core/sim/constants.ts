/** Fixed simulation tick: 10 Hz. Wall-clock time exists only in the app shell. */
export const TICK_MS = 100;

/** Positions are integer decimetres, speeds integer decimetres per tick. */
export const DM_PER_M = 10;

/** Probabilities are integer permille. */
export const PERMILLE = 1000;

/** The runner hashes the world every this many ticks. */
export const CHECKPOINT_INTERVAL_TICKS = 100;

/** Dice purposes: separate substreams, so unrelated rolls never share draws. */
export const PURPOSE_TECHNIQUE_SUCCESS = 1;
