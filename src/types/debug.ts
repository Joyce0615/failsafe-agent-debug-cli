import { z } from "zod";
import { SCHEMA_VERSION, SourceLocationSchema } from "./common.js";

export const RuntimeSchema = z.enum([
	"python",
	"node",
	"go",
	"rust",
	"cpp",
	"java",
	"dotnet",
	"unknown",
]);
export type Runtime = z.infer<typeof RuntimeSchema>;

export const DebugStatusSchema = z.enum(["starting", "running", "paused", "terminated", "error"]);
export type DebugStatus = z.infer<typeof DebugStatusSchema>;

export const BreakpointRefSchema = z.object({
	id: z.string().optional(),
	location: SourceLocationSchema,
	verified: z.boolean(),
});
export type BreakpointRef = z.infer<typeof BreakpointRefSchema>;

export const VariableSnapshotSchema = z.object({
	name: z.string(),
	type: z.string().optional(),
	value: z.string(),
	children_ref: z.number().optional(),
});
export type VariableSnapshot = z.infer<typeof VariableSnapshotSchema>;

export const ScopeSnapshotSchema = z.object({
	name: z.string(),
	variables: z.array(VariableSnapshotSchema),
});
export type ScopeSnapshot = z.infer<typeof ScopeSnapshotSchema>;

export const StateSnapshotSchema = z.object({
	thread_id: z.string(),
	frame_id: z.string(),
	location: SourceLocationSchema,
	scopes: z.array(ScopeSnapshotSchema),
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

export const VariableChangeSchema = z.object({
	name: z.string(),
	before: z.string(),
	after: z.string(),
	note: z.string().optional(),
});
export type VariableChange = z.infer<typeof VariableChangeSchema>;

export const BranchEventSchema = z.object({
	location: SourceLocationSchema,
	condition: z.string().optional(),
	taken: z.boolean(),
});
export type BranchEvent = z.infer<typeof BranchEventSchema>;

export const ExceptionEventSchema = z.object({
	type: z.string(),
	message: z.string(),
	location: SourceLocationSchema.optional(),
});
export type ExceptionEvent = z.infer<typeof ExceptionEventSchema>;

export const ConsoleEventSchema = z.object({
	category: z.enum(["stdout", "stderr", "console"]),
	text: z.string(),
});
export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;

export const DebugSessionSchema = z.object({
	schema_version: z.literal(SCHEMA_VERSION),
	debug_session_id: z.string(),
	failure_id: z.string().optional(),
	repro_id: z.string().optional(),
	runtime: RuntimeSchema,
	adapter: z.string(),
	launch_config: z.unknown(),
	status: DebugStatusSchema,
	current_thread_id: z.string().optional(),
	current_frame_id: z.string().optional(),
	breakpoints: z.array(BreakpointRefSchema),
	watch_expressions: z.array(z.string()),
	last_state_snapshot: StateSnapshotSchema.optional(),
});
export type DebugSession = z.infer<typeof DebugSessionSchema>;

export const StateDeltaSchema = z.object({
	debug_session_id: z.string(),
	from_location: SourceLocationSchema,
	to_location: SourceLocationSchema,
	step_kind: z.enum(["over", "into", "out", "continue"]),
	changed_variables: z.array(VariableChangeSchema),
	branch_events: z.array(BranchEventSchema),
	exceptions: z.array(ExceptionEventSchema),
	console_events: z.array(ConsoleEventSchema),
	interpretation: z.string().optional(),
});
export type StateDelta = z.infer<typeof StateDeltaSchema>;
