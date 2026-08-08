import { spawn } from "node:child_process";

/** Convert arbitrary audio bytes to a Telegram-compatible mono OGG/Opus buffer. */
export function toOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-f",
        "ogg",
        "pipe:1",
      ],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let diagnostics = "";

    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.stderr.on("data", (data: Buffer) => {
      diagnostics += data.toString();
    });
    child.on("error", (error) => {
      rejectDone(new Error(`ffmpeg est introuvable ou impossible à lancer : ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        resolveDone(Buffer.concat(chunks));
      } else {
        const detail = diagnostics.trim().split("\n").filter(Boolean).at(-1);
        rejectDone(new Error(`ffmpeg n'a pas pu convertir l'audio${detail ? ` : ${detail}` : ` (code ${code})`}`));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
