import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { HLS_ENCODING_LADDER, EncodingRenditionPreset } from "../../config/constants.js";

const execFileAsync = promisify(execFile);

export interface MediaProbeMetadata {
  width: number;
  height: number;
  durationSeconds: number;
  videoCodec: string;
  audioCodec: string;
}

export interface TranscodedRenditionOutput {
  name: string;
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  codecs: string;
  playlistRelativePath: string;
  segmentCount: number;
  totalSizeBytes: bigint;
}

export class FFmpegProcessor {
  /**
   * Probes media metadata safely using execFile array arguments (preventing command injection).
   */
  static async probeMedia(inputFilePath: string): Promise<MediaProbeMetadata> {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=index,codec_name,codec_type,width,height",
      "-of",
      "json",
      inputFilePath,
    ];

    const { stdout } = await execFileAsync(env.FFPROBE_PATH, args, {
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
      }>;
      format?: { duration?: string };
    };

    const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
    const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");

    if (!videoStream || !videoStream.width || !videoStream.height) {
      throw new Error("Invalid media file: No valid video stream detected by ffprobe");
    }

    const durationSeconds = Number(parsed.format?.duration ?? 0);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("Invalid media file: Non-positive or corrupt duration");
    }

    return {
      width: videoStream.width,
      height: videoStream.height,
      durationSeconds,
      videoCodec: videoStream.codec_name ?? "unknown",
      audioCodec: audioStream?.codec_name ?? "aac",
    };
  }

  /**
   * Computes an adaptive bitrate ladder that never upscales above the source resolution.
   */
  static selectEncodingLadder(sourceHeight: number): EncodingRenditionPreset[] {
    const eligible = HLS_ENCODING_LADDER.filter((r) => r.height <= sourceHeight);
    if (eligible.length === 0) {
      return [HLS_ENCODING_LADDER[0]!];
    }
    return eligible;
  }

  /**
   * Transcodes source video into multiple HLS renditions + master.m3u8 playlist.
   */
  static async transcodeToHls(
    inputFilePath: string,
    outputDir: string,
    sourceMetadata: MediaProbeMetadata
  ): Promise<{
    masterPlaylistPath: string;
    posterPath: string;
    renditions: TranscodedRenditionOutput[];
  }> {
    await mkdir(outputDir, { recursive: true });
    const ladder = this.selectEncodingLadder(sourceMetadata.height);
    const renditionsOutput: TranscodedRenditionOutput[] = [];

    for (const preset of ladder) {
      const renditionDir = path.join(outputDir, preset.name);
      await mkdir(renditionDir, { recursive: true });

      const playlistPath = path.join(renditionDir, "index.m3u8");
      const segmentPattern = path.join(renditionDir, "segment_%04d.ts");

      const args = [
        "-y",
        "-i",
        inputFilePath,
        "-threads",
        String(env.WORKER_FFMPEG_THREADS),
        "-vf",
        `scale=w=${preset.width}:h=${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`,
        "-c:v",
        "libx264",
        "-profile:v",
        preset.profile,
        "-crf",
        "20",
        "-sc_threshold",
        "0",
        "-g",
        "48",
        "-keyint_min",
        "48",
        "-b:v",
        `${preset.videoBitrateKbps}k`,
        "-maxrate",
        `${preset.maxrateKbps}k`,
        "-bufsize",
        `${preset.bufsizeKbps}k`,
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-b:a",
        `${preset.audioBitrateKbps}k`,
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        segmentPattern,
        playlistPath,
      ];

      await execFileAsync(env.FFMPEG_PATH, args, {
        timeout: env.TRANSCODE_TIMEOUT_MS,
      });

      const files = await readdir(renditionDir);
      const tsSegments = files.filter((f) => f.endsWith(".ts"));
      let totalSize = 0n;
      for (const seg of tsSegments) {
        const st = await stat(path.join(renditionDir, seg));
        totalSize += BigInt(st.size);
      }

      renditionsOutput.push({
        name: preset.name,
        width: preset.width,
        height: preset.height,
        videoBitrateKbps: preset.videoBitrateKbps,
        audioBitrateKbps: preset.audioBitrateKbps,
        codecs: "avc1.640028,mp4a.40.2",
        playlistRelativePath: `${preset.name}/index.m3u8`,
        segmentCount: tsSegments.length,
        totalSizeBytes: totalSize,
      });
    }

    // Build HLS Master Playlist
    const masterLines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"];
    for (const r of renditionsOutput) {
      const bandwidth = (r.videoBitrateKbps + r.audioBitrateKbps) * 1000;
      masterLines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height},CODECS="${r.codecs}"`,
        r.playlistRelativePath
      );
    }

    const masterPlaylistPath = path.join(outputDir, "master.m3u8");
    await writeFile(masterPlaylistPath, masterLines.join("\n") + "\n", "utf8");

    // Extract Poster Frame at 10% of video duration
    const posterPath = path.join(outputDir, "poster.jpg");
    const captureSecond = Math.max(1, Math.floor(sourceMetadata.durationSeconds * 0.1));
    await execFileAsync(
      env.FFMPEG_PATH,
      [
        "-y",
        "-ss",
        String(captureSecond),
        "-i",
        inputFilePath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        posterPath,
      ],
      { timeout: 30000 }
    );

    return {
      masterPlaylistPath,
      posterPath,
      renditions: renditionsOutput,
    };
  }
}
