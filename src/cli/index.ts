#!/usr/bin/env bun
import { Command } from "commander";
import { isTelemetryEnabled, shutdownTelemetry } from "../telemetry/otel.js";
import { registerActionsCommand } from "./actions.js";
import { registerAdvisoriesCommand } from "./advisories.js";
import { registerApplyCommand } from "./apply.js";
import { registerAutofixCommand } from "./autofix.js";
import { registerBundleCommand } from "./bundle.js";
import { registerCanaryCommand } from "./canary.js";
import { registerCapabilityDriftCommand } from "./capability-drift.js";
import { registerCiCommand } from "./ci.js";
import { registerConfigCommand, registerInitCommand } from "./config.js";
import { registerCrossExamCommand } from "./cross-exam.js";
import { registerDebugCommand } from "./debug.js";
import { registerDiagnoseCommand } from "./diagnose.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerDriftCommand } from "./drift.js";
import { registerDumpCommand } from "./dump.js";
import { registerExplainCommand } from "./explain.js";
import { registerHistoryCommand } from "./history.js";
import { registerHypothesesCommand } from "./hypotheses.js";
import { registerIncidentsCommand } from "./incidents.js";
import { registerInspectCommand } from "./inspect.js";
import { registerIntentCommand } from "./intent.js";
import { registerKbCommand } from "./kb.js";
import { registerMemoryRetrievalCommand } from "./memory-retrieval.js";
import { registerMemoryCommand } from "./memory.js";
import { registerOperatorAdjudicationCommand } from "./operator-adjudication.js";
import { registerOrchestrationCommand } from "./orchestration.js";
import { registerPrivacySharingCommand } from "./privacy-sharing.js";
import { registerRemediateCommand } from "./remediate.js";
import { registerReplayValidationCommand } from "./replay-validation.js";
import { registerReproCommand } from "./repro.js";
import { registerResolveCommand } from "./resolve.js";
import { registerRulesCommand } from "./rules.js";
import { registerRunCommand } from "./run.js";
import { registerStepCommand } from "./step.js";
import { registerStreamingIncidentCommand } from "./streaming-incident.js";
import { registerTimelineCommand } from "./timeline.js";
import { registerTraceGapsCommand } from "./trace-gaps.js";
import { registerTraceCommand } from "./trace.js";
import { registerVerifyCommand } from "./verify.js";
import { registerWatchCommand } from "./watch.js";

const program = new Command()
	.name("failsafe")
	.description("Agent-first debugging CLI — failure context compressor for coding agents")
	.version("0.1.0");

// Phase 0: Core commands
registerRunCommand(program);
registerDiagnoseCommand(program);
registerInitCommand(program);
registerConfigCommand(program);
registerDoctorCommand(program);
registerHistoryCommand(program);
registerCiCommand(program);

// Phase 1: Repro
registerReproCommand(program);
registerReplayValidationCommand(program);

// Phase 2: Debug
registerDebugCommand(program);
registerStepCommand(program);
registerInspectCommand(program);
registerVerifyCommand(program);
registerExplainCommand(program);
registerDumpCommand(program);
registerAdvisoriesCommand(program);
registerApplyCommand(program);
registerAutofixCommand(program);
registerRemediateCommand(program);
registerOperatorAdjudicationCommand(program);
registerWatchCommand(program);

// Phase 3: Tiered Rules
registerResolveCommand(program);
registerRulesCommand(program);
registerKbCommand(program);

// Phase 4: Project-context memory (item 36)
registerMemoryCommand(program);

// Phase 5: Hierarchical hypothesis validation (item 43) and design intent (item 46)
registerHypothesesCommand(program);
registerIntentCommand(program);
registerTimelineCommand(program);
registerBundleCommand(program);
registerCanaryCommand(program);
registerDriftCommand(program);
registerActionsCommand(program);
registerTraceGapsCommand(program);
registerCrossExamCommand(program);
registerTraceCommand(program);
registerIncidentsCommand(program);
registerOrchestrationCommand(program);
registerPrivacySharingCommand(program);
registerMemoryRetrievalCommand(program);
registerStreamingIncidentCommand(program);
registerCapabilityDriftCommand(program);

// Use parseAsync so async actions complete before we flush telemetry.
await program.parseAsync();
if (isTelemetryEnabled()) {
	await shutdownTelemetry();
	// The OTLP exporter can leave sockets/timers pending; force a prompt exit.
	// Reaching here means a success path (error paths call process.exit earlier).
	process.exit(process.exitCode ?? 0);
}
