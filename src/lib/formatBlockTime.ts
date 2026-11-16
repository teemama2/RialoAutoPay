/**
 * Formats Rialo block timestamps supplied in either Unix seconds
 * or Unix milliseconds.
 *
 * Modern Unix timestamps below 100 billion are treated as seconds;
 * larger values are treated as milliseconds.
 */
export function formatBlockTime(value: bigint | null): string {
  if (value === null) {
    return "Not supplied by Rialo RPC";
  }

  const timestamp = Number(value);

  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    return `Unix timestamp: ${value.toString()}`;
  }

  const milliseconds =
    timestamp >= 100_000_000_000
      ? timestamp
      : timestamp * 1000;

  if (!Number.isSafeInteger(milliseconds)) {
    return `Unix timestamp: ${value.toString()}`;
  }

  const date = new Date(milliseconds);

  if (Number.isNaN(date.getTime())) {
    return `Unix timestamp: ${value.toString()}`;
  }

  return (
    new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(date) + " UTC"
  );
}
