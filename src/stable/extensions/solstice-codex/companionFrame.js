"use strict";

// Matches the receiver's 64 KiB limit. Budget the complete serialized envelope.
const MAX_FRAME_BYTES = 64 * 1024;
const LISTS = ["plan", "events", "evidence", "pending"];
const frameBytes = frame => Buffer.byteLength(JSON.stringify(frame), "utf8");

function companionFrame(instanceId, state) {
	const source = state.taskEvidence;
	const snapshot = source ? { ...source } : source;
	if (snapshot && !snapshot.error) {
		for (const key of LISTS) snapshot[key] = [...(source[key] || [])];
		snapshot.truncated = LISTS.some(key => snapshot[key + "Omitted"] > 0);
	}
	const frame = { type: "companion_state", instanceId, state: { ...state, taskEvidence: snapshot } };
	if (snapshot && !snapshot.error) {
		// Retain a representative item from every nonempty list until fallback.
		// Events retain the newest items; the other lists retain their first items.
		for (const key of LISTS) {
			while (snapshot[key].length > 1 && frameBytes(frame) > MAX_FRAME_BYTES) {
				if (key === "events") snapshot[key].shift(); else snapshot[key].pop();
				snapshot[key + "Omitted"] = (snapshot[key + "Omitted"] || 0) + 1;
				snapshot.truncated = true;
			}
		}
	}
	if (frameBytes(frame) <= MAX_FRAME_BYTES) return frame;

	// Other companion data (e.g. a preview image) can consume the entire budget.
	// Explicitly declare every omitted field; never send an apparently complete view.
	let minimal = snapshot;
	if (snapshot && !snapshot.error) {
		minimal = { id: snapshot.id, status: snapshot.status, checkedAt: snapshot.checkedAt,
			caveat: snapshot.caveat, pendingCaveat: snapshot.pendingCaveat,
			turn: snapshot.turn, updatedAt: snapshot.updatedAt, failure: snapshot.failure,
			truncated: true, fieldsOmitted: Object.keys(snapshot).filter(key =>
				!["id", "status", "checkedAt", "caveat", "pendingCaveat", "turn", "updatedAt", "failure", "truncated"].includes(key) &&
				!LISTS.includes(key) && !LISTS.some(list => key === list + "Omitted")) };
		for (const key of LISTS) {
			minimal[key] = [];
			minimal[key + "Omitted"] = snapshot[key].length + (snapshot[key + "Omitted"] || 0);
		}
	}
	frame.state = { connected: state.connected, taskEvidence: minimal, truncated: true,
		relayOmittedFields: Object.keys(state).filter(key => !["connected", "taskEvidence"].includes(key)) };
	// Required metadata cannot be silently shortened. Report an explicit send failure.
	if (frameBytes(frame) > MAX_FRAME_BYTES) throw new Error("Required companion metadata exceeds the frame byte budget");
	return frame;
}

module.exports = { companionFrame, frameBytes, MAX_FRAME_BYTES };
