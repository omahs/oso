{{
  config(
    materialized='incremental',
    partition_by={
      "field": "time",
      "data_type": "timestamp",
      "granularity": "day",
    },
    unique_id="id",
    on_schema_change="append_new_columns",
    incremental_strategy="insert_overwrite"
  )
}}
{% if is_incremental() %}
  {% set start = "TIMESTAMP_SUB(_dbt_max_partition, INTERVAL 1 DAY)" %}
{% else %}
  {% set start = "'1970-01-01'" %}
{% endif %}
with internal_transactions as (
  select -- noqa: ST06
    traces.block_timestamp as `time`,
    "CONTRACT_INVOCATION" as event_type,
    traces.id as event_source_id,
    "OPTIMISM" as event_source,
    LOWER(traces.to_address) as to_name,
    "OPTIMISM" as to_namespace,
    COALESCE(to_artifacts.artifact_type, "UNRESOLVED") as to_type,
    CAST(to_artifacts.artifact_source_id as STRING) as to_source_id,
    LOWER(traces.from_address) as from_name,
    "OPTIMISM" as from_namespace,
    COALESCE(from_artifacts.artifact_type, "UNRESOLVED") as from_type,
    CAST(from_artifacts.artifact_source_id as STRING) as from_source_id,
    traces.gas_used as l2_gas_used
  from {{ ref('int_optimism_traces') }} as traces
  left join {{ ref('int_artifacts_by_project') }} as to_artifacts
    on
      LOWER(traces.to_address) = LOWER(to_artifacts.artifact_source_id)
      and to_artifacts.artifact_source = "OPTIMISM"
  left join {{ ref('int_artifacts_by_project') }} as from_artifacts
    on
      LOWER(traces.from_address) = LOWER(from_artifacts.artifact_source_id)
      and to_artifacts.artifact_source = "OPTIMISM"
  where
    traces.input != "0x"
    and traces.block_timestamp >= {{ start }}
),

transactions as (
  select -- noqa: ST06
    transactions.block_timestamp as `time`,
    "CONTRACT_INVOCATION" as event_type,
    transactions.transaction_hash as event_source_id,
    "OPTIMISM" as event_source,
    LOWER(transactions.to_address) as to_name,
    "OPTIMISM" as to_namespace,
    COALESCE(to_artifacts.artifact_type, "CONTRACT") as to_type,
    CAST(to_artifacts.artifact_source_id as STRING) as to_source_id,
    LOWER(transactions.from_address) as from_name,
    "OPTIMISM" as from_namespace,
    COALESCE(from_artifacts.artifact_type, "EOA") as from_type,
    CAST(from_artifacts.artifact_source_id as STRING) as from_source_id,
    transactions.receipt_gas_used as l2_gas_used
  from {{ ref('int_optimism_transactions') }} as transactions
  left join {{ ref('int_artifacts_by_project') }} as to_artifacts
    on
      LOWER(transactions.to_address) = LOWER(to_artifacts.artifact_source_id)
      and to_artifacts.artifact_source = "OPTIMISM"
  left join {{ ref('int_artifacts_by_project') }} as from_artifacts
    on
      LOWER(transactions.from_address)
      = LOWER(from_artifacts.artifact_source_id)
      and to_artifacts.artifact_source = "OPTIMISM"
  where
    transactions.input != "0x"
    and transactions.block_timestamp >= {{ start }}
),

all_transactions as (
  select * from transactions
  union all
  select * from internal_transactions
),

contract_invocation as (
  select
    `time`,
    `event_type`,
    `event_source_id`,
    `event_source`,
    `to_name`,
    `to_namespace`,
    `to_type`,
    `to_source_id`,
    `from_name`,
    `from_namespace`,
    `from_type`,
    `from_source_id`,
    1 as `amount`
  from all_transactions
),

contract_invocation_l2_gas_used as (
  select
    `time`,
    `event_type`,
    `event_source_id`,
    `event_source`,
    `to_name`,
    `to_namespace`,
    `to_type`,
    `to_source_id`,
    `from_name`,
    `from_namespace`,
    `from_type`,
    `from_source_id`,
    `l2_gas_used` as `amount`
  from all_transactions
)

select * from contract_invocation
union all
select * from contract_invocation_l2_gas_used
