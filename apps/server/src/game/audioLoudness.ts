// What ffmpeg's ebur128 filter reports for one clip, read from its closing summary.

export interface Loudness {
  /** EBU R128 integrated loudness; null when the clip is too short or quiet to gate (ffmpeg's -70). */
  readonly integratedLufs: number | null;
  /** True peak; null for digital silence (-inf). */
  readonly truePeakDbtp: number | null;
}

/** The summary of `ffmpeg -i clip -af ebur128=peak=true -f null -`, or null when there is none. */
export const parseEbur128 = (stderr: string): Loudness | null => {
  const at = stderr.lastIndexOf("Summary:");
  if (at < 0) return null;
  const summary = stderr.slice(at);
  const integrated = /\bI:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary)?.[1];
  const peak = /\bPeak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary)?.[1];
  if (integrated === undefined) return null;
  const lufs = integrated === "-inf" ? null : Number(integrated);
  const dbtp = peak === undefined || peak === "-inf" ? null : Number(peak);
  return {
    integratedLufs: lufs === null || !Number.isFinite(lufs) || lufs <= -69.9 ? null : lufs,
    truePeakDbtp: dbtp === null || !Number.isFinite(dbtp) ? null : dbtp,
  };
};
