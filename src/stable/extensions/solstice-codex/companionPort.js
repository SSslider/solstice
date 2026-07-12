"use strict";

// Bind the local diagnostic Companion server without making a second Solstice
// window silently lose Companion. Each window tries the preferred port first,
// then the small reserved range. The server remains loopback-only.
async function listenOnFirstAvailable(server, ports, host = "127.0.0.1") {
	let lastError = null;
	for (const port of ports) {
		const result = await new Promise((resolve) => {
			const onError = (error) => { cleanup(); resolve({ error }); };
			const onListening = () => { cleanup(); resolve({ port }); };
			const cleanup = () => {
				server.removeListener("error", onError);
				server.removeListener("listening", onListening);
			};
			server.once("error", onError);
			server.once("listening", onListening);
			try { server.listen(port, host); } catch (error) { onError(error); }
		});
		if (result.port) return result.port;
		lastError = result.error;
		if (!lastError || lastError.code !== "EADDRINUSE") throw lastError;
	}
	const error = new Error(`No Companion diagnostic port available (${ports[0]}-${ports[ports.length - 1]})`);
	error.code = "EADDRINUSE";
	error.cause = lastError;
	throw error;
}

module.exports = { listenOnFirstAvailable };
