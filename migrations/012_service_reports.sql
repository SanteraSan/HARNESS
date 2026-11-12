create table service_invocations (
  id uuid primary key,
  tenant_id text not null,
  service_id text not null,
  run_id uuid not null references runs (id),
  tool_call_id text not null,
  request_sha256 bytea not null,
  nonce uuid not null,
  worker_id text not null,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  hub_duration_ms integer,
  http_status integer,
  transport_code text,
  response_bytes integer,
  unique (run_id, tool_call_id),
  check (octet_length(request_sha256) = 32),
  check (hub_duration_ms is null or hub_duration_ms >= 0),
  check (response_bytes is null or response_bytes >= 0),
  check (status in ('pending', 'completed', 'timeout', 'transport_error', 'abandoned')),
  check (transport_code is null or transport_code in (
    'timeout', 'connection_error', 'payload_too_large', 'unknown_field',
    'invalid_envelope', 'echo_mismatch', 'unauthorized',
    'idempotency_conflict', 'http_error'
  )),
  check (
    (status = 'pending' and finished_at is null and transport_code is null)
    or (status = 'completed' and finished_at is not null and transport_code is null)
    or (status = 'timeout' and finished_at is not null and transport_code = 'timeout')
    or (status = 'abandoned' and finished_at is not null and transport_code is null)
    or (status = 'transport_error' and finished_at is not null and transport_code in (
      'connection_error', 'payload_too_large', 'unknown_field', 'invalid_envelope',
      'echo_mismatch', 'unauthorized', 'idempotency_conflict', 'http_error'
    ))
  )
);

create index service_invocations_tenant_service_started_idx
  on service_invocations (tenant_id, service_id, started_at);

create index service_invocations_run_idx
  on service_invocations (run_id);

create index service_invocations_pending_idx
  on service_invocations (started_at)
  where status = 'pending';

create table service_results (
  invocation_id uuid primary key references service_invocations (id),
  ok boolean not null,
  error_code text,
  excerpt text not null,
  truncated boolean not null,
  report_status text not null,
  report jsonb,
  claimed_duration_ms integer not null,
  claimed_prompt_tokens integer,
  claimed_completion_tokens integer,
  claimed_cost_usd numeric,
  claimed_finish_reason text,
  check (report_status in ('absent', 'valid', 'invalid')),
  check (char_length(excerpt) <= 2000),
  check (claimed_duration_ms between 0 and 600000),
  check (claimed_prompt_tokens is null or claimed_prompt_tokens >= 0),
  check (claimed_completion_tokens is null or claimed_completion_tokens >= 0),
  check (claimed_cost_usd is null or claimed_cost_usd >= 0),
  check (claimed_finish_reason is null or claimed_finish_reason in (
    'stop', 'length', 'tool_calls', 'content_filter', 'error'
  )),
  check (error_code is null or error_code in (
    'invalid_args', 'not_found', 'forbidden', 'too_large',
    'conflict', 'unavailable', 'internal'
  )),
  check ((ok and error_code is null) or (not ok and error_code is not null)),
  -- Уборка обнуляет report и не меняет report_status, поэтому valid допускает null.
  check (
    (report_status = 'valid')
    or (report_status in ('absent', 'invalid') and report is null)
  ),
  check (report is null or octet_length(report::text) <= 8192),
  check (report_status = 'valid' or (
    claimed_prompt_tokens is null
    and claimed_completion_tokens is null
    and claimed_cost_usd is null
    and claimed_finish_reason is null
  ))
);

create table service_model_steps (
  invocation_id uuid not null references service_invocations (id),
  step_index integer not null,
  excerpt text not null,
  finish_reason text,
  claimed_prompt_tokens integer,
  claimed_completion_tokens integer,
  claimed_cost_usd numeric,
  tool_calls jsonb,
  primary key (invocation_id, step_index),
  check (step_index between 0 and 15),
  check (char_length(excerpt) <= 2000),
  check (finish_reason is null or finish_reason in (
    'stop', 'length', 'tool_calls', 'content_filter', 'error'
  )),
  check (claimed_prompt_tokens is null or claimed_prompt_tokens >= 0),
  check (claimed_completion_tokens is null or claimed_completion_tokens >= 0),
  check (claimed_cost_usd is null or claimed_cost_usd >= 0),
  check (tool_calls is null or jsonb_typeof(tool_calls) = 'array')
);
