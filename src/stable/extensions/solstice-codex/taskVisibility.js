"use strict";

const clean = value => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);

// Only outcome metadata crosses the relay, never commands, arguments or file contents.
function taskSnapshot(journal, id) {
	const task = journal.read(id);
	const events = task.events.filter(e => e.type !== "heartbeat");
	return {
		id: task.id, turn: task.turns, objective: clean(task.objective), status: clean(task.status),
		updatedAt: task.updatedAt, checkedAt: new Date().toISOString(),
		caveat: "A finished turn is awaiting review; it does not prove acceptance, publication or installation.",
		pendingOmitted: Math.max(0, task.pending.length - 100),
		planOmitted: Math.max(0, task.plan.length - 100),
		evidenceOmitted: Math.max(0, task.evidence.length - 100),
		eventsOmitted: Math.max(0, events.length - 12),
		pending: task.pending.slice(0, 100).map(p => ({ id: clean(p.id), type: clean(p.type) })),
		pendingCaveat: "No unresolved actions is not an acceptance result.",
		failure: task.failure ? "Provider interrupted; inspect the engine log before continuing." : "",
		plan: task.plan.slice(0, 100).map(p => ({ step: clean(p.step), status: clean(p.status) })),
		evidence: task.evidence.slice(0, 100).map(saved => {
			const current = journal.evidence(saved.path);
			return { path: clean(saved.path), sha256: clean(saved.sha256),
				current: !current ? "missing" : current.sha256 === saved.sha256 ? "unchanged" : "changed" };
		}),
		events: events.slice(-12).map(e => ({
			at: clean(e.at), type: clean(e.type), status: clean(e.status), tool: clean(e.tool),
			exitCode: Number.isInteger(e.exitCode) ? e.exitCode : null,
		})),
	};
}

module.exports = { taskSnapshot };
