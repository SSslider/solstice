"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const LEARNING_MODE = "shadow";
const DRAFT_SCHEMA_VERSION = "1.0";
const DRAFT_STATUSES = new Set(["DRAFT", "APPROVED", "REJECTED"]);
const HIERARCHY_LEVELS = new Set(["principle", "capability", "vertical", "client"]);
const EXTERNAL_SIGNAL_TYPES = new Set([
	"browser-functional-check",
	"ci-test-suite",
	"visual-critic",
	"owner-approved",
	"production-metric",
]);

// R4 follows Whetstone Layer-2's principle-card shape without copying its
// domain scars: claim + mechanism + applies_when + first-class does_not_apply
// + transfer_probe + origin. Unlike the 19 converted advisory cards, Felix's
// candidates remain local DRAFT records until an operator approves activation.

function cleanText(value, max = 1200) {
	return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function slug(value) {
	return cleanText(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "general";
}

function stableHash(value) {
	return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertExternalSignal(signal) {
	if (!signal || signal.verified !== true || !EXTERNAL_SIGNAL_TYPES.has(signal.type)) {
		throw new Error("A verified external success signal is required before Felix may write a learning draft");
	}
	if (!cleanText(signal.evidence, 2000)) throw new Error("External success signal needs durable evidence");
	if (!/^[a-f0-9]{64}$/i.test(String(signal.sha256 || ""))) throw new Error("External success evidence needs a SHA-256");
	return {
		type: signal.type,
		verified: true,
		verified_by: cleanText(signal.verified_by || "machine-gate", 120),
		evidence: cleanText(signal.evidence, 2000),
		sha256: String(signal.sha256).toLowerCase(),
		observed_at: cleanText(signal.observed_at || new Date().toISOString(), 80),
		summary: signal.summary && typeof signal.summary === "object" ? signal.summary : {},
	};
}

function normalizeDraft(candidate) {
	const level = cleanText(candidate.level, 40).toLowerCase();
	if (!HIERARCHY_LEVELS.has(level)) throw new Error("Learning draft has an invalid hierarchy level");
	const doesNotApply = Array.isArray(candidate.does_not_apply) ? candidate.does_not_apply.map((x) => cleanText(x, 500)).filter(Boolean) : [];
	if (!doesNotApply.length) throw new Error("does_not_apply is required and must contain a measurable boundary");
	const appliesWhen = Array.isArray(candidate.applies_when) ? candidate.applies_when.map((x) => cleanText(x, 500)).filter(Boolean) : [];
	if (!appliesWhen.length) throw new Error("applies_when is required");
	const signal = assertExternalSignal(candidate.success_signal);
	const identity = {
		level,
		name: slug(candidate.name),
		claim: cleanText(candidate.claim),
		mechanism: cleanText(candidate.mechanism),
		signal: signal.sha256,
	};
	if (!identity.claim || !identity.mechanism) throw new Error("Learning draft needs claim and mechanism");
	return {
		schema_version: DRAFT_SCHEMA_VERSION,
		id: `DRAFT-${level}-${stableHash(identity).slice(0, 12)}`,
		status: "DRAFT",
		mode: LEARNING_MODE,
		level,
		name: identity.name,
		title: cleanText(candidate.title || candidate.name, 180),
		hierarchy: {
			principle: cleanText(candidate.hierarchy && candidate.hierarchy.principle, 120),
			capability: cleanText(candidate.hierarchy && candidate.hierarchy.capability, 120),
			vertical: cleanText(candidate.hierarchy && candidate.hierarchy.vertical, 120),
			client: cleanText(candidate.hierarchy && candidate.hierarchy.client, 120),
		},
		claim: identity.claim,
		mechanism: identity.mechanism,
		applies_when: appliesWhen,
		does_not_apply: doesNotApply,
		transfer_probe: Array.isArray(candidate.transfer_probe) ? candidate.transfer_probe.map((x) => cleanText(x, 500)).filter(Boolean) : [],
		success_signal: signal,
		origin: candidate.origin && typeof candidate.origin === "object" ? candidate.origin : {},
		created_at: cleanText(candidate.created_at || new Date().toISOString(), 80),
		updated_at: cleanText(candidate.updated_at || new Date().toISOString(), 80),
	};
}

function atomicJson(file, document) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
	fs.writeFileSync(temp, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
	fs.renameSync(temp, file);
}

function renderApprovedSkill(draft) {
	return [
		`# ${draft.title || draft.name}`,
		"",
		`Hierarchy: ${draft.level} · principle=${draft.hierarchy.principle || "—"} · capability=${draft.hierarchy.capability || "—"} · vertical=${draft.hierarchy.vertical || "—"} · client=${draft.hierarchy.client || "—"}`,
		"",
		"## Claim",
		draft.claim,
		"",
		"## Mechanism",
		draft.mechanism,
		"",
		"## Applies when",
		...draft.applies_when.map((item) => `- ${item}`),
		"",
		"## Does not apply",
		...draft.does_not_apply.map((item) => `- ${item}`),
		"",
		"## Transfer probes",
		...(draft.transfer_probe.length ? draft.transfer_probe.map((item) => `- ${item}`) : ["- No cross-domain transfer until another external signal is recorded."]),
		"",
		"## Success signal",
		`- type: ${draft.success_signal.type}`,
		`- evidence: ${draft.success_signal.evidence}`,
		`- sha256: ${draft.success_signal.sha256}`,
		`- verified_by: ${draft.success_signal.verified_by}`,
		"",
	].join("\n");
}

function inferLearningShape(task, tags = [], buildMode = "site") {
	const lowered = cleanText(task, 4000).toLowerCase();
	const set = new Set((tags || []).map((tag) => slug(tag)));
	const verticalOrder = ["dental", "medical", "fitness", "legal", "barber", "restaurant", "ecommerce"];
	const vertical = verticalOrder.find((tag) => set.has(tag) || lowered.includes(tag)) || "";
	const capabilityOrder = ["animation", "ecommerce", "auth", "dashboard", "crm", "landing"];
	const scrollScrub = /(?:scroll[ -]?world|scroll[ -]?scrub|scrollytelling|סקול וורלד|סקרול)/i.test(lowered);
	const capability = scrollScrub ? "scroll-scrub" : capabilityOrder.find((tag) => set.has(tag) || lowered.includes(tag)) || (buildMode === "app" ? "business-app" : "website-composition");
	return { capability, vertical };
}

class FelixLearning {
	constructor(options = {}) {
		this.dir = options.dir;
		this.draftsDir = path.join(this.dir, "shadow-drafts");
		this.log = options.log || (() => { });
		fs.mkdirSync(this.draftsDir, { recursive: true });
	}

	listDrafts() {
		let files = [];
		try { files = fs.readdirSync(this.draftsDir).filter((file) => file.endsWith(".json")).sort(); } catch { }
		return files.map((file) => {
			try {
				const document = JSON.parse(fs.readFileSync(path.join(this.draftsDir, file), "utf8"));
				return DRAFT_STATUSES.has(document.status) && document.mode === LEARNING_MODE ? document : null;
			} catch { return null; }
		}).filter(Boolean);
	}

	getDraft(id) { return this.listDrafts().find((draft) => draft.id === id) || null; }

	writeDraft(candidate) {
		const draft = normalizeDraft(candidate);
		const file = path.join(this.draftsDir, `${draft.id}.json`);
		if (fs.existsSync(file)) return { draft: JSON.parse(fs.readFileSync(file, "utf8")), file, created: false };
		atomicJson(file, draft);
		this.log(`[learning-shadow] drafted ${draft.id}; never injected until human approval`);
		return { draft, file, created: true };
	}

	proposeFromBuild(build, signal) {
		const verified = assertExternalSignal(signal);
		const task = cleanText(build && build.task, 4000);
		if (!task) throw new Error("Learning draft needs the source build task");
		const tags = Array.isArray(build.tags) ? build.tags : [];
		const shape = inferLearningShape(task, tags, build.buildMode);
		const client = slug(build && build.client || "");
		const origin = {
			architecture: "principle-first-layer-2",
			task_id: cleanText(build.taskId, 160),
			provider: cleanText(build.provider, 120),
			source_task_sha256: stableHash(task),
			preview: cleanText(build.preview, 500),
		};
		const capability = this.writeDraft({
			level: "capability",
			name: `capability-${shape.capability}`,
			title: `Capability · ${shape.capability}`,
			hierarchy: { principle: "externally-verified-outcomes", capability: shape.capability },
			claim: `Reuse the verified ${shape.capability} execution pattern only when the new task has the same capability shape and its own acceptance gate.`,
			mechanism: `The source build passed an external ${verified.type} gate. Keeping the reusable mechanism capability-bound prevents project names and vertical-specific assumptions from leaking into unrelated work.`,
			applies_when: [`The task requires ${shape.capability}`, `The same external gate can fail the new result`],
			does_not_apply: [`The task does not require ${shape.capability}`, "The new project lacks an external success gate", "A vertical or client constraint conflicts with this capability pattern"],
			transfer_probe: shape.vertical ? [`Apply the capability to a different ${shape.vertical} project, then rerun the same gate`] : ["Apply to a second domain, then rerun the same gate"],
			success_signal: verified,
			origin,
		});
		const drafts = [capability];
		if (shape.vertical) {
			drafts.push(this.writeDraft({
				level: "vertical",
				name: `vertical-${shape.vertical}-${shape.capability}`,
				title: `${shape.vertical} · ${shape.capability}`,
				hierarchy: { principle: "externally-verified-outcomes", capability: shape.capability, vertical: shape.vertical },
				claim: `Within ${shape.vertical}, the verified ${shape.capability} pattern is a candidate default only under the recorded constraints.`,
				mechanism: "Vertical context changes content, trust signals and interaction priorities; isolating it below the capability layer blocks negative transfer to other industries.",
				applies_when: [`The project vertical is ${shape.vertical}`, `The task requires ${shape.capability}`],
				does_not_apply: [`The project vertical is not ${shape.vertical}`, "The task has conflicting brand or regulatory constraints", "No equivalent external success signal can be measured"],
				transfer_probe: [`Test on a second ${shape.vertical} project without copying client identity or copy`],
				success_signal: verified,
				origin,
			}));
		}
		if (client && client !== "general") {
			drafts.push(this.writeDraft({
				level: "client",
				name: `client-${client}-${shape.capability}`,
				title: `${client} · ${shape.capability}`,
				hierarchy: { principle: "externally-verified-outcomes", capability: shape.capability, vertical: shape.vertical, client },
				claim: `For ${client}, the verified ${shape.capability} pattern is a client-local candidate bound to the recorded brand, content and acceptance evidence.`,
				mechanism: "Client-local learning preserves identity and preference details at the narrowest hierarchy level instead of contaminating the capability or vertical default.",
				applies_when: [`The active project is ${client}`, `The task requires ${shape.capability}`, "The recorded client constraints still match"],
				does_not_apply: [`The active project is not ${client}`, "The client changed the brand, offer or acceptance target", "No equivalent external success signal can be measured"],
				transfer_probe: [`Rerun the same external gate on the next ${client} task before retaining the client-local pattern`],
				success_signal: verified,
				origin,
			}));
		}
		const principle = this.proposeCrossDomainPrinciple(shape.capability);
		if (principle) drafts.push(principle);
		return drafts;
	}

	proposeCrossDomainPrinciple(capability) {
		const source = this.listDrafts().filter((draft) => draft.status === "DRAFT" && draft.level === "vertical" && draft.hierarchy.capability === capability);
		const verticals = [...new Set(source.map((draft) => draft.hierarchy.vertical).filter(Boolean))];
		if (verticals.length < 2) return null;
		const evidence = source.slice(0, 4);
		const combinedSha = stableHash(evidence.map((draft) => draft.success_signal.sha256));
		return this.writeDraft({
			level: "principle",
			name: `principle-${capability}-external-gate`,
			title: `Principle · ${capability} needs an external gate`,
			hierarchy: { principle: `${capability}-external-gate` },
			claim: `Promote a ${capability} pattern across domains only after independent external success in at least two verticals.`,
			mechanism: "Cross-domain evidence separates a transferable mechanism from a single project's accidental details; the negative boundary remains explicit through does_not_apply.",
			applies_when: [`At least two distinct verticals passed independent external gates for ${capability}`],
			does_not_apply: ["Only one vertical has verified evidence", "The successful behavior depends on client identity or content", "The target cannot run an equivalent external gate"],
			transfer_probe: [`Run ${capability} in a third vertical and compare the same machine-gated outcome`],
			success_signal: {
				type: "ci-test-suite", verified: true, verified_by: "felix-shadow-cross-domain-gate",
				evidence: evidence.map((draft) => draft.success_signal.evidence).join(" | "), sha256: combinedSha,
				observed_at: new Date().toISOString(), summary: { verticals },
			},
			origin: { source_drafts: evidence.map((draft) => draft.id) },
		});
	}

	approve(id, skills, approver = "operator") {
		const draft = this.getDraft(id);
		if (!draft || draft.status !== "DRAFT") throw new Error("Learning draft is missing or no longer pending");
		if (!skills || typeof skills.learn !== "function") throw new Error("Felix active skill store is unavailable");
		const activated = skills.learn({
			name: draft.name,
			tags: [draft.level, draft.hierarchy.capability, draft.hierarchy.vertical].filter(Boolean),
			sector: draft.hierarchy.vertical || "",
			body: renderApprovedSkill(draft),
			provenance: `${draft.id}:${draft.success_signal.sha256.slice(0, 12)}`,
		});
		draft.status = "APPROVED";
		draft.updated_at = new Date().toISOString();
		draft.approval = { approved_by: cleanText(approver, 120), approved_at: draft.updated_at, active_file: activated.file, active_version: activated.version };
		atomicJson(path.join(this.draftsDir, `${draft.id}.json`), draft);
		return { draft, activated };
	}

	reject(id, reason = "Rejected by operator") {
		const draft = this.getDraft(id);
		if (!draft || draft.status !== "DRAFT") throw new Error("Learning draft is missing or no longer pending");
		draft.status = "REJECTED";
		draft.updated_at = new Date().toISOString();
		draft.rejection = { reason: cleanText(reason, 500), rejected_at: draft.updated_at };
		atomicJson(path.join(this.draftsDir, `${draft.id}.json`), draft);
		return draft;
	}
}

module.exports = {
	DRAFT_SCHEMA_VERSION,
	EXTERNAL_SIGNAL_TYPES,
	FelixLearning,
	LEARNING_MODE,
	assertExternalSignal,
	inferLearningShape,
	normalizeDraft,
	renderApprovedSkill,
};
