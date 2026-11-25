import * as Schema from "effect/Schema";

/**
 * Where a game is published (<slug>.kurambit.com) and whether this Kurambit is connected to
 * kurambit.com to publish (as the GitHub account it signed in with).
 */
export const GamePublishStatus = Schema.Struct({
  connected: Schema.Boolean,
  login: Schema.NullOr(Schema.String),
  /** A sign-in waiting for the person to approve its code on kurambit.com. */
  signingIn: Schema.NullOr(Schema.Struct({ url: Schema.String, userCode: Schema.String })),
  published: Schema.NullOr(Schema.Struct({ slug: Schema.String, url: Schema.String })),
});
export type GamePublishStatus = typeof GamePublishStatus.Type;
