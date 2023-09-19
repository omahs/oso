import { DateTime } from "luxon";
import { GenericError } from "../common/errors.js";
import * as path from "path";
import * as fs from "fs/promises";
import { fileExists } from "../utils/files.js";
import { mkdirp } from "mkdirp";
import {
  doRangesIntersect,
  findMissingRanges,
  Range,
  rangeFromISO,
  rangeFromObj,
} from "../utils/ranges.js";
import { createHash } from "crypto";
import _ from "lodash";

export class CacheDoesNotExist extends GenericError {}
export class InvalidCache extends GenericError {}

const CACHE_FILE_PATTERN = /\d+.json/;
const CACHE_DIRECTORY_PATTERN =
  /(?<startDate>\d{4}-\d{2}-\d{2}-\d{2})-(?<endDate>\d{4}-\d{2}-\d{2}-\d{2})/;
const DATE_TO_NAME_FORMAT = "yyyy-LL-dd-HH";

// Types for a generic caching mechanism
export type Cacheable<T> = {
  raw: T;

  cacheRange: Range;

  cursor?: any;

  hasNextPage: boolean;
};

export type CacheableMeta = {
  cacheRange: Range;
  input: string[];
};

type RawCacheableMeta = {
  cacheRange: {
    startDate: string;
    endDate: string;
  };
  input: string[];
};

type RawCacheable = {
  raw: unknown;
  cacheRange: {
    startDate: string;
    endDate: string;
  };
  cursor?: any;
  hasNextPage: boolean;
};

async function cacheableFromFile<T>(path: string): Promise<Cacheable<T>> {
  const raw = JSON.parse(
    await fs.readFile(path, { encoding: "utf-8" }),
  ) as RawCacheable;
  return {
    raw: raw.raw as T,
    cacheRange: rangeFromISO(raw.cacheRange.startDate, raw.cacheRange.endDate),
    cursor: raw.cursor,
    hasNextPage: raw.hasNextPage,
  };
}

export interface ICacheGroup {
  range: Range;

  load<T>(): AsyncGenerator<Cacheable<T>>;

  validForKey(key: string): Promise<boolean>;
}

class CachePageDirectory implements ICacheGroup {
  range: Range;
  path: string;
  private inputMap: Record<string, boolean>;
  private meta: CacheableMeta | undefined;
  private initialized: boolean;

  private constructor(range: Range, path: string) {
    this.range = range;
    this.path = path;
    this.inputMap = {};
    this.initialized = false;
  }

  static async load(range: Range, path: string): Promise<CachePageDirectory> {
    const dir = new CachePageDirectory(range, path);
    await dir.loadMeta();
    return dir;
  }

  private async loadMeta(): Promise<void> {
    const metaPath = path.join(this.path, "meta.json");
    if (!(await fileExists(metaPath))) {
      throw new InvalidCache(`${path} is not a valid cache directory`);
    }

    // Load the meta file
    const rawMeta = JSON.parse(
      await fs.readFile(metaPath, { encoding: "utf-8" }),
    ) as RawCacheableMeta;

    // Attempt to parse the metadata
    const range = rangeFromObj(rawMeta.cacheRange);
    this.meta = {
      input: rawMeta.input,
      cacheRange: range,
    };
    return;
  }

  async validForKey(key: string): Promise<boolean> {
    if (!this.initialized) {
      this.inputMap = this.meta!.input.reduce<Record<string, boolean>>(
        (acc, curr) => {
          acc[curr] = true;
          return acc;
        },
        {},
      );
      this.initialized = true;
    }
    return this.inputMap[key];
  }

  private async cachePagesPaths(): Promise<string[]> {
    const files = await fs.readdir(this.path);
    const pageNumbers: number[] = files
      .filter((f) => {
        return f.match(CACHE_FILE_PATTERN);
      })
      .map((f) => {
        return parseInt(f.split(".")[0]);
      });
    pageNumbers.sort((a, b) => a - b);
    return pageNumbers.map((n) => path.join(this.path, `${n}.json`));
  }

  async *load<T>(): AsyncGenerator<Cacheable<T>> {
    // yield all of the cache directories' pages in order duplicates can occur
    // if the mechanism that has written into the directory structure allows
    // duplicates. We will assume that's fine.
    for (const pagePath of await this.cachePagesPaths()) {
      yield await cacheableFromFile(pagePath);
    }
  }
}

export interface ITimeSeriesCacheLookup {
  // Used to put caches in buckets for lookup.
  bucket: string;

  // Usually a hash of the input for the cache
  keys: string[];

  // Cache range to search for
  range: Range;

  // What is the unit of we should normalize to (only days or hours at this time)
  normalizingUnit: TimeSeriesLookupNormalizingUnit;
}

export type TimeSeriesLookupNormalizingUnit = "day" | "hour";

export class TimeSeriesCacheLookup implements ITimeSeriesCacheLookup {
  private _bucket: string;
  private _keys: string[];
  private _range: Range;
  private _normalizingUnit: TimeSeriesLookupNormalizingUnit;

  private constructor(
    bucket: string,
    keys: string[],
    range: Range,
    normalizingUnit: TimeSeriesLookupNormalizingUnit,
  ) {
    this._bucket = bucket;
    this._keys = keys;
    this._range = range;
    this._normalizingUnit = normalizingUnit;
  }

  static new(
    bucket: string,
    keys: string | string[],
    range: Range,
    normalizingUnit?: TimeSeriesLookupNormalizingUnit,
  ) {
    const sortedKeys = Array.isArray(keys) ? keys : [keys];
    sortedKeys.sort();

    return new TimeSeriesCacheLookup(
      bucket,
      sortedKeys,
      range,
      normalizingUnit || "day",
    );
  }

  static fromRaw(raw: ITimeSeriesCacheLookup) {
    const sortedKeys = _.clone(raw.keys);
    sortedKeys.sort();

    return new TimeSeriesCacheLookup(
      raw.bucket,
      sortedKeys,
      raw.range,
      raw.normalizingUnit,
    );
  }

  get bucket() {
    return this._bucket;
  }

  get keys() {
    return this._keys;
  }

  get range() {
    return this._range;
  }

  get normalizingUnit() {
    return this._normalizingUnit;
  }
}

export type PageRetreiver<T> = (
  lookup: ITimeSeriesCacheLookup,
  lastPage?: Cacheable<T>,
) => Promise<Cacheable<T>>;

export interface ITimeSeriesCacheManager {
  load(
    lookup: ITimeSeriesCacheLookup,
    page?: number,
  ): Promise<TimeSeriesCacheCollection>;
  write<T>(
    lookup: ITimeSeriesCacheLookup,
    item: Cacheable<T>,
    page?: number,
  ): Promise<void>;
}

/**
 * TimeSeriesCacheManager
 *
 * Uses a combination of database pointers and files to manage a time series
 * cache.
 */
/*
export class TimeSeriesCacheManager implements ITimeSeriesCacheManager {
  async load(lookup: TimeSeriesCacheLookup, page?: number | undefined): Promise<ITimeSeriesCacheCollection> {
    return new TimeSeriesCacheCollection([], lookup);
  }

  async write<T>(lookup: TimeSeriesCacheLookup, item: Cacheable<T>, page?: number | undefined): Promise<void> {

  }
}*/

/**
 * TimeSeriesCacheManager
 *
 * Caches responses so that we can query anything within a specific time range.
 * The keys are stored on disk as a way to determine missing data.
 *
 *     {cache-dir}/{bucket}/{startDate}-{endDate}/{keysHash}/{pageNumber}.json
 *
 * Minimum resolution of start/end times is hours, anything less is ignored.
 */
export class TimeSeriesCacheManager implements ITimeSeriesCacheManager {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  async load(
    lookup: ITimeSeriesCacheLookup,
    _page?: number,
  ): Promise<TimeSeriesCacheCollection> {
    const startDateSearch = lookup.range.startDate.startOf(
      lookup.normalizingUnit,
    );
    const endDateSearch = lookup.range.endDate.startOf(lookup.normalizingUnit);
    const normalizedRange = {
      startDate: startDateSearch,
      endDate: endDateSearch,
    };

    // Check if the directory exists. If not, return an empty set
    if (!(await this.fileExists(lookup.bucket))) {
      return new TimeSeriesCacheCollection([], lookup);
    }

    // List files in the cache. See if any match what we need.
    const allCacheDirectories = await this.listAvailableCacheDirectories(
      lookup.bucket,
    );
    const cacheDirectories = allCacheDirectories.filter((cd) => {
      return doRangesIntersect(cd.range, normalizedRange);
    });
    return new TimeSeriesCacheCollection(cacheDirectories, lookup);
  }

  keysHash(lookup: ITimeSeriesCacheLookup): string {
    const hash = createHash("sha256");
    lookup.keys.forEach((key) => {
      hash.update(key);
    });
    return hash.digest("hex");
  }

  async write<T>(
    lookup: ITimeSeriesCacheLookup,
    item: Cacheable<T>,
    page?: number,
  ): Promise<void> {
    const startDateWrite = lookup.range.startDate.startOf(
      lookup.normalizingUnit,
    );
    const endDateWrite = lookup.range.endDate.startOf(lookup.normalizingUnit);
    const cacheDirParts = [
      lookup.bucket,
      `${startDateWrite.toFormat(DATE_TO_NAME_FORMAT)}-${endDateWrite.toFormat(
        DATE_TO_NAME_FORMAT,
      )}`,
      this.keysHash(lookup),
    ];
    await this.ensureDirectory(...cacheDirParts);

    const pageCachePath = this.cachePath(
      ...[...cacheDirParts, `${page || 0}.json`],
    );

    const pageCacheMetaPath = this.cachePath(
      ...[...cacheDirParts, `meta.json`],
    );

    // This does not validate page numbers so it will just overwrite things.
    const toCache: RawCacheable = {
      cacheRange: {
        startDate: item.cacheRange.startDate.setZone("utc").toISO()!,
        endDate: item.cacheRange.endDate.setZone("utc").toISO()!,
      },
      cursor: item.cursor,
      hasNextPage: item.hasNextPage,
      raw: item.raw,
    };

    // Add the meta file if this is the first page
    if (!page) {
      const metaOnly: RawCacheableMeta = {
        cacheRange: {
          startDate: item.cacheRange.startDate.setZone("utc").toISO()!,
          endDate: item.cacheRange.endDate.setZone("utc").toISO()!,
        },
        input: lookup.keys,
      };
      await fs.writeFile(pageCacheMetaPath, JSON.stringify(metaOnly), {
        encoding: "utf-8",
      });
    }
    return await fs.writeFile(pageCachePath, JSON.stringify(toCache), {
      encoding: "utf-8",
    });
  }

  private async ensureDirectory(...paths: string[]) {
    return await mkdirp(this.cachePath(...paths));
  }

  private async fileExists(...paths: string[]): Promise<boolean> {
    return await fileExists(this.cachePath(...paths));
  }

  private async listAvailableCacheDirectories(...paths: string[]) {
    const files = await this.listCacheCompatibleDirectories(...paths);
    const cacheDirectories = await Promise.all(
      files.flatMap((f) => {
        try {
          return this.loadCachePageDirectories(
            f,
            this.cachePath(...[...paths, f]),
          );
        } catch (err) {
          if (err instanceof InvalidCache) {
            return [];
          } else {
            throw err;
          }
        }
      }),
    );
    return cacheDirectories.flat(1);
  }

  private async listCacheCompatibleDirectories(...paths: string[]) {
    const names = await fs.readdir(this.cachePath(...paths));

    const filtered = names.filter((f) => {
      if (!f.match(CACHE_DIRECTORY_PATTERN)) {
        return false;
      }
      return true;
    });
    return filtered;
  }

  private cachePath(...paths: string[]) {
    return path.join(this.cacheDir, ...paths);
  }

  private async loadCachePageDirectories(
    name: string,
    dirPath: string,
  ): Promise<CachePageDirectory[]> {
    const match = CACHE_DIRECTORY_PATTERN.exec(name);

    if (!match?.groups) {
      throw new InvalidCache(`Unexpected cache directory name ${name}`);
    }

    const range = {
      startDate: DateTime.fromFormat(
        match.groups.startDate,
        DATE_TO_NAME_FORMAT,
        { zone: "utc" },
      ),
      endDate: DateTime.fromFormat(match.groups.endDate, DATE_TO_NAME_FORMAT, {
        zone: "utc",
      }),
    };
    // List the pages by the keysHash
    const dirs: CachePageDirectory[] = [];
    const names = await fs.readdir(dirPath);
    for (const name of names) {
      try {
        const dir = await CachePageDirectory.load(
          range,
          path.join(dirPath, name),
        );
        dirs.push(dir);
      } catch (err) {
        if (err instanceof InvalidCache) {
          continue;
        }
        throw err;
      }
    }
    return dirs;
  }
}

export interface ITimeSeriesCacheCollection {
  missing(): Promise<ITimeSeriesCacheLookup[]>;
  groups(): AsyncGenerator<ICacheGroup>;
}

/**
 * A set of cached files matching a lookup
 */
export class TimeSeriesCacheCollection implements ITimeSeriesCacheCollection {
  private _groups: ICacheGroup[];
  private lookup: ITimeSeriesCacheLookup;

  constructor(groups: ICacheGroup[], lookup: ITimeSeriesCacheLookup) {
    this._groups = groups;
    this.lookup = lookup;
  }

  async missing(): Promise<ITimeSeriesCacheLookup[]> {
    // Iterate through the range of things that are available. This algorithm
    // isn't super smart. It's mostly for best case scenarios. Instead, we
    // should try to keep the input to this quite consistently within some time
    // ranges. Essentially if _any_ data is missing we will make attempts to
    // query for that within this time range. So this shouldn't be used if you
    // want to get large sections of time where you'll likely have sparse
    // caches. Instead, you should queue up multiple jobs for each of those time
    // periods.

    // Iterate through all inputs. If that input is missing _anything_. Then we
    // add it to the "missing" queue for this period.

    const keys = this.lookup.keys;

    const missingKeys: string[] = [];
    for (const key of keys) {
      // Does this key have all date ranges? If not add it to the missing lookup
      const rangesForKey: Range[] = [];
      for (const group of this._groups) {
        if (await group.validForKey(key)) {
          rangesForKey.push(group.range);
        }
      }
      const missing = findMissingRanges(
        this.lookup.range.startDate,
        this.lookup.range.endDate,
        rangesForKey,
      );
      if (missing.length > 0) {
        missingKeys.push(key);
      }
    }
    if (missingKeys.length > 0) {
      return [
        {
          bucket: this.lookup.bucket,
          keys: missingKeys,
          range: this.lookup.range,
          normalizingUnit: this.lookup.normalizingUnit,
        },
      ];
    } else {
      return [];
    }
  }

  async *groups(): AsyncGenerator<ICacheGroup> {
    for (const dir of this._groups) {
      yield dir;
    }
  }
}

export class TimeSeriesCacheWrapper {
  private manager: ITimeSeriesCacheManager;

  constructor(manager: ITimeSeriesCacheManager) {
    this.manager = manager;
  }

  /**
   * Loads from cache or through some retreiver callback
   *
   * @param lookup Lookup parameters for the time series cache
   * @param retriever callback to use to load any additional things and automatically cache
   */
  async *loadCachedOrRetrieve<T>(
    lookup: ITimeSeriesCacheLookup,
    retriever: PageRetreiver<T>,
  ): AsyncGenerator<Cacheable<T>> {
    // Determine if the lookup matches anything in the cache. If not then call the retreiver
    const currentPage = 0;

    const missingQueue: Array<
      [ITimeSeriesCacheLookup, Cacheable<T> | undefined]
    > = [];
    const response = await this.attemptCacheLoad(lookup, currentPage);
    if (response) {
      // Load everything from cache that we can and then queue the missing pages as needed
      for await (const dir of response.groups()) {
        let lastPage: Cacheable<T> | undefined = undefined;

        for await (const page of dir.load<T>()) {
          yield page;
          lastPage = page;
        }

        if (lastPage && lastPage.hasNextPage) {
          // We're missing pages... queue this up for retrieval
          missingQueue.push([lookup, lastPage]);
        }
      }
      const misses = await response.missing();
      for (const missing of misses) {
        missingQueue.push([missing, undefined]);
      }
    } else {
      missingQueue.push([lookup, undefined]);
    }

    for (const missing of missingQueue) {
      let lastPage = missing[1];

      while (true) {
        const page = await retriever(missing[0], lastPage);

        // Write the page to cache
        await this.manager.write(lookup, page);

        // Yield the page
        yield page;

        lastPage = page;

        if (!page.hasNextPage) {
          break;
        }
      }
    }
  }

  async attemptCacheLoad(
    lookup: ITimeSeriesCacheLookup,
    page: number,
  ): Promise<TimeSeriesCacheCollection | undefined> {
    try {
      const response = await this.manager.load(lookup, page);
      return response;
    } catch (e) {
      if (!(e instanceof CacheDoesNotExist)) {
        throw e;
      }
    }
    return;
  }
}
