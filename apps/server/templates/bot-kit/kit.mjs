// Bot kit. Generic controllers the bot imports; testers write facts,
// options and goals, not navigation.
//
// import { posOf, stateOf, hudHas } from "./kit/sensors.mjs";
// import { makeHolds, makeTapper } from "./kit/steer.mjs";
// import { makeWalkTo, driveWalk } from "./kit/walk.mjs";
// import { makeAttack, makeRetreat, makeKeepAway } from "./kit/fight.mjs";
//
// Or everything: import * as kit from "./kit/kit.mjs";

export * from "./sensors.mjs";
export * from "./steer.mjs";
export * from "./walk.mjs";
export * from "./fight.mjs";
