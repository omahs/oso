import time
import asyncio
import os
import arrow
import re
import io
import json
import random
import threading

import polars
from dask.distributed import get_worker
from dask_kubernetes.operator import make_cluster_spec
from dataclasses import dataclass, field
from typing import List, Mapping, Tuple, Dict, Callable, Optional, Sequence
import heapq
from dagster import (
    asset,
    op,
    job,
    asset_sensor,
    asset_check,
    AssetExecutionContext,
    RunRequest,
    SensorEvaluationContext,
    EventLogEntry,
    RunConfig,
    OpExecutionContext,
    DagsterLogManager,
    DefaultSensorStatus,
    AssetsDefinition,
    AssetChecksDefinition,
)
from dagster_gcp import BigQueryResource, GCSResource
from google.api_core.exceptions import (
    NotFound,
    InternalServerError,
    ClientError,
)
from google.cloud.bigquery import (
    TableReference,
    LoadJobConfig,
    SourceFormat,
    Client as BQClient,
)
from google.cloud.bigquery.schema import SchemaField
from .dask import setup_kube_cluster_client, DuckDBGCSPlugin, RetryTaskManager
from ...cbt import CBTResource, UpdateStrategy, TimePartitioning
from .. import AssetFactoryResponse
from ...utils.gcs import batch_delete_blobs
from .config import GoldskyConfig


@dataclass
class GoldskyCheckpoint:
    job_id: str
    timestamp: int
    worker_checkpoint: int

    def __lt__(self, other):
        if self.timestamp < other.timestamp:
            return True
        else:
            if self.timestamp != other.timestamp:
                return False
            if self.job_id < other.job_id:
                return True
            else:
                if self.job_id != other.job_id:
                    return False
                return self.worker_checkpoint < other.worker_checkpoint

    def __le__(self, other):
        if self == other:
            return True
        return self < other

    def __eq__(self, other):
        return (
            self.timestamp == other.timestamp
            and self.job_id == other.job_id
            and self.worker_checkpoint == other.worker_checkpoint
        )

    def __gt__(self, other):
        if self == other:
            return False
        return other < self

    def __ge__(self, other):
        if self == other:
            return True
        return self > other


class GoldskyCheckpointRange:
    def __init__(
        self,
        start: Optional[GoldskyCheckpoint] = None,
        end: Optional[GoldskyCheckpoint] = None,
    ):
        self._start = start or GoldskyCheckpoint("0", 0, 0)
        self._end = end

    def in_range(self, checkpoint: GoldskyCheckpoint) -> bool:
        if checkpoint >= self._start:
            if self._end is None:
                return True
            else:
                return checkpoint < self._end
        else:
            return False


@dataclass
class GoldskyQueueItem:
    checkpoint: GoldskyCheckpoint
    blob_name: str
    blob_match: re.Match

    def __lt__(self, other):
        return self.checkpoint < other.checkpoint


class GoldskyQueue:
    def __init__(self, max_size: int):
        self.queue = []
        self._dequeues = 0
        self.max_size = max_size

    def enqueue(self, item: GoldskyQueueItem):
        heapq.heappush(self.queue, item)

    def dequeue(self) -> GoldskyQueueItem | None:
        if self._dequeues > self.max_size - 1:
            return None
        try:
            item = heapq.heappop(self.queue)
            self._dequeues += 1
            return item
        except IndexError:
            return None

    def len(self):
        return len(self.queue)

    def empty(self):
        self.queue = []


class GoldskyQueues:
    def __init__(self, max_size: int):
        self.queues: Mapping[str, GoldskyQueue] = {}
        self.max_size = max_size

    def enqueue(self, worker: str, item: GoldskyQueueItem):
        queue = self.queues.get(worker, GoldskyQueue(max_size=self.max_size))
        queue.enqueue(item)
        self.queues[worker] = queue

    def dequeue(self, worker: str) -> GoldskyQueueItem | None:
        queue = self.queues.get(worker, GoldskyQueue(max_size=self.max_size))
        return queue.dequeue()

    def peek(self) -> GoldskyQueueItem | None:
        """Get a value off the top of the queue without popping it"""
        keys = list(self.queues.keys())
        if len(keys) > 0:
            queue = self.queues.get(keys[0])
            item = queue.dequeue()
            queue.enqueue(item)
            return item
        return None

    def empty(self, worker: str):
        queue = self.queues.get(worker, None)
        if queue:
            queue.empty()

    def empty_all(self):
        for _, queue in self.queues.items():
            queue.empty()

    def workers(self):
        return self.queues.keys()

    def status(self):
        status: Mapping[str, int] = {}
        for worker, queue in self.queues.items():
            status[worker] = queue.len()
        return status

    def worker_queues(self):
        return self.queues.items()


@dataclass
class GoldskyProcessItem:
    source: str
    destination: str
    checkpoint: int


def process_goldsky_file(item: GoldskyProcessItem):
    worker = get_worker()
    plugin: DuckDBGCSPlugin = worker.plugins["duckdb-gcs"]
    query = f"""
        COPY (
            SELECT {item.checkpoint} as _checkpoint, *
            FROM read_parquet('{item.source}')
        ) TO '{item.destination}';
    """
    print(f"Querying with: {query}")
    worker.log_event("info", {"message": "running query", "query": query})
    plugin.conn.sql(query)
    return True


class GoldskyWorker:
    def __init__(
        self,
        name: str,
        job_id: str,
        pointer_table: str,
        latest_checkpoint: GoldskyCheckpoint | None,
        gcs: GCSResource,
        bigquery: BigQueryResource,
        config: GoldskyConfig,
        queue: GoldskyQueue,
        schema: List[SchemaField] | None,
    ):
        self.name = name
        self.job_id = job_id
        self.pointer_table = pointer_table
        self.latest_checkpoint = latest_checkpoint
        self.gcs = gcs
        self.bigquery = bigquery
        self.config = config
        self.queue = queue
        self.schema = schema or []

    def worker_destination_uri(self, filename: str):
        return f"gs://{self.config.source_bucket_name}/{self.worker_destination_path(filename)}"

    def worker_destination_path(self, filename: str):
        return f"{self.config.working_destination_preload_path}/{self.job_id}/{self.name}/{filename}"

    @property
    def raw_table(self) -> TableReference:
        with self.bigquery.get_client() as client:
            dest_table_ref = client.get_dataset(
                self.config.working_destination_dataset_name
            ).table(f"{self.config.destination_table_name}_{self.name}")
            return dest_table_ref

    @property
    def deduped_table(self) -> TableReference:
        with self.bigquery.get_client() as client:
            dest_table_ref = client.get_dataset(
                self.config.working_destination_dataset_name
            ).table(f"{self.config.destination_table_name}_deduped_{self.name}")
            return dest_table_ref

    @property
    def worker_wildcard_uri(self):
        return self.worker_destination_uri("table_*.parquet")

    async def process(self, context: AssetExecutionContext):
        raise NotImplementedError("process not implemented on the base class")


def bq_retry(
    context: AssetExecutionContext, f: Callable, retries: int = 5, min_wait: float = 1.0
):
    retry_wait = min_wait
    for i in range(retries):
        try:
            return f()
        except InternalServerError:
            context.log.info("Server error encountered. waiting to retry")
            time.sleep(retry_wait)
            retry_wait += min_wait
        except ClientError as e:
            raise e


class DirectGoldskyWorker(GoldskyWorker):
    async def process(
        self,
        context: AssetExecutionContext,
        pointer_table_mutex: threading.Lock,
    ):
        await asyncio.to_thread(
            self.run_load_bigquery_load,
            context,
            pointer_table_mutex,
        )
        return self

    def commit_pointer(
        self,
        context: AssetExecutionContext,
        files_to_load: List[str],
        checkpoint: GoldskyCheckpoint,
        pointer_table_mutex: threading.Lock,
    ):
        with self.bigquery.get_client() as client:
            job_config_options = dict(
                source_format=SourceFormat.PARQUET,
            )
            if len(self.schema) > 0:
                context.log.debug("schema being overridden")
                job_config_options["schema"] = self.schema
            job_config = LoadJobConfig(**job_config_options)

            def load_retry():
                load_job = client.load_table_from_uri(
                    files_to_load,
                    self.raw_table,
                    job_config=job_config,
                    timeout=self.config.load_table_timeout_seconds,
                )
                return load_job.result()

            bq_retry(context, load_retry)
            context.log.info(f"Worker[{self.name}] Data loaded into bigquery")

            self.update_pointer_table(client, context, checkpoint, pointer_table_mutex)
            context.log.info(
                f"Worker[{self.name}] Pointer table updated to {checkpoint.worker_checkpoint}"
            )

    def run_load_bigquery_load(
        self,
        context: AssetExecutionContext,
        pointer_table_mutex: threading.Lock,
    ):
        to_load: List[str] = []

        item = self.queue.dequeue()
        latest_checkpoint = item.checkpoint
        while item is not None:
            # For our own convenience we have the option to do a piecemeal
            # loading. However, for direct loading this shouldn't be
            # necessary
            source = f"gs://{self.config.source_bucket_name}/{item.blob_name}"
            to_load.append(source)
            if len(to_load) >= self.config.pointer_size:
                self.commit_pointer(
                    context, to_load, item.checkpoint, pointer_table_mutex
                )
                to_load = []
            latest_checkpoint = item.checkpoint
            item = self.queue.dequeue()

        if len(to_load) > 0:
            self.commit_pointer(
                context, to_load, latest_checkpoint, pointer_table_mutex
            )
            to_load = []

        context.log.debug(f"Worker[{self.name}] all data loaded")

    def update_pointer_table(
        self,
        client: BQClient,
        context: AssetExecutionContext,
        new_checkpoint: GoldskyCheckpoint,
        pointer_table_mutex: threading.Lock,
    ):
        pointer_table = self.pointer_table
        # Only one mutation on the table should be happening at a time
        tx_query = f"""
            BEGIN TRANSACTION; 
                DELETE FROM `{pointer_table}` WHERE worker = '{self.name}';

                INSERT INTO `{pointer_table}` (worker, job_id, timestamp, checkpoint)
                VALUES ('{self.name}', '{new_checkpoint.job_id}', {new_checkpoint.timestamp}, {new_checkpoint.worker_checkpoint}); 
            COMMIT TRANSACTION;
        """
        for i in range(3):
            try:
                with pointer_table_mutex:
                    resp = client.query_and_wait(tx_query)
                context.log.debug(f"TX response: {list(resp)}")
                return resp
            except Exception as e:
                context.log.debug(f"Pointer update failed with `{e}`. Retrying.")
                time.sleep(1 * random.random())
                continue


class DaskGoldskyWorker(GoldskyWorker):
    def __init__(
        self,
        name: str,
        job_id: str,
        pointer_table: str,
        latest_checkpoint: GoldskyCheckpoint | None,
        gcs: GCSResource,
        bigquery: BigQueryResource,
        config: GoldskyConfig,
        queue: GoldskyQueue,
        task_manager: RetryTaskManager,
    ):
        super().__init__(
            name, job_id, pointer_table, latest_checkpoint, gcs, bigquery, config, queue
        )
        self.task_manager = task_manager

    async def process(self, context: AssetExecutionContext):
        try:
            await self.process_all_files(context)
        finally:
            await self.clean_preload_files(context)
        return self

    async def process_all_files(self, context: AssetExecutionContext):
        count = 0
        item = self.queue.dequeue()
        latest_checkpoint = item.checkpoint
        in_flight = []
        while item is not None:
            source = f"gs://{self.config.source_bucket_name}/{item.blob_name}"
            destination = self.worker_destination_uri(
                f"table_{item.checkpoint.worker_checkpoint}.parquet"
            )
            context.log.debug(
                dict(
                    message="loading",
                    source=source,
                    destination=destination,
                    worker=self.name,
                )
            )
            in_flight.append(
                self.task_manager.submit(
                    process_goldsky_file,
                    args=(
                        GoldskyProcessItem(
                            source=source,
                            destination=destination,
                            checkpoint=item.checkpoint.worker_checkpoint,
                        ),
                    ),
                    pure=False,
                )
            )
            count += 1
            if count >= self.config.pointer_size:
                context.log.debug(
                    f"Worker {self.name} waiting for {len(in_flight)} blobs to process"
                )
                progress = 0
                for coro in asyncio.as_completed(in_flight):
                    await coro
                    progress += 1
                    context.log.debug(
                        f"Worker[{self.name}] progress: {progress}/{count}"
                    )
                context.log.debug(f"Worker[{self.name}] done waiting for blobs")

                # Update the pointer table to the latest item's checkpoint
                await self.update_pointer_table(context, item.checkpoint)

                in_flight = []
                count = 0

            latest_checkpoint = item.checkpoint
            item = self.queue.dequeue()

        if len(in_flight) > 0:
            context.log.debug(
                f"Finalizing worker {self.name} waiting for {len(in_flight)} blobs to process. Last checkpoint {latest_checkpoint.worker_checkpoint}",
            )
            progress = 0
            for coro in asyncio.as_completed(in_flight):
                await coro
                progress += 1
                context.log.debug(f"Worker[{self.name}] progress: {progress}/{count}")
            await self.update_pointer_table(context, latest_checkpoint)

        return self.name

    async def clean_preload_files(self, context: AssetExecutionContext):
        await asyncio.to_thread(
            delete_all_gcs_files_in_prefix,
            context,
            self.gcs,
            self.config.destination_bucket_name,
            self.worker_destination_path(""),
        )

    async def update_pointer_table(
        self, context: AssetExecutionContext, checkpoint: GoldskyCheckpoint
    ):
        await asyncio.to_thread(
            blocking_update_pointer_table,
            context,
            self.config,
            self.bigquery,
            self.job_id,
            self.name,
            self.pointer_table,
            checkpoint,
            self.latest_checkpoint,
            self.worker_wildcard_uri,
        )
        self.latest_checkpoint = checkpoint


def delete_all_gcs_files_in_prefix(
    context: AssetExecutionContext, gcs: GCSResource, bucket_name: str, prefix: str
):
    context.log.info(f"deleting files in gs://{bucket_name}/{prefix}")
    client = gcs.get_client()
    try:
        bucket = client.bucket(bucket_name)
        blobs_to_delete = list(client.list_blobs(bucket_name, prefix=prefix))
        bucket.delete_blobs(blobs=blobs_to_delete)
    finally:
        client.close()
    return


def blocking_update_pointer_table(
    context: AssetExecutionContext,
    config: GoldskyConfig,
    bigquery: BigQueryResource,
    job_id: str,
    worker: str,
    pointer_table: str,
    new_checkpoint: GoldskyCheckpoint,
    latest_checkpoint: GoldskyCheckpoint | None,
    wildcard_path: str,
):
    with bigquery.get_client() as client:
        dest_table_ref = client.get_dataset(
            config.working_destination_dataset_name
        ).table(f"{config.destination_table_name}_{worker}")
        new = False
        try:
            client.get_table(dest_table_ref)
        except NotFound as exc:
            # If the table doesn't exist just create it. An existing table will
            # be there if a previous run happened to fail midway.
            new = True

        if not new:
            context.log.info("Merging into worker table")
            client.query_and_wait(
                f"""
                LOAD DATA OVERWRITE `{config.project_id}.{config.working_destination_dataset_name}.{config.destination_table_name}_{worker}_{job_id}`
                FROM FILES (
                    format = "PARQUET",
                    uris = ["{wildcard_path}"]
                );
            """
            )
            tx_query = f"""
                BEGIN TRANSACTION; 
                    INSERT INTO `{config.project_id}.{config.working_destination_dataset_name}.{config.destination_table_name}_{worker}` 
                    SELECT * FROM `{config.project_id}.{config.working_destination_dataset_name}.{config.destination_table_name}_{worker}_{job_id}`;

                    DELETE FROM `{pointer_table}` WHERE worker = '{worker}';

                    INSERT INTO `{pointer_table}` (worker, job_id, timestamp, checkpoint)
                    VALUES ('{worker}', '{new_checkpoint.job_id}', {new_checkpoint.timestamp}, {new_checkpoint.worker_checkpoint}); 
                COMMIT TRANSACTION;
            """
            context.log.debug(f"query: {tx_query}")
            client.query_and_wait(tx_query)
            client.query_and_wait(
                f"""
                DROP TABLE `{config.project_id}.{config.working_destination_dataset_name}.{config.destination_table_name}_{worker}_{job_id}`;
            """
            )
        else:
            context.log.info("Creating new worker table")
            query1 = f"""
                LOAD DATA OVERWRITE `{config.project_id}.{config.working_destination_dataset_name}.{config.destination_table_name}_{worker}`
                FROM FILES (
                    format = "PARQUET",
                    uris = ["{wildcard_path}"]
                );
            """
            context.log.debug(f"query: {query1}")
            client.query_and_wait(query1)
            rows = client.query_and_wait(
                f"""
                INSERT INTO `{pointer_table}` (worker, job_id, timestamp, checkpoint)
                VALUES ('{worker}', '{new_checkpoint.job_id}', {new_checkpoint.timestamp}, {new_checkpoint.worker_checkpoint}); 
            """
            )
            context.log.info(rows)


def decimal_convert(name: str, field: polars.Decimal):
    if field.precision == 100 and field.scale == 0:
        return SchemaField(name, field_type="NUMERIC")

    return SchemaField(
        name, field_type="DECIMAL", precision=field.precision, scale=field.scale
    )


def basic_type_convert(type_name: str):
    def _convert(name: str, _: polars.DataType):
        return SchemaField(name, field_type=type_name)

    return _convert


def list_type_convert(name: str, field: polars.List):
    inner = field.inner
    inner_type: SchemaField = PARQUET_TO_BQ_FIELD_TYPES[inner]("_inner", inner)
    return SchemaField(name, field_type=inner_type.field_type, mode="REPEATED")


PARQUET_TO_BQ_FIELD_TYPES: dict[polars.DataType] = {
    polars.Boolean: basic_type_convert("BOOLEAN"),
    polars.Int64: basic_type_convert("INT64"),
    polars.Int32: basic_type_convert("INT64"),
    polars.Date: basic_type_convert("DATE"),
    polars.String: basic_type_convert("STRING"),
    polars.Decimal: decimal_convert,
    polars.Datetime: basic_type_convert("TIMESTAMP"),
    polars.Float64: basic_type_convert("FLOAT64"),
    polars.Float32: basic_type_convert("FLOAT64"),
    polars.List: list_type_convert,
}


class GoldskyAsset:
    def __init__(
        self,
        gcs: GCSResource,
        bigquery: BigQueryResource,
        cbt: CBTResource,
        config: GoldskyConfig,
        pointer_table_suffix: str = "",
    ):
        self.config = config
        self.gcs = gcs
        self.bigquery = bigquery
        self.cbt = cbt
        self._task_manager = None
        self._job_id = arrow.now().format("YYYYMMDDHHmm")
        self.cached_blobs_to_process: List[re.Match[str]] | None = None
        self.schema = None
        self.pointer_table_suffix = pointer_table_suffix

    async def materialize(
        self,
        loop: asyncio.AbstractEventLoop,
        context: AssetExecutionContext,
        checkpoint_range: Optional[GoldskyCheckpointRange] = None,
    ):
        context.log.info(
            {"info": "starting goldsky asset load", "name": self.config.source_name}
        )
        self.ensure_datasets(context)

        workers = await self.load_worker_tables(loop, context, checkpoint_range)

        # Dedupe and partition the current worker table into a deduped and partitioned table
        await self.dedupe_worker_tables(context, workers)

        await self.merge_worker_tables(context, workers)

        await self.clean_working_destination(context, workers)

    def load_schema(self, queues: GoldskyQueues):
        item = queues.peek()
        client = self.gcs.get_client()
        try:
            # Download the parquet file
            # Load the parquet file to get the schema
            bucket = client.bucket(self.config.source_bucket_name)
            blob = bucket.get_blob(item.blob_name)
            blob_as_file = io.BytesIO()
            blob.download_to_file(blob_as_file)
            parquet_schema = polars.read_parquet_schema(blob_as_file)
            schema = []
            overrides_lookup = dict()
            for override in self.config.schema_overrides:
                overrides_lookup[override.name] = override
            for field_name, field in parquet_schema.items():
                if field_name in overrides_lookup:
                    schema.append(overrides_lookup[field_name])
                    continue
                field_type_converter = PARQUET_TO_BQ_FIELD_TYPES[type(field)]
                schema_field = field_type_converter(field_name, field)
                schema.append(schema_field)
            self.schema = schema
        finally:
            client.close()

    def ensure_datasets(self, context: AssetExecutionContext):
        self.ensure_dataset(context, self.config.destination_dataset_name)
        self.ensure_dataset(context, self.config.working_destination_dataset_name)

    def ensure_dataset(self, context: AssetExecutionContext, dataset_id: str):
        with self.bigquery.get_client() as client:
            try:
                client.get_dataset(dataset_id)
            except NotFound:
                context.log.info(f"Creating dataset {dataset_id}")
                client.create_dataset(dataset_id)

    async def load_worker_tables(
        self,
        loop: asyncio.AbstractEventLoop,
        context: AssetExecutionContext,
        checkpoint_range: GoldskyCheckpointRange,
    ):
        self.ensure_pointer_table(context)
        if self.config.dask_is_enabled:
            return await self.dask_load_worker_tables(loop, context)
        return await self.direct_load_worker_tables(context, checkpoint_range)

    async def direct_load_worker_tables(
        self,
        context: AssetExecutionContext,
        checkpoint_range: GoldskyCheckpointRange,
    ) -> GoldskyWorker:
        worker_coroutines = []
        workers: List[GoldskyWorker] = []
        worker_status, queues = self.load_queues_to_process(
            context.log, checkpoint_range
        )

        if len(self.config.schema_overrides) > 0:
            self.load_schema(queues)

        pointer_table_mutex = threading.Lock()
        for worker_name, queue in queues.worker_queues():
            worker = DirectGoldskyWorker(
                worker_name,
                self._job_id,
                self.pointer_table,
                worker_status.get(worker_name, None),
                self.gcs,
                self.bigquery,
                self.config,
                queue,
                self.schema,
            )
            worker_coroutines.append(worker.process(context, pointer_table_mutex))
            workers.append(worker)
        for coro in asyncio.as_completed(worker_coroutines):
            worker: GoldskyWorker = await coro
            context.log.info(f"Worker[{worker.name}] completed latest data load")
        return workers

    async def dask_load_worker_tables(
        self,
        loop: asyncio.AbstractEventLoop,
        context: AssetExecutionContext,
        checkpoint_range: Optional[GoldskyCheckpointRange],
    ) -> List[GoldskyWorker]:
        context.log.info("loading worker tables for goldsky asset")
        last_restart = time.time()
        retries = 0
        while True:
            try:
                task_manager = RetryTaskManager.setup(
                    loop,
                    self.config.bucket_key_id,
                    self.config.bucket_secret,
                    self.cluster_spec,
                    context.log,
                )
                try:
                    return await self.parallel_load_worker_tables(
                        task_manager, context, checkpoint_range
                    )
                finally:
                    task_manager.close()
            except Exception as e:
                context.log.error(f"failed?? {e}")
                now = time.time()
                if now > last_restart + 600:
                    last_restart = now
                    retries = 1
                    continue
                else:
                    if retries > 3:
                        raise e
                context.log.error("kube cluster probably disconnected. retrying")
                retries += 1

    async def parallel_load_worker_tables(
        self,
        task_manager: RetryTaskManager,
        context: AssetExecutionContext,
        checkpoint_range: Optional[GoldskyCheckpointRange],
    ):
        worker_status, queues = self.load_queues_to_process(
            context.log, checkpoint_range
        )

        context.log.debug(f"spec: ${json.dumps(self.cluster_spec)}")

        job_id = self._job_id

        worker_coroutines = []
        workers: List[GoldskyWorker] = []
        for worker_name, queue in queues.worker_queues():
            worker = DaskGoldskyWorker(
                worker_name,
                job_id,
                self.pointer_table,
                worker_status.get(worker_name, None),
                self.gcs,
                self.bigquery,
                self.config,
                queue,
                task_manager,
            )
            worker_coroutines.append(worker.process(context))
            workers.append(worker)
        for coro in asyncio.as_completed(worker_coroutines):
            worker: GoldskyWorker = await coro
            context.log.info(f"Worker[{worker.name}] Completed")
        return workers

    async def dedupe_worker_tables(
        self, context: AssetExecutionContext, workers: List[GoldskyWorker]
    ):
        cbt = self.cbt.get(context.log)
        coroutines = []
        for worker in workers:
            context.log.info(f"Deduplicating the Worker[{worker.name}] raw table")
            time_partitioning = None
            if self.config.partition_column_name:
                time_partitioning = TimePartitioning(
                    self.config.partition_column_name, self.config.partition_column_type
                )
            coroutines.append(
                asyncio.to_thread(
                    cbt.transform,
                    self.config.dedupe_model,
                    worker.deduped_table,
                    time_partitioning=time_partitioning,
                    unique_column=self.config.dedupe_unique_column,
                    order_column=self.config.dedupe_order_column,
                    partition_column_name=self.config.partition_column_name,
                    partition_column_transform=self.config.partition_column_transform,
                    raw_table=worker.raw_table,
                    timeout=self.config.transform_timeout_seconds,
                )
            )
        completed = 0
        for coro in asyncio.as_completed(coroutines):
            await coro
            completed += 1
            context.log.info(f"Dedupe progress {completed}/{len(coroutines)}")

    async def merge_worker_tables(
        self, context: AssetExecutionContext, workers: List[GoldskyWorker]
    ):
        cbt = self.cbt.get(context.log)

        context.log.info(
            f"Merging all worker tables to final destination: {self.config.destination_table_fqdn}"
        )
        time_partitioning = None
        if self.config.partition_column_name:
            time_partitioning = TimePartitioning(
                self.config.partition_column_name, self.config.partition_column_type
            )

        cbt.transform(
            self.config.merge_workers_model,
            self.config.destination_table_fqdn,
            update_strategy=UpdateStrategy.MERGE,
            time_partitioning=time_partitioning,
            partition_column_name=self.config.partition_column_name,
            partition_column_transform=self.config.partition_column_transform,
            unique_column=self.config.dedupe_unique_column,
            order_column=self.config.dedupe_order_column,
            workers=workers,
            timeout=self.config.transform_timeout_seconds,
        )

    async def clean_working_destination(
        self, context: AssetExecutionContext, workers: List[GoldskyWorker]
    ):
        # For now we just need to be careful not to run this in multiple processes
        with self.bigquery.get_client() as client:
            for worker in workers:
                context.log.debug(f"deleting Worker[{worker.name}] working tables")
                client.delete_table(worker.raw_table)
                client.delete_table(worker.deduped_table)

    def get_worker_status(self, log: DagsterLogManager):
        worker_status: Mapping[str, GoldskyCheckpoint] = {}
        # Get the current state
        with self.bigquery.get_client() as client:
            try:
                rows = client.query_and_wait(
                    f"""
                SELECT worker, timestamp, job_id, checkpoint
                FROM `{self.pointer_table}`
                """
                )
                for row in rows:
                    worker_status[row.worker] = GoldskyCheckpoint(
                        job_id=row.job_id,
                        timestamp=row.timestamp,
                        worker_checkpoint=row.checkpoint,
                    )
                    log.info(
                        f"Worker[{row.worker}]: Last checkpoint @ TS:{row.timestamp} JOB:{row.job_id} CHK:{row.checkpoint}"
                    )
            except NotFound:
                log.info(
                    f"No pointer status found at {self.pointer_table}. Will create the table later"
                )
        return worker_status

    @property
    def pointer_table(self):
        return f"{self.config.project_id}.{self.config.working_destination_dataset_name}.{self.pointer_table_name}"

    @property
    def pointer_table_name(self):
        pointer_table_suffix = self.pointer_table_suffix
        if pointer_table_suffix != "" and not pointer_table_suffix.startswith("_"):
            pointer_table_suffix = f"_{pointer_table_suffix}"
        return f"{self.config.destination_table_name}_pointer_state{self.pointer_table_suffix}"

    def ensure_pointer_table(self, context: AssetExecutionContext):
        config = self.config
        pointer_table_name = self.pointer_table_name
        pointer_table = self.pointer_table
        context.log.info(
            f"ensuring that the sync pointer table exists at {pointer_table}"
        )

        with self.bigquery.get_client() as client:
            dataset = client.get_dataset(config.working_destination_dataset_name)
            pointer_table_ref = dataset.table(pointer_table_name)
            try:
                client.get_table(pointer_table_ref)
            except NotFound as exc:
                if pointer_table_name in exc.message:
                    context.log.info("Pointer table not found.")
                    client.query_and_wait(
                        f"""
                    CREATE TABLE {pointer_table} (worker STRING, timestamp INT64, job_id STRING, checkpoint INT64);
                    """
                    )
                else:
                    raise exc

    @property
    def cluster_spec(self):
        spec = make_cluster_spec(
            name=f"{self.config.source_name.replace('_', '-')}-{self._job_id}",
            resources={
                "requests": {"memory": self.config.dask_scheduler_memory},
                "limits": {"memory": self.config.dask_scheduler_memory},
            },
            image=self.config.dask_image,
        )
        spec["spec"]["worker"]["spec"]["tolerations"] = [
            {
                "key": "pool_type",
                "effect": "NoSchedule",
                "operator": "Equal",
                "value": "spot",
            }
        ]
        spec["spec"]["worker"]["spec"]["nodeSelector"] = {"pool_type": "spot"}

        # Give the workers a different resource allocation
        for container in spec["spec"]["worker"]["spec"]["containers"]:
            container["resources"] = {
                "limits": {
                    "memory": self.config.dask_worker_memory,
                },
                "requests": {
                    "memory": self.config.dask_worker_memory,
                },
            }
            if container["name"] == "worker":
                args: List[str] = container["args"]
                args.append("--nthreads")
                args.append("1")
                args.append("--nworkers")
                args.append("1")
                args.append("--memory-limit")
                args.append("0")
        return spec

    @property
    def goldsky_re(self):
        return re.compile(
            os.path.join(self.config.source_goldsky_dir, self.config.source_name)
            + r"/(?P<timestamp>\d+)-(?P<job_id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(?P<worker>\d+)-(?P<checkpoint>\d+).parquet"
        )

    def clean_up(self, log: DagsterLogManager):
        worker_status = self.get_worker_status(log)

        end_checkpoint = worker_status.get("0")
        for worker, checkpoint in worker_status.items():
            if checkpoint < end_checkpoint:
                end_checkpoint = checkpoint

        queues = self.load_queues(
            log,
            checkpoint_range=GoldskyCheckpointRange(end=end_checkpoint),
            max_objects_to_load=100_000,
            blobs_loader=self._uncached_blobs_loader,
        )

        for worker, queue in queues.worker_queues():
            cleaning_count = queue.len() - self.config.retention_files
            if cleaning_count <= 0:
                log.info(f"Worker[{worker}]: nothing to clean")
            log.info(f"Worker[{worker}]: cleaning {cleaning_count} files")

            blobs: str = []
            for i in range(cleaning_count):
                item = queue.dequeue()
                blobs.append(item.blob_name)
            last_blob = blobs[-1]
            log.info(f"would delete up to {last_blob}")
            gcs_client = self.gcs.get_client()
            # batch_delete_blobs(gcs_client, self.config.source_bucket_name, blobs, 1000)

    def _uncached_blobs_loader(self, log: DagsterLogManager):
        log.info("Loading blobs list for processing")
        gcs_client = self.gcs.get_client()
        blobs = gcs_client.list_blobs(
            self.config.source_bucket_name,
            prefix=f"{self.config.source_goldsky_dir}/{self.config.source_name}",
        )
        blobs_to_process = []
        for blob in blobs:
            match = self.goldsky_re.match(blob.name)
            if not match:
                continue
            blobs_to_process.append(match)
        return blobs_to_process

    def _cached_blobs_loader(self, log: DagsterLogManager):
        if self.cached_blobs_to_process is None:
            self.cached_blobs_to_process = self._uncached_blobs_loader(log)
        else:
            log.info("using cached blobs")
        return self.cached_blobs_to_process

    def load_queues(
        self,
        log: DagsterLogManager,
        worker_status: Dict[str, GoldskyCheckpoint] = None,
        max_objects_to_load: Optional[int] = None,
        blobs_loader: Callable[[DagsterLogManager], List[re.Match[str]]] = None,
        checkpoint_range: Optional[GoldskyCheckpointRange] = None,
    ) -> GoldskyQueues:
        latest_timestamp = 0
        if not max_objects_to_load:
            max_objects_to_load = self.config.max_objects_to_load
        queues = GoldskyQueues(max_size=max_objects_to_load)

        if not blobs_loader:
            blobs_loader = self._cached_blobs_loader

        # The default filter condition is to skip things that are _before_ the worker
        blobs_to_process = blobs_loader(log)

        if checkpoint_range:
            log.info(
                {
                    "message": "Using a checkpoint range",
                    "end": checkpoint_range._end,
                    "start": checkpoint_range._start,
                }
            )

        for match in blobs_to_process:
            worker = match.group("worker")
            job_id = match.group("job_id")
            timestamp = int(match.group("timestamp"))
            if timestamp > latest_timestamp:
                latest_timestamp = timestamp
            worker_checkpoint = int(match.group("checkpoint"))
            checkpoint = GoldskyCheckpoint(job_id, timestamp, worker_checkpoint)

            # If there's a checkpoint range only queue checkpoints within that range
            if checkpoint_range:
                if not checkpoint_range.in_range(checkpoint):
                    continue

            # If there's a worker status then queue if the current checkpoint is
            # greater than or equal to it
            if worker_status:
                worker_checkpoint = worker_status.get(
                    worker, GoldskyCheckpoint("", 0, 0)
                )
                if worker_checkpoint >= checkpoint:
                    continue

            # log.debug(f"Queueing {match.group()}")
            queues.enqueue(
                worker,
                GoldskyQueueItem(
                    checkpoint,
                    match.group(0),
                    match,
                ),
            )
        keys = list(worker_status.keys())
        if len(keys) > 0:
            expected_timestamp_of_worker_status = worker_status.get(keys[0])
            # Originally multiple timestamp values keys was considered an error
            # but it turns out that this is a normal part of the process. This
            # check is just to get a log for when it does change which might be
            # useful for our own tracing/debugging purposes.
            if expected_timestamp_of_worker_status.timestamp != latest_timestamp:
                log.info(
                    {
                        "message": (
                            "Pipeline timestamp changed."
                            " This is a normal part of the goldsky process."
                            " Continuing to load chronologically"
                        ),
                        "expected": expected_timestamp_of_worker_status,
                        "actual": latest_timestamp,
                    }
                )

        return queues

    def load_queues_to_process(
        self,
        log: DagsterLogManager,
        checkpoint_range: Optional[GoldskyCheckpointRange],
    ) -> Tuple[dict[str, GoldskyCheckpoint], GoldskyQueues]:
        worker_status = self.get_worker_status(log)

        queues = self.load_queues(
            log, worker_status=worker_status, checkpoint_range=checkpoint_range
        )

        for worker, queue in queues.worker_queues():
            log.info(f"Worker[{worker}] queue size: {queue.len()}")

        return (worker_status, queues)


@dataclass
class GoldskyBackfillOpInput:
    backfill_label: str
    start_checkpoint: Optional[GoldskyCheckpoint]
    end_checkpoint: Optional[GoldskyCheckpoint]


def goldsky_asset(asset_config: GoldskyConfig) -> AssetFactoryResponse:
    def materialize_asset(
        context: OpExecutionContext,
        bigquery: BigQueryResource,
        gcs: GCSResource,
        cbt: CBTResource,
        checkpoint_range: Optional[GoldskyCheckpointRange] = None,
        pointer_table_suffix: str = "",
    ):
        loop = asyncio.new_event_loop()
        gs_asset = GoldskyAsset(
            gcs, bigquery, cbt, asset_config, pointer_table_suffix=pointer_table_suffix
        )
        loop.run_until_complete(
            gs_asset.materialize(loop, context, checkpoint_range=checkpoint_range)
        )

    @asset(name=asset_config.name, key_prefix=asset_config.key_prefix)
    def generated_asset(
        context: AssetExecutionContext,
        bigquery: BigQueryResource,
        gcs: GCSResource,
        cbt: CBTResource,
    ):
        context.log.info(f"Run ID: {context.run_id} AssetKey: {context.asset_key}")
        materialize_asset(context, bigquery, gcs, cbt)

    related_ops_prefix = "_".join(generated_asset.key.path)

    @op(name=f"{related_ops_prefix}_clean_up_op")
    def goldsky_clean_up_op(
        context: OpExecutionContext,
        bigquery: BigQueryResource,
        gcs: GCSResource,
        cbt: CBTResource,
        config: dict,
    ):
        print(config)
        gs_asset = GoldskyAsset(gcs, bigquery, cbt, asset_config)
        gs_asset.clean_up(context.log)

    @op(name=f"{related_ops_prefix}_backfill_op")
    def goldsky_backfill_op(
        context: OpExecutionContext,
        bigquery: BigQueryResource,
        gcs: GCSResource,
        cbt: CBTResource,
        config: dict,
    ):
        start_checkpoint = None
        end_checkpoint = None
        if "start" in config:
            start_checkpoint = GoldskyCheckpoint(*config["start"])
        if "end" in config:
            end_checkpoint = GoldskyCheckpoint(*config["end"])
        op_input = GoldskyBackfillOpInput(
            backfill_label=config["backfill_label"],
            start_checkpoint=start_checkpoint,
            end_checkpoint=end_checkpoint,
        )
        context.log.info("Starting a backfill")
        materialize_asset(
            context,
            bigquery,
            gcs,
            cbt,
            checkpoint_range=GoldskyCheckpointRange(
                start=op_input.start_checkpoint, end=op_input.end_checkpoint
            ),
            pointer_table_suffix=op_input.backfill_label,
        )
        # Hack for now.
        return "Done"

    @job(name=f"{related_ops_prefix}_clean_up_job")
    def goldsky_clean_up_job():
        goldsky_clean_up_op()

    @job(name=f"{related_ops_prefix}_backfill_job")
    def goldsky_backfill_job():
        goldsky_backfill_op()

    @asset_sensor(
        asset_key=generated_asset.key,
        name=f"{related_ops_prefix}_clean_up_sensor",
        job=goldsky_clean_up_job,
        default_status=DefaultSensorStatus.STOPPED,
    )
    def goldsky_clean_up_sensor(
        context: SensorEvaluationContext, asset_event: EventLogEntry
    ):
        yield RunRequest(
            run_key=context.cursor,
            run_config=RunConfig(
                ops={
                    f"{related_ops_prefix}_clean_up_op": {
                        "config": {"asset_event": asset_event}
                    }
                }
            ),
        )

    checks: List[AssetChecksDefinition] = []
    for check in asset_config.checks:
        checks.extend(check(asset_config, generated_asset))

    return AssetFactoryResponse(
        assets=[generated_asset],
        sensors=[goldsky_clean_up_sensor],
        jobs=[goldsky_clean_up_job, goldsky_backfill_job],
        checks=checks,
    )