/** Transaction-local invalidations. These triggers record identities only;
 * the product write boundary consumes them before committing its projection. */
const mark = (run: string, source: string, from = 'WHERE 1') => `INSERT INTO agent_display_changes(run_id,source_key) SELECT ${run},${source} ${from} ON CONFLICT(run_id,source_key) DO NOTHING;`
const relatedMessage = (row: string) =>
  mark('model.run_id', "'model:' || model.model_id", `FROM agent_model_messages model WHERE model.message_id=${row}.message_id`)
  + mark('activity.run_id', "'activity:' || activity.activity_key", `FROM agent_activities activity JOIN agent_tool_messages link
    ON link.call_id=activity.activity_id AND activity.kind='tool'
    WHERE link.thread_id=${row}.thread_id AND (link.model_message_id=${row}.message_id OR link.tool_message_id=${row}.message_id)`)
const sources: Record<string, (row: string) => string> = {
  agent_model_activities: row => mark(`${row}.run_id`, `'model:' || ${row}.model_id`),
  agent_model_messages: row => mark(`${row}.run_id`, `'model:' || ${row}.model_id`),
  agent_activities: row => mark(`${row}.run_id`, `'activity:' || ${row}.activity_key`),
  agent_tool_approvals: row => mark(`${row}.run_id`, `'activity:' || ${row}.activity_key`),
  agent_activity_timing: row => mark(`${row}.run_id`, `CASE WHEN substr(${row}.activity_key,1,6)='model:'
    THEN ${row}.activity_key ELSE 'activity:' || ${row}.activity_key END`),
  agent_display_headers: row => relatedMessage(row) + mark('payload.run_id', `'message:' || ${row}.message_id`,
    `FROM agent_message_payloads payload WHERE payload.thread_id=${row}.thread_id AND payload.message_id=${row}.message_id AND payload.run_id IS NOT NULL`)
    + mark('payload.run_id', "'input'", `FROM agent_message_payloads payload WHERE payload.thread_id=${row}.thread_id AND payload.message_id=${row}.message_id AND payload.run_id IS NOT NULL`),
  agent_message_payloads: row => relatedMessage(row) + mark(`${row}.run_id`, `'message:' || ${row}.message_id`, `WHERE ${row}.run_id IS NOT NULL`)
    + mark(`${row}.run_id`, "'input'", `WHERE ${row}.run_id IS NOT NULL`),
  agent_tool_messages: row => mark('activity.run_id', "'activity:' || activity.activity_key",
    `FROM agent_activities activity WHERE activity.activity_id=${row}.call_id AND activity.kind='tool'`),
  agent_context_summaries: row => mark(`${row}.run_id`, `'summary:' || ${row}.summary_id`),
  agent_run_input_intents: row => mark(`${row}.run_id`, "'input'"),
  agent_subagent_calls: row => mark('activity.run_id', "'activity:' || activity.activity_key",
    `FROM agent_activities activity WHERE activity.activity_id=${row}.id AND activity.kind='subagent'`)
}

export const activityDisplayChangeSchema = `
  ALTER TABLE agent_model_activities ADD COLUMN display_round INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX display_model_round ON agent_model_activities(run_id,subagent_id,display_round);
  CREATE TRIGGER display_assign_model_round AFTER INSERT ON agent_model_activities
  BEGIN UPDATE agent_model_activities SET display_round=(SELECT coalesce(max(display_round),0)+1 FROM agent_model_activities
    WHERE run_id=NEW.run_id AND subagent_id IS NEW.subagent_id) WHERE run_id=NEW.run_id AND model_id=NEW.model_id; END;
  CREATE TRIGGER display_remove_model_round AFTER DELETE ON agent_model_activities
  BEGIN UPDATE agent_model_activities SET display_round=display_round-1
    WHERE run_id=OLD.run_id AND subagent_id IS OLD.subagent_id AND display_round>OLD.display_round; END;
  CREATE TABLE agent_display_changes(run_id TEXT NOT NULL,source_key TEXT NOT NULL,PRIMARY KEY(run_id,source_key));
  CREATE INDEX display_model_message ON agent_model_messages(message_id,run_id,model_id);
  CREATE INDEX display_activity_identity ON agent_activities(activity_id,kind,run_id);
  CREATE INDEX display_tool_model ON agent_tool_messages(thread_id,model_message_id);
  CREATE INDEX display_tool_result ON agent_tool_messages(thread_id,tool_message_id);
  CREATE INDEX display_payload_run ON agent_message_payloads(run_id,body_sequence);
` + Object.entries(sources).flatMap(([table, source]) => ['INSERT', 'UPDATE', 'DELETE'].map(operation => `
  CREATE TRIGGER display_change_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
  BEGIN ${operation === 'INSERT' ? source('NEW') : operation === 'DELETE' ? source('OLD') : source('OLD') + source('NEW')} END;
`)).join('') + `
  CREATE TRIGGER display_change_delegation AFTER UPDATE OF state ON execution_effects
  WHEN NEW.state='intent' AND NEW.tool_name='start_subagent'
  BEGIN ${mark('activity.run_id', "'activity:' || activity.activity_key", "FROM agent_activities activity WHERE activity.activity_id=NEW.call_id AND activity.kind='tool'")} END;
  CREATE TRIGGER display_change_run AFTER UPDATE OF status ON agent_runs WHEN OLD.status<>NEW.status
  BEGIN ${mark('NEW.id', "'run'")} END;
`
