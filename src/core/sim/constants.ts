/** Fixed simulation tick: 10 Hz. Wall-clock time exists only in the app shell. */
export const TICK_MS = 100;

/** Ticks in one second of simulated time. */
export const TICKS_PER_SECOND = 1000 / TICK_MS;

/** Positions are integer decimetres, speeds integer decimetres per tick. */
export const DM_PER_M = 10;

/** Probabilities are integer permille. */
export const PERMILLE = 1000;

/** The runner hashes the world every this many ticks. */
export const CHECKPOINT_INTERVAL_TICKS = 100;

/** Dice purposes: separate substreams, so unrelated rolls never share draws. */
export const PURPOSE_TECHNIQUE_SUCCESS = 1;
export const PURPOSE_OP_DURATION = 2;

/** Rolling stock: one fixed train length keeps occupancy arithmetic trivial. */
export const TRAIN_LENGTH_DM = 1000;

/**
 * Speed changes by exactly 1 dm/tick every N ticks (N = 10 is about 1 m/s per
 * second). Integer speeds cannot express gentle deceleration any other way.
 */
export const ACCEL_PERIOD_TICKS = 10;
export const SERVICE_BRAKE_PERIOD_TICKS = 10;
export const EMERGENCY_BRAKE_PERIOD_TICKS = 6;

/** Largest speed the braking tables cover. */
export const MAX_SPEED_DM_PER_TICK = 63;

/** Trains aim to stop this far short of a stop target. */
export const STOP_MARGIN_DM = 20;
/** A standstill this close to a stop target counts as arrived. */
export const STOP_TOLERANCE_DM = 60;

/** The dispatch layer asks for a route once the train is this close to its signal. */
export const APPROACH_DM = 9000;
/** Inside this distance a route can no longer be cancelled: the train could not stop. */
export const APPROACH_LOCK_DM = 6000;
/** A rejected route request is repeated after this many ticks. */
export const CTC_RETRY_TICKS = 50;

/** How long a train stands at its final stop before it leaves the model. */
export const TERMINUS_DWELL_TICKS = 600;
/** How long a train that ran past a signal at danger waits before it may move again. */
export const OVERRUN_RECOVERY_TICKS = 600;

/**
 * How long a Denial of Control (T0813) lasts before the operators get the channel
 * back: 2 minutes at 10 ticks per second. It is the temporary sibling of Loss of
 * Control, and the engine lifts it by tick number, so the moment does not depend on
 * the frame rate. The exact period is a judgement call about what reads as a
 * temporary outage rather than an instant blip or a permanent loss.
 */
export const DENIAL_OF_CONTROL_RECOVER_TICKS = 1200;
