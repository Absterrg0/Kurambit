/** A round's duration for its card: "1h 05m", "12 min", "40s". */
export const formatRunDuration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60)
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return minutes >= 1 ? `${minutes} min` : `${Math.max(0, Math.round(ms / 1000))}s`;
};
