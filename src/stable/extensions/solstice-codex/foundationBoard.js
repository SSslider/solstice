"use strict";

// Owns one panel session. Responses from a previous navigation or a disposed
// panel must never mutate the current view or its canonical revision.
class FoundationBoard {
	constructor(client, post) {
		this.client = client;
		this.post = post;
		this.generation = 0;
		this.disposed = false;
		this.slug = null;
		this.detail = null;
		this.cursor = new Date(Date.now() - 1000).toISOString();
		this.polling = false;
		this.saving = false;
		this.needsRefresh = false;
		this.pendingWrite = null;
	}
	current(generation) { return !this.disposed && generation === this.generation; }
	emit(message) { if (!this.disposed) this.post(message); }
	fail(error, generation) {
		if (this.current(generation)) this.emit({ type: "error", message: String(error && error.message || "Foundation request failed") });
	}
	back() {
		this.generation++;
		this.slug = null;
		this.detail = null;
		this.needsRefresh = false;
	}
	async refresh() {
		if (this.disposed) return;
		this.back();
		const generation = this.generation;
		try {
			const board = await this.client.listBusinesses();
			if (this.current(generation)) this.emit({ type: "state", state: { board, connectedAt: new Date().toISOString() } });
		} catch (error) { this.fail(error, generation); }
	}
	async show(slug) {
		if (this.disposed) return;
		const generation = ++this.generation;
		this.slug = String(slug || "");
		this.detail = null;
		this.needsRefresh = false;
		this.emit({ type: "detailBusy", slug: this.slug });
		try { await this.loadDetail(this.slug, generation); }
		catch (error) { this.fail(error, generation); }
	}
	async loadDetail(slug, generation) {
		const detail = await this.client.getBusinessDetail(slug);
		if (!this.current(generation)) return false;
		this.detail = detail;
		this.needsRefresh = false;
		this.emit({ type: "detail", detail, connectedAt: new Date().toISOString() });
		return true;
	}
	async poll() {
		if (this.disposed || this.polling || this.saving || !this.slug || !this.detail) return;
		this.polling = true;
		const generation = this.generation;
		const slug = this.slug;
		try {
			const response = await this.client.pollEvents(this.cursor);
			if (!this.current(generation)) return;
			const events = Array.isArray(response.events) ? response.events : [];
			const changed = events.some(event => String(event.business_id || "") === String(this.detail.business.id || ""));
			if (changed || this.needsRefresh) await this.loadDetail(slug, generation);
			if (!this.current(generation)) return;
			// Advance only after the corresponding projection was read successfully.
			if (response.cursor) this.cursor = String(response.cursor);
			this.emit({ type: "connection", connectedAt: new Date().toISOString() });
		} catch (error) {
			if (this.current(generation)) this.needsRefresh = true;
			this.fail(error, generation);
		} finally { this.polling = false; }
	}
	async addNode(slug, title, id) {
		if (this.disposed || this.saving) return;
		let generation = this.generation;
		try {
			if (slug !== this.slug || !this.detail || !this.detail.canvas) throw new Error("Open the current Foundation business before adding a node.");
			const name = String(title || "").trim();
			if (!name || name.length > 600) throw new Error("Canvas node title is invalid.");
			this.saving = true;
			generation = ++this.generation;
			this.emit({ type: "saving", saving: true });
			const current = this.detail.canvas.snapshot || { version: 4, slug, nodes: [], edges: [] };
			const nodes = (current.nodes || []).map(({ imageDataUri, ...node }) => node);
			const edges = current.edges || [];
			const node = { id, type: "Solstice · note", title: name, meta: "origin:solstice", ftype: "note", note: name, x: 80 + (nodes.length % 3) * 380, y: 80 + Math.floor(nodes.length / 3) * 340 };
			if (!this.pendingWrite || this.pendingWrite.slug !== slug || this.pendingWrite.title !== name) {
				this.pendingWrite = { slug, title: name, id, revision: this.detail.canvas.revision,
					snapshot: { ...current, version: 4, nodes: [...nodes, node], edges: nodes[0] ? [...edges, { from: nodes[0].id, to: id }] : edges, savedAt: new Date().toISOString() } };
			}
			const write = this.pendingWrite;
			await this.client.saveCanvas(slug, write.snapshot, write.revision, write.id);
			this.pendingWrite = null;
			if (!this.current(generation)) return;
			this.emit({ type: "saved", slug, title: name });
			await this.loadDetail(slug, generation);
		} catch (error) { if (error && error.statusCode === 409) this.pendingWrite = null; if (this.current(generation)) this.needsRefresh = true; this.fail(error, generation); }
		finally { this.saving = false; this.emit({ type: "saving", saving: false }); }
	}
	dispose() { this.disposed = true; this.back(); }
}
module.exports = { FoundationBoard };
