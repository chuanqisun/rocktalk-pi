import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const DEFAULT_COMMAND_CANDIDATES = [
  { command: "mpg123", args: ["-q"], buildArgs: ({ device }) => (device ? ["-o", "alsa", "-a", device] : []) },
  { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error"] },
  { command: "cvlc", args: ["--play-and-exit", "--quiet"] },
  { command: "omxplayer", args: ["--no-osd"] },
  { command: "aplay", args: ["-q"] },
];

export default class AudioPlayer {
  #baseDir;
  #commandCandidates;
  #currentProcess = null;
  #currentFilePath = null;
  #currentPlaybackToken = 0;
  #device;
  #loop;

  /**
   * @param {{ baseDir?: string, device?: string, loop?: boolean, commandCandidates?: Array<{ command: string, args: string[], buildArgs?: (context: { device: string }) => string[] }> }} [options]
   */
  constructor({ baseDir, device = "", loop = false, commandCandidates = DEFAULT_COMMAND_CANDIDATES } = {}) {
    this.#baseDir = baseDir;
    this.#device = device;
    this.#loop = loop;
    this.#commandCandidates = commandCandidates;
  }

  get isPlaying() {
    return this.#currentProcess !== null;
  }

  async play(source) {
    const trimmedSource = typeof source === "string" ? source.trim() : "";

    if (!trimmedSource) {
      console.error("[audio] No audio file specified.");
      return false;
    }

    const filePath = this.#resolveSourcePath(trimmedSource);

    try {
      await access(filePath, constants.R_OK);
    } catch {
      console.error(`[audio] Audio file not found: ${filePath}`);
      return false;
    }

    this.stop();
    const playbackToken = ++this.#currentPlaybackToken;

    for (const candidate of this.#commandCandidates) {
      const started = await this.#startProcess(candidate, filePath, playbackToken);

      if (started) {
        return true;
      }
    }

    console.error("[audio] No supported audio playback command is available. Install one of: ffplay, mpg123, cvlc, omxplayer, aplay.");
    return false;
  }

  stop() {
    this.#currentPlaybackToken += 1;

    if (!this.#currentProcess) {
      return;
    }

    const processToStop = this.#currentProcess;
    this.#clearCurrentProcess(processToStop);

    if (processToStop.exitCode === null && !processToStop.killed) {
      processToStop.kill("SIGTERM");
    }
  }

  #resolveSourcePath(source) {
    if (isAbsolute(source) || !this.#baseDir) {
      return resolve(source);
    }

    return resolve(this.#baseDir, source);
  }

  async #startProcess(candidate, filePath, playbackToken) {
    return new Promise((resolvePromise) => {
      let settled = false;
      const candidateArgs = typeof candidate.buildArgs === "function" ? candidate.buildArgs({ device: this.#device }) : [];
      const child = spawn(candidate.command, [...candidate.args, ...candidateArgs, filePath], {
        stdio: ["ignore", "ignore", "pipe"],
      });

      const onError = (error) => {
        if (error && "code" in error && error.code === "ENOENT") {
          if (!settled) {
            settled = true;
            resolvePromise(false);
          }
          return;
        }

        console.error(`[audio] Failed to start ${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);

        if (!settled) {
          settled = true;
          resolvePromise(false);
        }
      };

      child.once("error", onError);

      child.stderr?.on("data", (chunk) => {
        const message = chunk.toString().trim();

        if (message) {
          console.error(`[audio] ${message}`);
        }
      });

      child.once("spawn", () => {
        this.#currentProcess = child;
        this.#currentFilePath = filePath;
        this.#currentPlaybackToken = playbackToken;

        child.once("exit", (code) => {
          this.#clearCurrentProcess(child);

          if (this.#loop && code === 0 && this.#currentPlaybackToken === playbackToken) {
            void this.#startProcess(candidate, filePath, playbackToken);
          }
        });

        if (!settled) {
          settled = true;
          resolvePromise(true);
        }
      });

      child.once("close", (code) => {
        if (code !== 0 && code !== null && this.#currentFilePath === filePath) {
          console.error(`[audio] ${candidate.command} exited with code ${code} while playing ${filePath}.`);
        }
      });
    });
  }

  #clearCurrentProcess(child) {
    if (this.#currentProcess === child) {
      this.#currentProcess = null;
      this.#currentFilePath = null;
    }
  }
}
