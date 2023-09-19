import { DateTime } from "luxon";

export interface Range {
  startDate: DateTime;
  endDate: DateTime;
}

export function rangeFromISO(startDateISO: string, endDateISO: string): Range {
  const startDate = DateTime.fromISO(startDateISO);
  const endDate = DateTime.fromISO(endDateISO);
  if (!(startDate.isValid && endDate.isValid)) {
    throw new Error("range is invalid");
  }
  return {
    startDate: startDate,
    endDate: endDate,
  };
}

export function rangeFromObj(obj: {
  startDate: string;
  endDate: string;
}): Range {
  return rangeFromISO(obj.startDate, obj.endDate);
}

export function rangesEqual(a: Range, b: Range): boolean {
  // DateTime#equals doesn't always behave as expected even when timezones are
  // seemingly the same GMT+00:00 or Z for example don't have equality (which
  // they should)
  return (
    a.startDate.toUnixInteger() === b.startDate.toUnixInteger() &&
    a.endDate.toUnixInteger() === b.endDate.toUnixInteger()
  );
}

export function rangeToString(r: Range) {
  return `${r.startDate.setZone("utc").toISO()}-${r.endDate
    .setZone("utc")
    .toISO()}`;
}

export function doRangesIntersect(a: Range, b: Range): boolean {
  if (a.endDate.toUnixInteger() == a.startDate.toUnixInteger()) {
    throw new Error("a is not a valid range");
  }
  if (b.endDate.toUnixInteger() == b.startDate.toUnixInteger()) {
    throw new Error("b is not a valid range");
  }
  return a.startDate < b.endDate && a.endDate > b.startDate;
}

export function findMissingRanges(
  startDate: DateTime,
  endDate: DateTime,
  ranges: Range[],
): Range[] {
  const sortedRanges = ranges.sort(
    (a, b) => a.startDate.toUnixInteger() - b.startDate.toUnixInteger(),
  );

  const missingRanges: Range[] = [];
  let currentStartDate: DateTime = startDate;
  let currentEndDate: DateTime | null = null;

  for (const range of sortedRanges) {
    const rangeStartDate = range.startDate;
    const rangeEndDate = range.endDate;

    if (currentStartDate < rangeStartDate) {
      currentEndDate = rangeStartDate;
      missingRanges.push({
        startDate: currentStartDate,
        endDate: currentEndDate,
      });
    }
    currentStartDate = rangeEndDate;
  }

  if (currentStartDate < endDate) {
    missingRanges.push({ startDate: currentStartDate, endDate: endDate });
  }

  return missingRanges;
}

export function getRangeDuration(range: Range): number {
  // Calculate the duration of the range in milliseconds
  return range.endDate.toUnixInteger() - range.startDate.toUnixInteger();
}

export function removeOverlappingRanges(ranges: Range[]): Range[] {
  // Sort the ranges by their start dates
  const sortedRanges = ranges.sort(
    (a, b) => a.startDate.toUnixInteger() - b.startDate.toUnixInteger(),
  );

  const nonOverlappingRanges: Range[] = [];
  let currentRange: Range | null = null;

  for (const range of sortedRanges) {
    if (currentRange === null) {
      currentRange = range;
    } else {
      // Check if the current range overlaps with the next range
      if (currentRange.endDate >= range.startDate) {
        // If overlapping, choose the larger time range by duration
        if (getRangeDuration(range) > getRangeDuration(currentRange)) {
          currentRange = range;
        }
      } else {
        // If not overlapping, add the current range to the result and update the current range
        nonOverlappingRanges.push(currentRange);
        currentRange = range;
      }
    }
  }

  // Add the last remaining range, if any
  if (currentRange !== null) {
    nonOverlappingRanges.push(currentRange);
  }

  return nonOverlappingRanges;
}
