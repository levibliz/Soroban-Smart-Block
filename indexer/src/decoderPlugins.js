/**
 * #567: Decoder plugin system for community-contributed event decoders.
 *
 * Plugins are JS modules in indexer/src/plugins/ that export:
 *   { matches(ev, topics, data, contractId), decode(ev, topics, data, contractId) }
 *
 * - `matches()` returns true when the plugin handles this event.
 * - `decode()` returns { description, function? } or throws.
 * - Plugins run before built-in decoders; first match wins.
 * - A plugin that throws is caught and logged; the built-in fallback runs.
 */
import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "./logger.js";

const PLUGINS_DIR = new URL("./plugins/", import.meta.url);

let _plugins = [];
let _loaded = false;

/**
 * Scan the plugins directory and register all .js modules that export
 * a valid plugin interface. Called once on first decode, then cached.
 */
export async function loadPlugins() {
  if (_loaded) return _plugins;

  try {
    const dir = new URL("./plugins/", import.meta.url);
    const files = await readdir(dir);
    const jsFiles = files.filter((f) => extname(f) === ".js" && f !== "index.js");

    for (const file of jsFiles) {
      try {
        const mod = await import(pathToFileURL(join(dir.pathname, file)).href);
        if (typeof mod.matches === "function" && typeof mod.decode === "function") {
          _plugins.push({ name: file, matches: mod.matches, decode: mod.decode });
          logger.info(`[decoderPlugin] loaded: ${file}`);
        } else {
          logger.warn(`[decoderPlugin] skipped ${file}: missing matches/decode exports`);
        }
      } catch (err) {
        logger.error(`[decoderPlugin] failed to load ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.warn(`[decoderPlugin] plugins directory not available: ${err.message}`);
  }

  _loaded = true;
  return _plugins;
}

/**
 * Run all loaded plugins against the given event.
 * Returns the first successful decode result, or null if no plugin matched.
 *
 * @param {object} ev         Raw Soroban RPC event
 * @param {any[]}  topics     scValToNative-decoded topics
 * @param {any}    data       scValToNative-decoded data
 * @param {string} contractId Contract address
 * @returns {Promise<{ description: string, function?: string } | null>}
 */
export async function runPlugins(ev, topics, data, contractId) {
  const plugins = await loadPlugins();

  for (const plugin of plugins) {
    try {
      if (plugin.matches(ev, topics, data, contractId)) {
        const result = await plugin.decode(ev, topics, data, contractId);
        if (result?.description) {
          return result;
        }
      }
    } catch (err) {
      logger.error(`[decoderPlugin] ${plugin.name} threw: ${err.message}`);
      // Continue to next plugin or built-in fallback
    }
  }

  return null;
}
