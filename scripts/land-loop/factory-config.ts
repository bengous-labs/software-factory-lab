/**
 * The factory's config, one section per subsystem. The Merge bot reads it from its own checkout of the
 * Trunk, never from a PR's head, so a PR is routed by the config already landed; the Routing rules send
 * every change to the file itself to the Owner, whatever the config says.
 */

import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

/** Where the config lives, from the repository root. Under `.github/`, next to the workflows it steers. */
export const FACTORY_CONFIG_PATH = ".github/software-factory.json";

const RoutingPolicy = Schema.Struct({
  /** Globs whose change lands only with the Owner's Land approval, such as the paths the Code review does not read. */
  ownerPaths: Schema.Array(Schema.String),
  /** The factory's own code and config: a deep Code review, then land without the Owner, at any size, breaking or not. */
  factoryPaths: Schema.Array(Schema.String),
  /** Globs whose change gets a deep Code review and lands without the Owner, under the breaking-commit hold. */
  deepReviewPaths: Schema.Array(Schema.String),
  /** Past this many changed lines, a change gets a deep Code review. */
  lineCap: Schema.Int,
});

export type RoutingPolicy = typeof RoutingPolicy.Type;

const FactoryConfig = Schema.Struct({ land: Schema.Struct({ routing: RoutingPolicy }) });

type FactoryConfig = typeof FactoryConfig.Type;

/** The config `json` holds; one that does not read throws, naming the file and the field. */
export function factoryConfigOf(json: string): FactoryConfig {
  return decodeJson(FactoryConfig, FACTORY_CONFIG_PATH, json);
}
