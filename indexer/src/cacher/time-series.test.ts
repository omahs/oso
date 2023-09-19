import * as path from "path";
import * as os from "os";
import { rimraf } from "rimraf";
import { mkdirp } from "mkdirp";
import {
  Cacheable,
  TimeSeriesCacheLookup,
  TimeSeriesCacheManager,
  TimeSeriesCacheWrapper,
} from "./time-series.js";
import { DateTime } from "luxon";
import {
  Range,
  findMissingRanges,
  rangeFromISO,
  rangeToString,
  rangesEqual,
} from "../utils/ranges.js";

function randomCacheable(range: Range): Cacheable<{ x: number }> {
  return {
    raw: { x: Math.round(Math.random() * 100000) },
    hasNextPage: false,
    cacheRange: range,
  };
}

describe("TimeSeriesCaching", () => {
  let tempDir: string;
  let manager: TimeSeriesCacheManager;
  let cache: TimeSeriesCacheWrapper;

  // Set up a temporary directory before each test
  beforeEach(async () => {
    // Create a temporary directory in the system's temporary directory
    tempDir = path.join(os.tmpdir(), "cache-test-dir");

    // Ensure the directory does not exist before creating it
    await rimraf(tempDir);

    // Create the temporary directory
    await mkdirp(tempDir);

    manager = new TimeSeriesCacheManager(tempDir);
    cache = new TimeSeriesCacheWrapper(manager);
  });

  // Tear down the temporary directory after each test
  // afterEach(async () => {
  //   // Remove the temporary directory and its contents
  //   await rimraf(tempDir);
  // });

  // describe('without cache initialized', () => {
  //   it('should be able to read and write to the cache', async () => {
  //     const lookup: TimeSeriesCacheLookup = {
  //       range: {
  //         startDate: DateTime.fromISO('2023-01-01T00:00:00Z'),
  //         endDate: DateTime.fromISO('2023-01-02T00:00:00Z'),
  //       },
  //       bucket: 'test',
  //       key: 'tester',
  //       normalizingUnit: 'day',
  //     }
  //     const cacheable = randomCacheable(lookup.range);
  //     await manager.write(lookup, cacheable);

  //     const loaded = await manager.load(lookup);
  //     expect(loaded.missingRanges()).toEqual([]);

  //     let pages = 0;
  //     for (const dir of loaded.directories()) {
  //       for await (const page of dir.load()) {
  //         expect(page.raw).toEqual(cacheable.raw);
  //         pages += 1;
  //       }
  //     }
  //     expect(pages).toEqual(1);
  //   });
  // })

  describe("with cache initialized", () => {
    // Used to compare the randomly generated data
    let cachedRangeToItems: Record<string, Cacheable<{ x: number }>[]> = {};

    beforeEach(async () => {
      // Setup the cache with some initial data
      cachedRangeToItems = {};

      // Ranges to create data
      const cachedRanges = [
        {
          startDate: DateTime.fromISO("2022-01-01T00:00:00Z"),
          endDate: DateTime.fromISO("2022-01-02T00:00:00Z"),
          hasCompletePages: true,
        },
        {
          startDate: DateTime.fromISO("2022-01-04T00:00:00Z"),
          endDate: DateTime.fromISO("2022-01-05T00:00:00Z"),
          hasCompletePages: true,
        },
        {
          startDate: DateTime.fromISO("2022-01-10T00:00:00Z"),
          endDate: DateTime.fromISO("2022-01-12T00:00:00Z"),
          hasCompletePages: false,
        },
      ];

      for (const r of cachedRanges) {
        const rangeStr = rangeToString(r);
        const pagesToGenerate = Math.round(Math.random() * 9) + 1;
        const pages = [];
        const lookup = TimeSeriesCacheLookup.new("bucket", "key", r);

        for (let i = 0; i < pagesToGenerate; i++) {
          const item = randomCacheable(r);
          if (i != pagesToGenerate - 1 || !r.hasCompletePages) {
            item.hasNextPage = true;
          }
          await manager.write(lookup, item, i);
          pages.push(item);
        }

        cachedRangeToItems[rangeStr] = pages;
      }
    });

    it("should work to retrieve data using the wrapper", async () => {
      let called = false;
      const lookup = TimeSeriesCacheLookup.new(
        "bucket",
        "key",
        rangeFromISO("2022-01-01T00:00:00Z", "2022-01-05T00:00:00Z"),
        "day",
      );
      const responses = cache.loadCachedOrRetrieve<{ x: number }>(
        lookup,
        async (missing) => {
          const expectedRange = rangeFromISO(
            "2022-01-01T00:00:00Z",
            "2022-01-05T00:00:00Z",
          );
          expect(rangesEqual(expectedRange, missing.range)).toBeTruthy();
          called = true;
          return randomCacheable(missing.range);
        },
      );

      const ranges: Range[] = [];

      for await (const res of responses) {
        ranges.push(res.cacheRange);
      }
      expect(called).toBe(true);

      const missingRanges = findMissingRanges(
        lookup.range.startDate,
        lookup.range.endDate,
        ranges,
      );
      expect(missingRanges).toEqual([]);
    });

    it("should call the retreiver when pages are missing", async () => {
      let called = false;
      const inputRange = rangeFromISO(
        "2022-01-10T00:00:00Z",
        "2022-01-12T00:00:00Z",
      );
      const lookup = TimeSeriesCacheLookup.fromRaw({
        range: inputRange,
        normalizingUnit: "day",
        bucket: "bucket",
        keys: ["key"],
      });
      const pageQueue = [0, 0];
      const pageQueueSize = pageQueue.length;
      const expectedCacheables = cachedRangeToItems[rangeToString(inputRange)];
      let lastCacheable = expectedCacheables.slice(-1)[0];
      const responses = cache.loadCachedOrRetrieve<{ x: number }>(
        lookup,
        async (missing, lastPage) => {
          console.log("missing boop? %j", missing);
          console.log("%j", lastPage);
          expect(lastPage?.raw.x).toBe(lastCacheable.raw.x);
          const cacheable = randomCacheable(missing.range);
          if (pageQueue.length > 0) {
            called = true;
            pageQueue.pop();
            cacheable.hasNextPage = true;
          }
          console.log("cacheable %j", cacheable);
          lastCacheable = cacheable;
          return cacheable;
        },
      );

      const ranges: Range[] = [];

      for await (const res of responses) {
        ranges.push(res.cacheRange);
      }
      expect(called).toBe(true);

      expect(ranges.length).toEqual(
        expectedCacheables.length + pageQueueSize + 1,
      );
    });
  });
});
