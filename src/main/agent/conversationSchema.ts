/** Product identities and resources are independent of execution storage.
 * The retiring executor supplies its own progress columns at creation. */
export function conversationIdentitySchema(additionalRunColumns = ''): string {
  return `
      CREATE TABLE agent_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT NOT NULL,
        model_config_id TEXT,
        model_parameter_preset_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        full_access INTEGER NOT NULL DEFAULT 0 CHECK (full_access IN (0, 1)),
        strict_approval INTEGER NOT NULL DEFAULT 0 CHECK (strict_approval IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'running', 'interrupted', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX agent_threads_updated_at_idx
        ON agent_threads (pinned DESC, updated_at DESC);

      CREATE TABLE agent_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        submission_id TEXT UNIQUE,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('agent', 'compression')),
        status TEXT NOT NULL
          CHECK (status IN ('running', 'interrupted', 'completed', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
${additionalRunColumns}        configuration_json TEXT CHECK (configuration_json IS NULL OR json_valid(configuration_json)),
        cancellation_requested INTEGER NOT NULL DEFAULT 0
          CHECK (cancellation_requested IN (0, 1))
      );

      CREATE INDEX agent_runs_thread_id_idx
        ON agent_runs (thread_id, created_at DESC);

  `
}

export const conversationResourceSchema = `
      CREATE TABLE IF NOT EXISTS agent_message_payloads (
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE, record_id TEXT NOT NULL,
        PRIMARY KEY(thread_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS agent_tool_messages (
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,model_message_id TEXT,tool_message_id TEXT,
        PRIMARY KEY(thread_id,run_id,call_id)
      );
      CREATE TABLE IF NOT EXISTS agent_message_index (
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,record_id TEXT NOT NULL,message_id TEXT,run_id TEXT,visible INTEGER NOT NULL,
        PRIMARY KEY(thread_id,position)
      );
      CREATE INDEX IF NOT EXISTS agent_message_visible_idx ON agent_message_index(thread_id,visible,position);
      CREATE TABLE IF NOT EXISTS agent_context_status (
        thread_id TEXT PRIMARY KEY REFERENCES agent_threads(id) ON DELETE CASCADE,status_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_activities (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        activity_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('tool', 'subagent')),
        activity_id TEXT NOT NULL,
        parent_subagent_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        output_json TEXT,
        PRIMARY KEY (run_id, activity_key)
      );

      CREATE INDEX IF NOT EXISTS agent_activities_run_sequence_idx
        ON agent_activities (run_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_tool_approvals (
        run_id TEXT NOT NULL,
        activity_key TEXT NOT NULL,
        interrupt_id TEXT NOT NULL,
        action_index INTEGER NOT NULL CHECK (action_index >= 0),
        PRIMARY KEY (run_id, activity_key),
        UNIQUE (run_id, interrupt_id, action_index),
        FOREIGN KEY (run_id, activity_key)
          REFERENCES agent_activities (run_id, activity_key)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_model_activities (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        subagent_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        PRIMARY KEY (run_id, model_id)
      );

      CREATE INDEX IF NOT EXISTS agent_model_activities_run_sequence_idx
        ON agent_model_activities (run_id, sequence);

      CREATE INDEX IF NOT EXISTS agent_model_activities_run_subagent_sequence_idx
        ON agent_model_activities (run_id, subagent_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_model_messages (
        run_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (run_id, model_id),
        FOREIGN KEY (run_id, model_id)
          REFERENCES agent_model_activities (run_id, model_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS agent_model_messages_message_idx
        ON agent_model_messages (message_id);

      CREATE TABLE IF NOT EXISTS agent_activity_timing (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        activity_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (run_id, activity_key)
      );

      CREATE TABLE IF NOT EXISTS agent_context_summaries (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        summary_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        summary_text TEXT NOT NULL DEFAULT '',
        model_content TEXT NOT NULL DEFAULT '',
        committed_checkpoint_id TEXT,
        cutoff_index INTEGER,
        activated_after_message_index INTEGER,
        covered_through_message_id TEXT,
        first_preserved_message_id TEXT,
        input_tokens_before INTEGER,
        input_tokens_after INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, summary_id)
      );

      CREATE INDEX IF NOT EXISTS agent_context_summaries_run_sequence_idx
        ON agent_context_summaries (run_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_memory_recalls (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        recall_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        query TEXT NOT NULL CHECK (length(query) > 0),
        prompt_text TEXT NOT NULL CHECK (length(prompt_text) > 0),
        memory_count INTEGER NOT NULL CHECK (memory_count > 0),
        agent_name TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, recall_id)
      );

      CREATE INDEX IF NOT EXISTS agent_memory_recalls_run_sequence_idx
        ON agent_memory_recalls (run_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('image', 'text', 'binary')),
        storage_path TEXT NOT NULL,
        text_truncated INTEGER NOT NULL DEFAULT 0 CHECK (text_truncated IN (0, 1)),
        context_policy TEXT NOT NULL DEFAULT 'one_turn'
          CHECK (context_policy IN ('one_turn', 'conversation')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_attachments_thread_message_idx
        ON agent_attachments (thread_id, message_id, created_at);

      CREATE INDEX IF NOT EXISTS agent_attachments_run_idx
        ON agent_attachments (run_id);

      CREATE TABLE IF NOT EXISTS agent_queued_inputs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        text TEXT NOT NULL CHECK (length(text) > 0),
        display_text TEXT NOT NULL CHECK (length(display_text) > 0),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_queued_inputs_thread_created_idx
        ON agent_queued_inputs (thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS agent_queued_attachments (
        id TEXT PRIMARY KEY,
        queued_input_id TEXT NOT NULL REFERENCES agent_queued_inputs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('image', 'text', 'binary')),
        storage_path TEXT NOT NULL,
        text_truncated INTEGER NOT NULL DEFAULT 0 CHECK (text_truncated IN (0, 1)),
        context_policy TEXT NOT NULL DEFAULT 'one_turn'
          CHECK (context_policy IN ('one_turn', 'conversation')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_queued_attachments_input_idx
        ON agent_queued_attachments (queued_input_id, created_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_id_thread_idx
        ON agent_runs (id, thread_id);

      CREATE TABLE IF NOT EXISTS agent_managed_calls (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('shell', 'http', 'builtin', 'mcp', 'custom')),
        summary TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('preparing', 'running', 'completed', 'failed', 'cancelled', 'uncertain')),
        result_text TEXT,
        outcome_json TEXT,
        error TEXT,
        output_chars INTEGER NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
        progress_current REAL CHECK (progress_current >= 0),
        progress_total REAL CHECK (progress_total >= 0),
        progress_unit TEXT,
        next_output_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_output_sequence >= 1),
        dispatched_at TEXT,
        detached_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id, thread_id)
          REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS agent_managed_calls_id_thread_idx
        ON agent_managed_calls (id, thread_id);


      CREATE INDEX IF NOT EXISTS agent_managed_calls_thread_created_idx
        ON agent_managed_calls (thread_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS agent_managed_calls_status_idx
        ON agent_managed_calls (status, updated_at);

      CREATE INDEX IF NOT EXISTS agent_managed_calls_run_detached_idx
        ON agent_managed_calls (run_id, detached_at);

      CREATE INDEX IF NOT EXISTS agent_managed_calls_thread_detached_idx
        ON agent_managed_calls (thread_id, detached_at, created_at, id);

      CREATE TABLE IF NOT EXISTS agent_managed_call_output (
        call_id TEXT NOT NULL REFERENCES agent_managed_calls(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'progress')),
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
        text TEXT NOT NULL CHECK (length(text) > 0),
        PRIMARY KEY (call_id, sequence),
        UNIQUE (call_id, start_offset)
      );

      CREATE INDEX IF NOT EXISTS agent_managed_call_output_range_idx
        ON agent_managed_call_output (call_id, start_offset, end_offset);

      CREATE TABLE IF NOT EXISTS agent_managed_call_observations (
        call_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (call_id, run_id),
        FOREIGN KEY (call_id, thread_id)
          REFERENCES agent_managed_calls(id, thread_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, thread_id)
          REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS agent_managed_call_observations_run_idx
        ON agent_managed_call_observations (run_id, call_id);

      CREATE TABLE IF NOT EXISTS agent_hidden_threads (
        thread_id TEXT PRIMARY KEY REFERENCES agent_threads(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind = 'subagent')
      );

      CREATE TABLE IF NOT EXISTS agent_subagent_calls (
        id TEXT PRIMARY KEY,
        owner_thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        parent_thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        parent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        parent_subagent_id TEXT,
        child_thread_id TEXT NOT NULL UNIQUE REFERENCES agent_threads(id) ON DELETE CASCADE,
        child_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL CHECK (length(agent_name) > 0),
        config_json TEXT NOT NULL,
        description TEXT NOT NULL CHECK (length(description) > 0),
        status TEXT NOT NULL
          CHECK (status IN ('running', 'interrupted', 'completed', 'failed', 'cancelled')),
        result_text TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (parent_run_id, parent_thread_id)
          REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_subagent_id)
          REFERENCES agent_subagent_calls(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS agent_subagent_calls_owner_created_idx
        ON agent_subagent_calls (owner_thread_id, created_at, id);

      CREATE INDEX IF NOT EXISTS agent_subagent_calls_parent_run_idx
        ON agent_subagent_calls (parent_run_id, created_at, id);

      CREATE TABLE IF NOT EXISTS agent_subagent_observations (
        subagent_id TEXT NOT NULL REFERENCES agent_subagent_calls(id) ON DELETE CASCADE,
        observing_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (subagent_id, observing_run_id)
      );

      CREATE TABLE IF NOT EXISTS agent_run_background_cleanup (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'unconfirmed')),
        report TEXT NOT NULL
      );


      CREATE TABLE IF NOT EXISTS agent_managed_call_cleanup (
        call_id TEXT PRIMARY KEY REFERENCES agent_managed_calls(id) ON DELETE CASCADE,
        cleanup_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_subagent_cleanup (
        subagent_id TEXT PRIMARY KEY REFERENCES agent_subagent_calls(id) ON DELETE CASCADE,
        cleanup_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL
      );


      -- Deliberately has no foreign key: file-edit records may still require
      -- cleanup after their run or thread metadata has been deleted.
      CREATE TABLE IF NOT EXISTS agent_file_edit_cleanup_outbox (
        run_id TEXT PRIMARY KEY
      );

      -- Deliberately has no foreign key: archived files may still require
      -- cleanup after their thread metadata has been deleted.
      CREATE TABLE IF NOT EXISTS agent_attachment_cleanup_outbox (
        thread_id TEXT PRIMARY KEY
      );

      -- History replacement can remove individual attachments while their
      -- conversation remains live. Keep cleanup independent of deleted runs.
      CREATE TABLE IF NOT EXISTS agent_attachment_file_cleanup_outbox (
        attachment_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        storage_path TEXT NOT NULL
      );

      -- Deliberately has no foreign key: an uncertain file edit must remain
      -- discoverable after its originating run has been cancelled or deleted.
      CREATE TABLE IF NOT EXISTS agent_file_edit_retained_operations (
        request_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (request_id, operation_id)
      );


      CREATE TABLE IF NOT EXISTS agent_run_resume_intents (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        interrupt_id TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        PRIMARY KEY (run_id, interrupt_id)
      );

      CREATE TABLE IF NOT EXISTS agent_run_input_intents (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        input_json TEXT NOT NULL CHECK (json_valid(input_json))
      );

`
