import type { SourceLocation } from "../types/common.js";
import type {
	ConsoleEvent,
	ExceptionEvent,
	ScopeSnapshot,
	StateDelta,
	StateSnapshot,
	VariableChange,
	VariableSnapshot,
} from "../types/debug.js";
import type { DapClient } from "./dap-client.js";

const MAX_VARIABLE_DEPTH = 2;
const MAX_VALUE_LENGTH = 500;

export async function captureStateSnapshot(
	client: DapClient,
	threadId: number,
	frameId: number,
	location: SourceLocation,
): Promise<StateSnapshot> {
	const scopes = await client.scopes(frameId);
	const scopeSnapshots: ScopeSnapshot[] = [];

	for (const scope of scopes) {
		// Skip expensive scopes like globals
		if (scope.name === "Globals" || scope.name === "Global") continue;

		const variables = await captureVariables(client, scope.variablesReference, 0);
		scopeSnapshots.push({
			name: scope.name,
			variables,
		});
	}

	return {
		thread_id: String(threadId),
		frame_id: String(frameId),
		location,
		scopes: scopeSnapshots,
	};
}

async function captureVariables(
	client: DapClient,
	variablesReference: number,
	depth: number,
): Promise<VariableSnapshot[]> {
	if (depth >= MAX_VARIABLE_DEPTH || variablesReference === 0) return [];

	try {
		const vars = await client.variables(variablesReference);
		return vars.map((v) => ({
			name: v.name,
			type: v.type || undefined,
			value: truncateValue(v.value),
			children_ref:
				v.variablesReference > 0 && depth < MAX_VARIABLE_DEPTH - 1
					? v.variablesReference
					: undefined,
		}));
	} catch {
		return [];
	}
}

export function computeStateDelta(
	before: StateSnapshot,
	after: StateSnapshot,
	stepKind: "over" | "into" | "out" | "continue",
	options?: {
		exceptions?: ExceptionEvent[];
		consoleEvents?: ConsoleEvent[];
	},
): StateDelta {
	const changedVariables = computeVariableChanges(before, after);

	return {
		debug_session_id: "",
		from_location: before.location,
		to_location: after.location,
		step_kind: stepKind,
		changed_variables: changedVariables,
		branch_events: [],
		exceptions: options?.exceptions ?? [],
		console_events: options?.consoleEvents ?? [],
		interpretation: generateInterpretation(changedVariables, before.location, after.location),
	};
}

function computeVariableChanges(before: StateSnapshot, after: StateSnapshot): VariableChange[] {
	const changes: VariableChange[] = [];

	// Build maps of variable name -> value for Locals scope
	const beforeVars = new Map<string, string>();
	const afterVars = new Map<string, string>();

	for (const scope of before.scopes) {
		if (scope.name === "Locals" || scope.name === "Local") {
			for (const v of scope.variables) {
				beforeVars.set(v.name, v.value);
			}
		}
	}

	for (const scope of after.scopes) {
		if (scope.name === "Locals" || scope.name === "Local") {
			for (const v of scope.variables) {
				afterVars.set(v.name, v.value);
			}
		}
	}

	// Find changed and new variables
	for (const [name, afterValue] of afterVars) {
		const beforeValue = beforeVars.get(name);
		if (beforeValue === undefined) {
			changes.push({
				name,
				before: "<not in scope>",
				after: afterValue,
				note: "New variable",
			});
		} else if (beforeValue !== afterValue) {
			changes.push({
				name,
				before: beforeValue,
				after: afterValue,
			});
		}
	}

	// Find removed variables
	for (const [name, beforeValue] of beforeVars) {
		if (!afterVars.has(name)) {
			changes.push({
				name,
				before: beforeValue,
				after: "<out of scope>",
				note: "Variable left scope",
			});
		}
	}

	return changes;
}

function generateInterpretation(
	changes: VariableChange[],
	fromLoc: SourceLocation,
	toLoc: SourceLocation,
): string {
	const parts: string[] = [];

	if (fromLoc.file !== toLoc.file) {
		parts.push(`Moved from ${fromLoc.file}:${fromLoc.line} to ${toLoc.file}:${toLoc.line}`);
	} else if (fromLoc.line !== toLoc.line) {
		parts.push(`Advanced from line ${fromLoc.line} to line ${toLoc.line}`);
	}

	if (changes.length === 0) {
		parts.push("No variable changes");
	} else {
		const changed = changes.filter((c) => !c.note);
		const newVars = changes.filter((c) => c.note === "New variable");
		if (changed.length > 0) {
			parts.push(
				`Changed: ${changed.map((c) => `${c.name} (${c.before} -> ${c.after})`).join(", ")}`,
			);
		}
		if (newVars.length > 0) {
			parts.push(`New: ${newVars.map((c) => `${c.name} = ${c.after}`).join(", ")}`);
		}
	}

	return parts.join(". ");
}

function truncateValue(value: string): string {
	if (value.length <= MAX_VALUE_LENGTH) return value;
	return `${value.substring(0, MAX_VALUE_LENGTH)}... [truncated]`;
}
