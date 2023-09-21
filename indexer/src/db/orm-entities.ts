import {
  BaseEntity,
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from "typeorm";
import { IsUrl, IsOptional, validateOrReject } from "class-validator";
import type { Brand } from "utility-types";
import { normalizeToObject } from "../utils/common.js";

export enum EventType {
  FUNDING,
  PULL_REQUEST_CREATED,
  PULL_REQUEST_MERGED,
  COMMIT_CODE,
  ISSUE_FILED,
  ISSUE_CLOSED,
  DOWNSTREAM_DEPENDENCY_COUNT,
  UPSTREAM_DEPENDENCY_COUNT,
  DOWNLOADS,
  CONTRACT_INVOKED,
  USERS_INTERACTED,
  CONTRACT_INVOKED_AGGREGATE_STATS,
  PULL_REQUEST_CLOSED,
  STAR_AGGREGATE_STATS,
  PULL_REQUEST_REOPENED,
  PULL_REQUEST_REMOVED_FROM_PROJECT,
  PULL_REQUEST_APPROVED,
  ISSUE_CREATED,
  ISSUE_REOPENED,
  ISSUE_REMOVED_FROM_PROJECT,
  STARRED,
  FORK_AGGREGATE_STATS,
  FORKED,
  WATCHER_AGGREGATE_STATS,
}

export enum ArtifactType {
  EOA_ADDRESS,
  SAFE_ADDRESS,
  CONTRACT_ADDRESS,
  GIT_REPOSITORY,
  GIT_EMAIL,
  GIT_NAME,
  GITHUB_ORG,
  GITHUB_USER,
  NPM_PACKAGE,
  FACTORY_ADDRESS,
}

export enum ArtifactNamespace {
  ETHEREUM,
  OPTIMISM,
  GOERLI,
  GITHUB,
  GITLAB,
  NPM_REGISTRY,
}

export enum JobStatus {
  PENDING,
  COMPLETE,
}

export enum JobExecutionStatus {
  ACTIVE,
  COMPLETE,
  FAILED,
}

abstract class Base<IdTag> extends BaseEntity {
  @PrimaryGeneratedColumn()
  id: Brand<number, IdTag>;

  @Column("timestamptz")
  createdAt: Date;
  @Column("timestamptz")
  updatedAt: Date;
  @Column("timestamptz", { nullable: true })
  deletedAt: Date | null;

  toJSON() {
    return normalizeToObject(this);
  }

  @BeforeInsert()
  @BeforeUpdate()
  async validate() {
    await validateOrReject(this);
  }
}

@Entity()
export class Collection extends Base<"CollectionId"> {
  @Column("text")
  name: string;

  @Column("text", { nullable: true })
  @IsOptional()
  description: string | null;

  @Column("boolean", { default: false })
  verified: boolean;

  @Column("text", { unique: true })
  slug: string;

  @ManyToMany(() => Project, (project) => project.collections)
  @JoinTable()
  projects: Project[];
}

@Entity()
export class Project extends Base<"ProjectId"> {
  @Column("text")
  name: string;

  @Column("text", { nullable: true })
  @IsOptional()
  description: string | null;

  @Column("boolean", { default: false })
  verified: boolean;

  @Column("text", { unique: true })
  slug: string;

  @ManyToMany(() => Collection, (collection) => collection.projects)
  collections: Collection[];

  @ManyToMany(() => Artifact, (artifact) => artifact.projects)
  @JoinTable()
  artifacts: Artifact[];
}

@Entity()
@Index(["namespace", "name"], { unique: true })
export class Artifact extends Base<"ArtifactId"> {
  @Column("enum", { enum: ArtifactType })
  type: ArtifactType;

  @Column("enum", { enum: ArtifactNamespace })
  namespace: ArtifactNamespace;

  @Column("text")
  name: string;

  @Column("text", { nullable: true })
  @IsUrl()
  @IsOptional()
  url: string | null;

  @ManyToMany(() => Project, (project) => project.artifacts)
  projects: Project[];

  @OneToMany(() => Event, (event) => event.to)
  eventsAsTo: Event[];
  @OneToMany(() => Event, (event) => event.from)
  eventsAsFrom: Event[];

  @OneToMany(() => EventPointer, (eventPointer) => eventPointer.artifact)
  eventPointers: EventPointer[];
}

@Entity()
@Index(["time"])
@Index(["sourceId"], { unique: true })
export class Event extends Base<"EventId"> {
  @Column("text")
  sourceId: string;

  @Column("enum", { enum: EventType })
  type: EventType;

  @Column("timestamptz")
  time: Date;

  @ManyToOne(() => Artifact, (artifact) => artifact.eventsAsTo)
  to: Artifact;

  @ManyToOne(() => Artifact, (artifact) => artifact.eventsAsFrom, {
    nullable: true,
  })
  @IsOptional()
  from: Artifact | null;

  @Column("float")
  amount: number;

  //@@unique([id, time])
}

@Entity()
@Index(["artifact", "collector", "startDate", "endDate"], { unique: true })
export class EventPointer extends Base<"EventPointerId"> {
  @ManyToOne(() => Artifact, (artifact) => artifact.eventPointers)
  artifact: Artifact;

  @Column("text")
  collector: string;

  @Column("jsonb")
  pointer: Record<string, any>;

  @Column("timestamptz")
  startDate: Date;

  @Column("timestamptz")
  endDate: Date;

  @Column("int")
  version: number;
}

@Entity()
export class Job extends Base<"JobId"> {
  @Column("text")
  execGroup: string;

  @Column("timestamptz")
  scheduledTime: Date;

  @Column("text")
  collector: string;

  @Column("enum", { enum: JobStatus })
  status: JobStatus;

  @OneToMany(() => JobExecution, (jobExecution) => jobExecution.job)
  executions: JobExecution[];
}

@Entity()
export class JobExecution extends Base<"JobExecutionId"> {
  @Column("enum", { enum: JobExecutionStatus })
  status: JobExecutionStatus;

  @ManyToOne(() => Job, (job) => job.executions)
  job: Job;

  @OneToMany(() => Log, (log) => log.execution)
  log: Log[];
}

@Entity()
export class Log extends Base<"LogId"> {
  @Column("text")
  level: string;

  @Column("jsonb")
  body: Record<string, any>;

  @ManyToOne(() => JobExecution, (jobExecution) => jobExecution.log)
  execution: JobExecution;
}
