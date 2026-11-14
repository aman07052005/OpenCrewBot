import { randomUUID } from "node:crypto";
import type { ModelUsageRecord } from "@/lib/shared/types";
import { db } from "./db";

export async function recordModelUsage(record: Omit<ModelUsageRecord, "id" | "createdAt">): Promise<ModelUsageRecord> {
  const saved: ModelUsageRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
  await (await db()).execute({ sql: `INSERT INTO model_usage_records (id,agent_id,conversation_id,execution_run_id,task_id,provider_id,model,input_tokens,output_tokens,total_tokens,usage_kind,duration_ms,success,fallback_attempt,estimated_cost_usd,currency,pricing_version,routing_reason,error,created_at,cached_input_tokens,reasoning_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [saved.id,saved.agentId,saved.conversationId,saved.executionRunId,saved.taskId,saved.providerId,saved.model,saved.inputTokens,saved.outputTokens,saved.totalTokens,saved.usageKind,saved.durationMs,saved.success ? 1 : 0,saved.fallbackAttempt,saved.estimatedCostUsd,saved.currency,saved.pricingVersion,saved.routingReason,saved.error,saved.createdAt,saved.cachedInputTokens ?? null,saved.reasoningTokens ?? null] });
  return saved;
}
export async function listModelUsage(limit = 100): Promise<ModelUsageRecord[]> {
  const safe = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = await (await db()).execute({ sql: "SELECT * FROM model_usage_records ORDER BY created_at DESC LIMIT ?", args: [safe] });
  return rows.rows.map((row) => ({ id:String(row.id),agentId:String(row.agent_id),conversationId:row.conversation_id == null ? null:String(row.conversation_id),executionRunId:row.execution_run_id == null ? null:String(row.execution_run_id),taskId:row.task_id == null ? null:String(row.task_id),providerId:String(row.provider_id) as ModelUsageRecord["providerId"],model:String(row.model),inputTokens:row.input_tokens == null ? null:Number(row.input_tokens),outputTokens:row.output_tokens == null ? null:Number(row.output_tokens),totalTokens:row.total_tokens == null ? null:Number(row.total_tokens),usageKind:String(row.usage_kind) as ModelUsageRecord["usageKind"],durationMs:row.duration_ms == null ? null:Number(row.duration_ms),success:Boolean(row.success),fallbackAttempt:Number(row.fallback_attempt),estimatedCostUsd:row.estimated_cost_usd == null ? null:Number(row.estimated_cost_usd),currency:String(row.currency),pricingVersion:row.pricing_version == null ? null:String(row.pricing_version),routingReason:String(row.routing_reason),error:row.error == null ? null:String(row.error),createdAt:String(row.created_at),cachedInputTokens:row.cached_input_tokens == null ? null:Number(row.cached_input_tokens),reasoningTokens:row.reasoning_tokens == null ? null:Number(row.reasoning_tokens) }));
}
