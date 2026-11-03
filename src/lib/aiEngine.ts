// Desktop-only control of the locally-launched AI engines (Ollama + ragrat).
// These wrap Tauri commands (ai_engine.rs) that discover, spawn, and supervise
// the engines on THIS machine — for the non-technical "run it for me" path.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./daemon";

export interface EngineState {
  found: string | null; // resolved binary path, if present
  running: boolean; // port currently reachable
  url: string | null;
  workers?: number; // ragrat only: the RUNNING daemon's actual ingest pool size
  managed: boolean; // Ganban itself started/supervises this engine (vs. external)
}
export interface AiEngineStatus {
  ollama: EngineState;
  ragrat: EngineState;
  managed: boolean; // Ganban started/supervises at least one
}

/** Discover + probe both engines. null off-desktop (they run on the host). */
export async function aiEngineStatus(): Promise<AiEngineStatus | null> {
  if (!isTauri()) return null;
  return invoke<AiEngineStatus>("ai_engine_status");
}

/** Start whichever engine is down (Ollama on its port, ragrat on a free port),
 * and write the connection settings. Returns the resolved URLs; `warning` is
 * set when a ragrat Ganban can't manage ignores the workers setting. */
export async function aiEngineStart(): Promise<{ ollama_url: string; ragrat_url: string; warning: string | null }> {
  return invoke("ai_engine_start");
}

/** Stop the engines Ganban started (leaves an externally-run Ollama alone). */
export async function aiEngineStop(): Promise<void> {
  await invoke("ai_engine_stop");
}

/** Reclaim the configured ragrat port from an EXTERNAL daemon Ganban can't
 * supervise (graceful first, force only if needed). Guard-railed in Rust: it
 * only ever stops a process that's actually ragrat listening on that port, and
 * never one Ganban started (use Stop for those). Returns a human-readable
 * outcome; throws with the reason when it declines. */
export async function aiEngineReclaimRagrat(): Promise<string> {
  return invoke<string>("ai_engine_reclaim_ragrat");
}
