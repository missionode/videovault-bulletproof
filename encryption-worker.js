// encryption-worker.js
let writableStream = null;
let encryptionKey = null;
let writeQueue = Promise.resolve();

self.onmessage = async (e) => {
    const { type, data } = e.data;

    if (type === 'INIT') {
        try {
            const { masterKey, secureKey, fileHandle } = data;
            
            // Create its own writable stream from the transferred handle
            writableStream = await fileHandle.createWritable();
            
            // Generate Salt
            const salt = crypto.getRandomValues(new Uint8Array(16));
            
            // Derive Key (PBKDF2)
            const keyMaterial = await crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(masterKey + secureKey),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            );
            
            encryptionKey = await crypto.subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt: salt,
                    iterations: 100000,
                    hash: 'SHA-256'
                },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt']
            );
            
            // Write Header (Salt)
            await writableStream.write(salt);
            
            self.postMessage({ type: 'INIT_COMPLETE' });
        } catch (error) {
            self.postMessage({ type: 'ERROR', error: 'Worker Init Failed: ' + error.message });
        }
    } 
    else if (type === 'CHUNK') {
        // Use a queue to ensure writes happen in order
        writeQueue = writeQueue.then(async () => {
            if (!writableStream || !encryptionKey) return;
            
            try {
                const chunkData = data.chunk; // ArrayBuffer
                const iv = crypto.getRandomValues(new Uint8Array(12));
                
                const encryptedChunk = await crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv: iv },
                    encryptionKey,
                    chunkData
                );

                const typeByte = new Uint8Array([1]); 
                const len = new Uint8Array(4);
                new DataView(len.buffer).setUint32(0, encryptedChunk.byteLength, true);

                await writableStream.write(typeByte);
                await writableStream.write(iv);
                await writableStream.write(len);
                await writableStream.write(encryptedChunk);
                
                // Optional: Notify main thread of progress
                // self.postMessage({ type: 'CHUNK_PROCESSED' });
            } catch (error) {
                self.postMessage({ type: 'ERROR', error: 'Encryption/Write failed: ' + error.message });
            }
        });
    }
    else if (type === 'STOP') {
        writeQueue = writeQueue.then(async () => {
            try {
                const { duration, quality, mimeType } = data;
                
                const footerData = new TextEncoder().encode(JSON.stringify({
                    duration: duration,
                    timestamp: Date.now(),
                    quality: quality,
                    mimeType: mimeType
                }));

                const iv = crypto.getRandomValues(new Uint8Array(12));
                const encryptedFooter = await crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv: iv },
                    encryptionKey,
                    footerData
                );

                const typeByte = new Uint8Array([2]);
                const len = new Uint8Array(4);
                new DataView(len.buffer).setUint32(0, encryptedFooter.byteLength, true);

                await writableStream.write(typeByte);
                await writableStream.write(iv);
                await writableStream.write(len);
                await writableStream.write(encryptedFooter);

                await writableStream.close();
                writableStream = null;
                
                self.postMessage({ type: 'STOP_COMPLETE' });
            } catch (error) {
                self.postMessage({ type: 'ERROR', error: 'Finalize failed: ' + error.message });
            }
        });
    }
};