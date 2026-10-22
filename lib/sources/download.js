// The book sources' downloads - fetch with a user-presentable network error, and read a response body with progress


// fetch, throwing a user-presentable error (errorMessage) if the network fails
export async function fetchResponse(url, options, errorMessage) {
    try {
        return await fetch(url, options);
    } catch {
        throw new Error(errorMessage);
    }
}


// Read a response body, reporting progress - onProgress(loadedBytes, totalBytes or null); returns a Uint8Array, and a
// failed read throws errorMessage. The total is the Content-Length, unless the caller knows it's not the body's size
// (isLengthKnown false), and becomes unknown if more bytes arrive (a compressed response's Content-Length).
export async function readBody(response, onProgress, errorMessage, isLengthKnown = true) {
    let total = isLengthKnown ? (Number(response.headers.get('Content-Length')) || null) : null;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    onProgress(0, total);
    for (;;) {
        let result;
        try {
            result = await reader.read();
        } catch {
            throw new Error(errorMessage);
        }
        if (result.done) {
            break;
        }
        chunks.push(result.value);
        loaded += result.value.length;
        if (total !== null && loaded > total) {
            total = null;
        }
        onProgress(loaded, total);
    }

    // Done - the total is what was read
    if (loaded !== total) {
        onProgress(loaded, loaded);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
