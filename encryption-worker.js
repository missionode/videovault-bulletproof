// encryption-worker.js
self.onmessage = async (e) => {
    const { type, data } = e.data;

    if (type === 'INIT') {
        try {
            self.masterKey = data.masterKey;
            self.secureKey = data.secureKey;
            
            // Generate Salt
            self.salt = crypto.getRandomValues(new Uint8Array(16));
            
            // Derive Key (PBKDF2) - Heavy CPU task
            const keyMaterial = await crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(self.masterKey + self.secureKey),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            );
            
            self.encryptionKey = await crypto.subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt: self.salt,
                    iterations: 100000,
                    hash: 'SHA-256'
                },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt']
            );
            
            // Send Salt back to main thread to write
            self.postMessage({ 
                type: 'INIT_COMPLETE', 
                data: { salt: self.salt } 
            }); 
        } catch (error) {
            self.postMessage({ type: 'ERROR', error: error.message });
        }
    } 
    else if (type === 'CHUNK') {
        try {
            const chunkData = data.chunk; // ArrayBuffer
            const iv = crypto.getRandomValues(new Uint8Array(12));
            
            const encryptedChunk = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                self.encryptionKey,
                chunkData
            );

            // Format: [Type(1)][IV(12)][Len(4)][Data]
            // Type 1: Video Chunk
            const typeByte = new Uint8Array([1]); 
            const len = new Uint8Array(4);
            new DataView(len.buffer).setUint32(0, encryptedChunk.byteLength, true);

            // Combine into one buffer to transfer back efficiently
            const totalLen = 1 + 12 + 4 + encryptedChunk.byteLength;
            const resultBuffer = new Uint8Array(totalLen);
            let offset = 0;
            
            resultBuffer.set(typeByte, offset); offset += 1;
            resultBuffer.set(iv, offset); offset += 12;
            resultBuffer.set(len, offset); offset += 4;
            resultBuffer.set(new Uint8Array(encryptedChunk), offset);
            
            // Transfer the result buffer back
            self.postMessage({ 
                type: 'ENCRYPTED_CHUNK', 
                data: resultBuffer.buffer 
            }, [resultBuffer.buffer]);
            
        } catch (error) {
            self.postMessage({ type: 'ERROR', error: 'Encryption failed: ' + error.message });
        }
    }
    else if (type === 'STOP') {
        try {
            const { duration, quality, mimeType } = data;
            
            // Create Footer Data
            const footerData = new TextEncoder().encode(JSON.stringify({
                duration: duration,
                timestamp: Date.now(),
                quality: quality,
                mimeType: mimeType
            }));

            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encryptedFooter = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                self.encryptionKey,
                footerData
            );

            const typeByte = new Uint8Array([2]); // Type 2: Footer
            const len = new Uint8Array(4);
            new DataView(len.buffer).setUint32(0, encryptedFooter.byteLength, true);

            // Combine
            const totalLen = 1 + 12 + 4 + encryptedFooter.byteLength;
            const resultBuffer = new Uint8Array(totalLen);
            let offset = 0;
            
            resultBuffer.set(typeByte, offset); offset += 1;
            resultBuffer.set(iv, offset); offset += 12;
            resultBuffer.set(len, offset); offset += 4;
            resultBuffer.set(new Uint8Array(encryptedFooter), offset);

            self.postMessage({ 
                type: 'STOP_COMPLETE',
                data: resultBuffer.buffer
            }, [resultBuffer.buffer]);
            
        } catch (error) {
            self.postMessage({ type: 'ERROR', error: 'Finalize failed: ' + error.message });
        }
    }
};