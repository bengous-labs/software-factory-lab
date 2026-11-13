/**
 * Where the factory keeps its own files under the Owner's home, as absolute paths: its config directory,
 * the API key's file, and the directory of the Workers' clones. `host.ts` holds each name; every step
 * that needs one of these places takes it from here.
 */

import { API_KEY_FILE, CLONES_DIR, CONFIG_DIR } from "./host.ts";

/** The factory's config directory, which holds the Author's token and the Worker settings files. */
export function configDirOf(home: string): string {
  return `${home}/.config/${CONFIG_DIR}`;
}

/** The file that holds the Console API key an API Worker bills, under the home `home`. */
export function apiKeyFileOf(home: string): string {
  return `${home}/${API_KEY_FILE}`;
}

/** The directory that holds the clone of each Worker, background or API, under the home `home`. */
export function clonesDirOf(home: string): string {
  return `${home}/${CLONES_DIR}`;
}
