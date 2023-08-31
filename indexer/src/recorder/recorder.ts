import {
  Artifact,
  ArtifactNamespace,
  Contributor,
  ContributorNamespace,
  Event,
  EventType,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  IEventRecorder,
  IncompleteEvent,
  IEventTypeStrategy,
  generateEventTypeStrategy,
  IncompleteArtifact,
  IncompleteContributor,
} from "./types.js";
import { InmemActorResolver } from "./actors.js";
import { UniqueArray, asyncBatch } from "../utils/array.js";
import { streamFindAll as allEvents } from "../db/events.js";
import { streamFindAll as allContributors } from "../db/contributors.js";
import { streamFindAll as allArtifacts } from "../db/artifacts.js";
import { logger } from "../utils/logger.js";
import _ from "lodash";

export interface BatchEventRecorderOptions {
  maxBatchSize: number;
}

const defaultBatchEventRecorderOptions: BatchEventRecorderOptions = {
  maxBatchSize: 5000,
};

export class BatchEventRecorder implements IEventRecorder {
  private eventTypeStrategies: Record<string, IEventTypeStrategy>;
  private eventTypeQueues: Record<string, IncompleteEvent[]>;
  private options: BatchEventRecorderOptions;
  private actorDirectory: InmemActorResolver;
  private prisma: PrismaClient;
  private artifactNamespaces: ArtifactNamespace[];
  private contributorNamespaces: ContributorNamespace[];
  private actorsLoaded: boolean;
  private waitQueue: Record<string, Array<() => void>>;
  private isFlushing: Record<string, boolean>;

  constructor(prisma: PrismaClient, options?: BatchEventRecorderOptions) {
    this.prisma = prisma;
    this.eventTypeStrategies = {};
    this.eventTypeQueues = {};
    this.actorDirectory = new InmemActorResolver();
    this.options = _.merge(defaultBatchEventRecorderOptions, options);
    this.artifactNamespaces = [];
    this.contributorNamespaces = [];
    this.actorsLoaded = false;
    this.waitQueue = {};
    this.isFlushing = {};
    this.contributorQueue = []
  }

  setActorScope(
    artifactNamespaces: ArtifactNamespace[],
    contributorNamespaces: ContributorNamespace[],
  ) {
    this.artifactNamespaces = artifactNamespaces;
    this.contributorNamespaces = contributorNamespaces;
  }

  private async loadActors(): Promise<void> {
    if (this.artifactNamespaces.length === 0) {
      throw new Error("scope of recording must be set");
    }

    if (this.contributorNamespaces.length === 0) {
      throw new Error("scope of recording must be set");
    }

    logger.debug("loading all artifacts and contributors");

    // Load all of the artifacts
    const artifacts = await allArtifacts(
      this.prisma,
      this.options.maxBatchSize,
      {
        namespace: {
          in: this.artifactNamespaces,
        },
      },
    );

    let aCount = 0;
    for await (const raw of artifacts) {
      const artifact = raw as Artifact;
      this.actorDirectory.loadArtifact(artifact);
      aCount += 1;
    }
    logger.debug(`loaded ${aCount} artifacts`);

    // Load all of the contributors
    const contributors = await allContributors(
      this.prisma,
      this.options.maxBatchSize,
      {
        namespace: {
          in: this.contributorNamespaces,
        },
      },
    );

    let cCount = 0;
    for await (const raw of contributors) {
      const contributor = raw as Contributor;
      this.actorDirectory.loadContributor(contributor);
      cCount += 1;
    }
    logger.debug(`loaded ${cCount} contributors`);
    this.actorsLoaded = true;
  }

  // Records events into a queue and periodically flushes that queue as
  // transactions to the database.
  registerEventType(eventType: EventType, strategy: IEventTypeStrategy): void {
    this.eventTypeStrategies[eventType] = strategy;
  }

  record(event: IncompleteEvent): void {
    // Queue an event for writing
    const queue = this.getEventTypeQueue(event.eventType);
    queue.push(event);
  }

  private getEventTypeStrategy(eventType: EventType): IEventTypeStrategy {
    const strategy = this.eventTypeStrategies[eventType];
    if (!strategy) {
      return generateEventTypeStrategy(eventType);
    }
    return strategy;
  }

  async waitAll(): Promise<void[]> {
    // Wait for all queues to complete
    const results: void[] = [];
    for (const eventType in this.eventTypeQueues) {
      results.push(await this.wait(eventType as EventType));
    }
    return results;
  }

  wait(eventType: EventType): Promise<void> {
    if (!this.waitQueue[eventType]) {
      this.waitQueue[eventType] = [];
    }

    return new Promise<void>((resolve) => {
      this.waitQueue[eventType].push(() => {
        return resolve();
      })

      if (!this.isFlushing[eventType]) {
        this.isFlushing[eventType] = true;
        setImmediate(() => {
          this.flushQueue(eventType);
        })
      }
    });
  }

  private async addActors(artifacts: IncompleteArtifact[], contributors: IncompleteContributor[]): Promise<void> {
    const artifactPromise = new Promise({

    });
  }

  private async flushQueue(eventType: EventType): Promise<void> {
    if (!this.actorsLoaded) {
      await this.loadActors();
    }

    // Wait for a specific event type queue to complete
    const queue = this.getEventTypeQueue(eventType);
    if (queue.length === 0) {
      return;
    }
    this.eventTypeQueues[eventType] = [];

    logger.info(`emptying queue for ${eventType} with ${queue.length} items`);

    // Get the date range for the currently queued items
    let startDate = queue[0].eventTime;
    let endDate = queue[0].eventTime;
    queue.forEach((event) => {
      if (startDate > event.eventTime) {
        startDate = event.eventTime;
      }
      if (endDate < event.eventTime) {
        endDate = event.eventTime;
      }
    });

    // Get event type strategy
    const strategy = this.getEventTypeStrategy(eventType);
    const where = strategy.all(this.actorDirectory);
    where.eventTime = {
      gte: startDate.toJSDate(),
      lte: endDate.toJSDate(),
    };

    // Find existing events (for idempotency)
    const existingEvents = allEvents(
      this.prisma,
      this.options.maxBatchSize,
      where,
    );
    const existingEventMap: { [id: string]: Event } = {};

    for await (const raw of existingEvents) {
      const event = raw as Event;
      const id = await strategy.idFromEvent(this.actorDirectory, event);
      existingEventMap[id] = event;
    }

    const newEvents = [];
    const queuedArtifacts: UniqueArray<IncompleteArtifact> = new UniqueArray(
      (a) => `${a.name}::${a.namespace}`,
    );
    const queuedContributors: UniqueArray<IncompleteContributor> =
      new UniqueArray((c) => `${c.name}::${c.namespace}`);

    // Filter duplicates
    for (const event of queue) {
      const incompleteId = await strategy.idFromIncompleteEvent(
        this.actorDirectory,
        event,
      );
      if (event.eventType === EventType.STAR_AGGREGATE_STATS) {
        console.log(existingEventMap);
        console.log(incompleteId);
      }
      const existing = existingEventMap[incompleteId];
      if (!existing) {
        queuedArtifacts.push(event.artifact);
        if (event.contributor) {
          queuedContributors.push(event.contributor);
        }
        newEvents.push(event);
      }
    }
    logger.debug(`skipping ${queue.length - newEvents.length} existing events`);

    // Create all of the new actors involved
    const newArtifacts = this.actorDirectory.unknownArtifactsFrom(
      queuedArtifacts.items(),
    );
    const newContributors = this.actorDirectory.unknownContributorsFrom(
      queuedContributors.items(),
    );

    // Write all the new artifacts
    await asyncBatch(newArtifacts, this.options.maxBatchSize, async (batch) => {
      logger.debug("writing new artifacts");
      return this.prisma.artifact.createMany({
        data: batch.map((a) => {
          return {
            name: a.name,
            namespace: a.namespace,
            type: a.type,
          };
        }),
      });
    });

    // Write all the new contributors
    await asyncBatch(
      newContributors,
      this.options.maxBatchSize,
      async (batch) => {
        logger.debug("writing new contributors");
        await this.prisma.contributor.createMany({
          data: batch.map((a) => {
            return {
              name: a.name,
              namespace: a.namespace,
            };
          }),
        });
      },
    );

    // Load all of the actors again. We can improve this later
    await this.loadActors();

    await asyncBatch(
      newEvents,
      this.options.maxBatchSize,
      async (batch, batchLength) => {
        logger.info(`preparing to write a batch of ${batchLength} events`);
        const events: Prisma.EventCreateManyInput[] = await Promise.all(
          batch.map(async (e) => {
            const artifactId = await this.actorDirectory.resolveArtifactId(
              e.artifact,
            );
            let contributorId: number | null = null;
            if (e.contributor) {
              contributorId = await this.actorDirectory.resolveContributorId(
                e.contributor,
              );
            }
            const input: Prisma.EventCreateManyInput = {
              eventTime: e.eventTime.toJSDate(),
              artifactId: artifactId,
              contributorId: contributorId,
              eventType: e.eventType,
              amount: e.amount,
            };
            if (e.details) {
              input.details = e.details as Prisma.JsonObject;
            }
            return input;
          }),
        );

        const response = await this.prisma.event.createMany({
          data: events,
        });
        logger.debug(`completed writing batch of ${batchLength}`);
        return response;
      },
    );
  }

  protected getEventTypeQueue(eventType: EventType): IncompleteEvent[] {
    let queue = this.eventTypeQueues[eventType];
    if (!queue) {
      this.eventTypeQueues[eventType] = [];
      queue = this.eventTypeQueues[eventType];
    }
    return queue;
  }
}
