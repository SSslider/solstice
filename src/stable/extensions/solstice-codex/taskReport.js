"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

// Saved objectives and filenames are user content, never Markdown or commands.
const text = value => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ")
	.replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&");

function taskReport(journal, id) {
	// Read the durable record again, even while its controller is still alive.
	const task = journal.read(id);
	const evidence = task.evidence.map(saved => {
		const current = journal.evidence(saved.path);
		return { ...saved, current: !current ? "missing" : current.sha256 === saved.sha256 ? "unchanged" : "changed" };
	});
	const lines = ["# Felix — Task evidence", "", text(task.objective), "",
		`Task: ${text(task.id)}`, `Saved state: **${text(task.status)}**`,
		`Saved at: ${text(task.updatedAt)}`, `Files checked at: ${new Date().toISOString()}`, "",
		"This is a snapshot. Open the command again to refresh.",
		"A finished model turn is awaiting review; it does not prove acceptance, publication or installation.", "",
		"## Plan", "", ...task.plan.map(step => `- ${text(step.status)} — ${text(step.step)}`)];
	if (!task.plan.length) lines.push("No plan recorded.");
	lines.push("", "## Unresolved actions", "");
	lines.push(...task.pending.map(item => `- ${text(item.type)} · ${text(item.id)} — outcome unknown; reconcile before retry.`));
	if (!task.pending.length) lines.push("No unresolved actions recorded. This is not an acceptance result.");
	lines.push("", "## User updates", "");
	lines.push(...(task.steering || []).map(update => `- **${text(update.state)}** — ${text(update.text)}`));
	if (!(task.steering || []).length) lines.push("No user updates recorded.");
	lines.push("", "## File evidence", "");
	for (const item of evidence) {
		// Link only a file whose contents still match the saved evidence. The
		// journal's evidence() also rejects secret paths and escaping symlinks.
		const label = text(item.path);
		const link = item.current === "unchanged"
			? `[${label}](<${pathToFileURL(path.resolve(journal.root, item.path)).href}>)` : label;
		lines.push(`- ${link} — **${item.current}** · saved SHA-256: ${text(item.sha256)}`);
	}
	if (!evidence.length) lines.push("No file evidence recorded.");
	lines.push("", "## Recorded events", "");
	for (const event of task.events) {
		// Heartbeats only prove connectivity. Raw provider output and arguments
		// have no place in this report; expose only known outcome fields.
		if (event.type === "heartbeat") continue;
		const outcome = [event.tool, event.itemId, event.status,
			Number.isInteger(event.exitCode) ? `exit ${event.exitCode}` : ""].filter(Boolean).map(text).join(" · ");
		lines.push(`- ${text(event.at)} · **${text(event.type)}**${outcome ? " · " + outcome : ""}`);
	}
	return lines.join("\n") + "\n";
}

module.exports = { taskReport };
